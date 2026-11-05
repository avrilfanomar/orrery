// The terminal report: the model's tree with each node's rolled-up status,
// this run's value beside every measured node, and what was (not) recorded.
import { formatValue, judge, STATUS_LABELS, type Status } from '@ru/core';
import type { ModelNode } from './model.js';
import type { RunResult } from './runner.js';

const COLOURS: Record<Status, number> = { ok: 32, warn: 33, breach: 31, unknown: 90 };

export function renderReport(r: RunResult, colour: boolean): string {
  const paint = (code: number, s: string) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = (s: string) => paint(90, s);
  const badge = (s: Status | null) => (s ? paint(COLOURS[s], STATUS_LABELS[s].toUpperCase().padEnd(9)) : dim('—'.padEnd(9)));
  const results = new Map(r.results.map((x) => [x.node.id, x]));
  const out: string[] = [];

  out.push('', `Orrery — dogfood · ${r.source} · ${r.observedAt}`);
  const pending = r.plan.length;
  if (pending === 0) out.push(dim('Model: in sync with model.ts'));
  else {
    out.push(r.notWritten ? `Model: ${pending} change${pending === 1 ? '' : 's'} not applied (${r.notWritten})` : `Model: ${r.applied} change${r.applied === 1 ? '' : 's'} applied`);
    for (const c of r.plan) out.push(`  · ${c.summary}${r.notWritten && c.needsReason && !c.defaultReason ? dim(' (needs a reason)') : ''}`);
  }
  out.push('');

  const children = new Map<string | null, ModelNode[]>();
  for (const n of r.model) children.set(n.parentId ?? null, [...(children.get(n.parentId ?? null) ?? []), n]);

  const line = (n: ModelNode, prefix: string, last: boolean, top: boolean) => {
    const v = r.view.nodes[n.id];
    const branch = top ? '' : last ? '└─ ' : '├─ ';
    let detail = '';
    const res = results.get(n.id);
    if (res && n.measure) {
      if ('value' in res.outcome) {
        const now = judge(res.outcome.value, n.measure);
        detail = `${paint(COLOURS[now], formatValue(res.outcome.value, n.measure.unit))}${res.outcome.detail ? dim(` · ${res.outcome.detail}`) : ''}`;
      } else detail = dim(`not measured — ${res.outcome.skipped}`);
    } else if (v && !n.measure) detail = dim(v.evaluation.reason.length > 90 ? `${v.evaluation.reason.slice(0, 89)}…` : v.evaluation.reason);
    else if (!v) detail = dim('not in the log yet');
    out.push(`${dim(prefix + branch)}${badge(v?.evaluation.status ?? null)} ${n.title}${detail ? `  ${detail}` : ''}`);
    const kids = children.get(n.id) ?? [];
    kids.forEach((k, i) => line(k, top ? '' : prefix + (last ? '   ' : '│  '), i === kids.length - 1, false));
  };
  (children.get(null) ?? []).forEach((root) => line(root, '', true, true));

  out.push('');
  const skipped = r.results.filter((x) => !('value' in x.outcome));
  const measured = r.results.length - skipped.length;
  if (r.notWritten) out.push(`Nothing recorded (${r.notWritten}); ${measured} value${measured === 1 ? '' : 's'} measured. Statuses are as last recorded.`);
  else out.push(`Recorded ${r.recorded} reading${r.recorded === 1 ? '' : 's'} as ${r.source}, observed ${r.observedAt}.`);
  if (skipped.length) out.push(`Not measured, so recorded nothing and will read unknown once stale: ${skipped.map((x) => x.node.id).join(', ')}.`);
  out.push(dim('Open it with `pnpm dogfood:serve` → http://localhost:4711'), '');
  return out.join('\n');
}
