// What keeps a secret out of the repository (ADR 0010), measured over its whole
// history: a credential committed once stays readable in every clone, even
// after a later commit deletes it. The suite cannot see history; this probe
// reads every line any commit on any ref ever added. These live apart from
// probes.ts, which imports them, so they may import only types from it.
import { lastLine, runProgram } from './collectors.js';
import type { Probe, ProbeContext, ProbeOutcome } from './probes.js';

const V10 = 'First version of this method (ADR 0010)';

/**
 * Credentials by the shapes their issuers give them, strict enough that a
 * made-up value in a test (`glsa_secret_token_value`) does not match. A
 * generic "password = …" rule would flag every test of the guards themselves.
 */
export const SECRET_SHAPES: readonly { id: string; pattern: RegExp }[] = [
  { id: 'private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { id: 'Grafana token', pattern: /\b(?:glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}|glc_[A-Za-z0-9+/]{32,}={0,2})/ },
  { id: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'Stripe live key', pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}/ },
  { id: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'Anthropic or OpenAI key', pattern: /\bsk-(?:ant-|proj-)[A-Za-z0-9_-]{20,}/ },
  { id: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

export interface SecretFinding {
  shape: string;
  commit: string;
  file: string;
}

/**
 * Reads `git log -p` output (each commit headed by a NUL and its short hash)
 * for added lines shaped like a credential. A finding names the shape, the
 * commit and the file, never the value: the report lands in the append-only
 * dogfood log, where a secret could never be removed.
 */
export function findSecrets(patch: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  let commit = '';
  let file = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('\0')) commit = line.slice(1);
    else if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (?:b\/)?/, '');
    else if (line.startsWith('+')) for (const s of SECRET_SHAPES) if (s.pattern.test(line)) found.push({ shape: s.id, commit, file });
  }
  return found;
}

async function secretsInHistory(ctx: ProbeContext): Promise<ProbeOutcome> {
  // -m: a merge's changes are shown against each parent, so a line added in a merge is read too.
  const res = await runProgram(ctx.root, 'git', ['log', '--all', '-p', '-m', '--no-color', '--no-ext-diff', '--no-textconv', '--format=%x00%h'], { cwd: ctx.root, timeoutMs: 120_000 });
  if (res.spawnError || res.code !== 0) return { skipped: `git log failed: ${res.spawnError ?? lastLine(res.stderr)}` };
  const found = findSecrets(res.stdout);
  const commits = new Set(res.stdout.split('\n').filter((l) => l.startsWith('\0'))).size;
  const detail = found.length ? found.map((f) => `${f.shape} in ${f.file} (${f.commit})`).join('; ') : `nothing shaped like a credential in ${commits} commits`;
  return { value: found.length, detail };
}

export const SECURITY_PROBES: readonly Probe[] = [
  {
    id: 'secrets-in-history',
    version: 1,
    since: V10,
    method: `Reads every line added by any commit on any ref, merges included (git log --all -p -m), and counts the lines shaped like a credential: ${SECRET_SHAPES.map((s) => s.id).join(', ')} (SECRET_SHAPES in apps/server/src/dogfood/security.ts). A credential deleted later still counts, because every clone keeps it. The report names the shape, file and commit, never the value. No reading when git cannot run.`,
    measure: secretsInHistory,
  },
];
