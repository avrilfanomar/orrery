// One dogfood run (ADR 0003): sync the model, measure, record, report. Every
// write goes through the public API — in-process or to a running dogfood
// server — so `decide` judges the dogfood exactly as it judges anyone else.
import { PASS_FAIL_UNIT, type CommandInput, type TimelineEntry, type UniverseView } from '@orrery/core';
import type { FastifyInstance } from 'fastify';
import type { GitSnapshot } from './collectors.js';
import { DOGFOOD_MODEL, type ModelNode } from './model.js';
import { PROBES, type Probe, type ProbeContext, type ProbeOutcome } from './probes.js';
import { currentFromView, planSync, resolveReasons, type PlannedChange } from './sync.js';

export interface Transport {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown, actor?: string): Promise<T>;
}

const fail = (what: string, status: number, body: unknown) => new Error(`${what}: ${status} ${(body as { error?: string } | null)?.error ?? ''}`.trim());

export function injectTransport(app: FastifyInstance): Transport {
  const call = async <T>(method: 'GET' | 'POST', url: string, body?: unknown, actor?: string): Promise<T> => {
    const res = await app.inject({ method, url, payload: body as object | undefined, headers: actor ? { 'x-actor': actor } : {} });
    const json = res.json();
    if (res.statusCode >= 300) throw fail(`${method} ${url}`, res.statusCode, json);
    return json as T;
  };
  return { get: (p) => call('GET', p), post: (p, b, a) => call('POST', p, b, a) };
}

export function httpTransport(base: string): Transport {
  const call = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base}${url}`, init);
    const json = await res.json().catch(() => null);
    if (!res.ok) throw fail(`${init?.method ?? 'GET'} ${url}`, res.status, json);
    return json as T;
  };
  return {
    get: (p) => call(p),
    post: (p, b, actor) => call(p, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json', ...(actor ? { 'x-actor': actor } : {}) } }),
  };
}

export interface ProbeResult {
  node: ModelNode;
  probe: Probe;
  outcome: ProbeOutcome;
  ms: number;
}

export interface RunOptions {
  /** Explains every model change that needs a reason; wins over the probe's `since` and the commit subject. */
  reason?: string | null;
  dryRun?: boolean;
  allowDirty?: boolean;
  /** Measure only these nodes or probes. */
  only?: readonly string[];
}

export interface RunDeps {
  transport: Transport;
  git: GitSnapshot;
  context: ProbeContext;
  probes?: readonly Probe[];
  model?: readonly ModelNode[];
  /** Separates machines whose timings must not be compared, e.g. `local` or `ci`. */
  env?: string;
  clock?: () => Date;
  progress?: (line: string) => void;
}

export interface RunResult {
  model: readonly ModelNode[];
  plan: PlannedChange[];
  applied: number;
  results: ProbeResult[];
  source: string;
  observedAt: string;
  recorded: number;
  /** Why nothing was written, when nothing was. */
  notWritten: string | null;
  view: UniverseView;
}

const ENV_LABEL = /^[a-z0-9-]{1,16}$/;

export async function runDogfood(opts: RunOptions, deps: RunDeps): Promise<RunResult> {
  const { transport: api, git, context } = deps;
  const probes = deps.probes ?? PROBES;
  const model = deps.model ?? DOGFOOD_MODEL;
  const env = deps.env ?? 'local';
  if (!ENV_LABEL.test(env)) throw new Error(`ORRERY_PROBE_ENV must be 1–16 lowercase letters, digits or dashes (got “${env}”)`);
  const clock = deps.clock ?? (() => new Date());
  const progress = deps.progress ?? (() => {});
  const source = `probe:${env}@${git.sha}${git.dirty ? '+dirty' : ''}`;
  const actor = git.userName ?? 'dogfood';
  const notWritten = opts.dryRun ? 'dry run' : git.dirty && !opts.allowDirty ? 'the working tree has uncommitted changes — commit first, or pass --allow-dirty' : null;

  const before = await api.get<UniverseView>('/api/universe');
  if (before.rootIds.includes('larch-store')) throw new Error('That server is serving the Larch Store demo, not the dogfood universe');

  // Sync before measuring: readings then fall after any new definition takes
  // effect, so a probe's first reading under a new version is judged by it.
  const plan = planSync(model, currentFromView(before), new Map(probes.map((p) => [p.id, p])));
  let applied = 0;
  if (!notWritten) {
    // model.ts wins, but a commit subject only explains what changed in the model. If the log was
    // edited after that commit (in the console, say), the plan would revert those edits under an
    // unrelated message — so the author must say why, or carry the edits into model.ts.
    let fallback = git.modelReason;
    let note: string | undefined;
    if (fallback && plan.some((p) => p.needsReason && !p.defaultReason)) {
      const [latest] = await api.get<TimelineEntry[]>('/api/changes?limit=1');
      if (latest && (!git.modelCommittedAt || Date.parse(latest.at) > Date.parse(git.modelCommittedAt))) {
        fallback = null;
        note = `the log was changed after the model’s last commit (${latest.actor}: ${latest.summary}) — carry that change into model.ts, or pass --reason "…" to revert it`;
      }
    }
    const commands: CommandInput[] = resolveReasons(plan, { explicit: opts.reason, fallback, note });
    for (const cmd of commands) {
      await api.post('/api/commands', cmd, actor);
      applied++;
    }
  }

  const byId = new Map(probes.map((p) => [p.id, p]));
  const wanted = model.filter((n) => n.probe && (!opts.only?.length || opts.only.includes(n.id) || opts.only.includes(n.probe)));
  // Timing benchmarks last, so nothing else competes with them for the CPU.
  const ordered = [...wanted.filter((n) => !byId.get(n.probe!)?.timing), ...wanted.filter((n) => byId.get(n.probe!)?.timing)];
  const observedAt = clock().toISOString();
  const results: ProbeResult[] = [];
  for (const node of ordered) {
    const probe = byId.get(node.probe!);
    if (!probe) throw new Error(`model: “${node.id}” names probe “${node.probe}”, which is not in the registry`);
    const started = performance.now();
    let outcome: ProbeOutcome;
    try {
      outcome = sanitize(await probe.measure(context), node);
    } catch (err) {
      outcome = { skipped: `the probe crashed: ${(err as Error).message}` };
    }
    const ms = performance.now() - started;
    progress(`  ${probe.id.padEnd(24)} ${'value' in outcome ? outcome.value : `skipped — ${outcome.skipped}`}  (${(ms / 1000).toFixed(1)} s)`);
    results.push({ node, probe, outcome, ms });
  }

  const readings = results.flatMap((r) => ('value' in r.outcome ? [{ nodeId: r.node.id, value: r.outcome.value, observedAt, source }] : []));
  let recorded = 0;
  if (!notWritten && readings.length) recorded = (await api.post<{ accepted: number }>('/api/readings', { readings })).accepted;

  const view = notWritten ? before : await api.get<UniverseView>('/api/universe');
  return { model, plan, applied, results, source, observedAt, recorded, notWritten, view };
}

/** The webhook is all-or-nothing, so one malformed value must not cost the whole run its readings. */
function sanitize(outcome: ProbeOutcome, node: ModelNode): ProbeOutcome {
  if (!('value' in outcome)) return outcome;
  if (!Number.isFinite(outcome.value)) return { skipped: `the probe returned ${outcome.value}` };
  if (node.measure?.unit === PASS_FAIL_UNIT && outcome.value !== 0 && outcome.value !== 1) return { skipped: `the probe returned ${outcome.value} for a pass/fail check` };
  return outcome;
}
