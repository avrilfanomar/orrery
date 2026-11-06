// Every setting the server package reads, checked in one place (ADR 0007).
// An empty value means unset, as `${VAR:-default}` does in a shell: the smoke
// harness clears ORRERY_SOURCES_FILE that way, and an empty HOST must never mean
// "every interface". Anything else must parse, or the process stops before it
// serves and names the variable. Entry points call these; nothing reads the
// environment at import time, so a test passes in the environment it means.
import { isAbsolute, resolve } from 'node:path';
import { repoRoot } from './paths.js';

export type Env = Readonly<Record<string, string | undefined>>;

/** A setting with a value the process cannot use. Thrown before anything is opened or served. */
export class SettingError extends Error {
  override name = 'SettingError';
}

export const SEED_KINDS = ['demo', 'dogfood'] as const;
export type SeedKind = (typeof SEED_KINDS)[number];

const given = (raw: string | undefined): string | undefined => raw?.trim() || undefined;

function whole(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  const v = given(raw);
  if (v === undefined) return fallback;
  const n = /^\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!(n >= min && n <= max)) throw new SettingError(`${name} must be a whole number from ${min} to ${max} (got “${v}”)`);
  return n;
}

const portOf = (name: string, raw: string | undefined, fallback: number) => whole(name, raw, fallback, 1, 65_535);

/** pnpm runs a package's scripts in that package's directory, so a relative path is read from where the command was typed. */
function pathOf(raw: string | undefined, env: Env): string | null {
  const v = given(raw);
  if (v === undefined) return null;
  return isAbsolute(v) ? v : resolve(given(env.INIT_CWD) ?? process.cwd(), v);
}

function urlOf(name: string, raw: string | undefined, fallback: string): string {
  const v = given(raw) ?? fallback;
  const u = URL.canParse(v) ? new URL(v) : null;
  if (u?.protocol !== 'http:' && u?.protocol !== 'https:') throw new SettingError(`${name} must be an http(s) URL (got “${v}”)`);
  return v.replace(/\/+$/, '');
}

/** A host name, or `.name` for the name and every name under it. */
const HOST_NAME = /^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function hostNamesOf(name: string, raw: string | undefined): string[] {
  const v = given(raw);
  if (v === undefined) return [];
  return v.split(',').map((part) => {
    const h = part.trim().toLowerCase();
    if (!HOST_NAME.test(h)) throw new SettingError(`${name} must be host names separated by commas, e.g. orrery.example.org,.internal (got “${v}”)`);
    return h;
  });
}

function flagOf(name: string, raw: string | undefined): boolean {
  const v = given(raw);
  if (v === undefined || v === '0') return false;
  if (v === '1') return true;
  throw new SettingError(`${name} must be 1 or 0 (got “${v}”)`);
}

export function seedKindFrom(raw: string | undefined): SeedKind {
  const v = given(raw) ?? 'demo';
  if (!(SEED_KINDS as readonly string[]).includes(v)) throw new SettingError(`ORRERY_SEED must be one of ${SEED_KINDS.join(', ')} (got “${v}”)`);
  return v as SeedKind;
}

/** The base URL of a server listening on `host`, with an IPv6 address in brackets. */
export const baseUrl = (host: string, port: number) => `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;

const listenOn = (env: Env) => ({ host: given(env.HOST) ?? '127.0.0.1', port: portOf('PORT', env.PORT, 4710) });

export interface ServerSettings {
  dataFile: string;
  webDist: string;
  host: string;
  port: number;
  /** What an empty log starts as. */
  seed: SeedKind;
  ingestToken: string | null;
  sourcesFile: string | null;
  /** The repositories references lead into (ADR 0014). */
  reposFile: string | null;
  allowRemote: boolean;
  /** Names besides loopback and IP addresses that a request may address the server by (ADR 0010). */
  allowedHosts: string[];
}

/** The API server and `reset`. */
export function serverSettings(env: Env): ServerSettings {
  return {
    ...listenOn(env),
    dataFile: pathOf(env.ORRERY_DATA_FILE, env) ?? resolve(repoRoot, 'data/events.jsonl'),
    webDist: pathOf(env.ORRERY_WEB_DIST, env) ?? resolve(repoRoot, 'apps/web/dist'),
    seed: seedKindFrom(env.ORRERY_SEED),
    ingestToken: given(env.ORRERY_INGEST_TOKEN) ?? null,
    sourcesFile: pathOf(env.ORRERY_SOURCES_FILE, env),
    reposFile: pathOf(env.ORRERY_REPOS_FILE, env),
    allowRemote: flagOf('ORRERY_ALLOW_REMOTE', env.ORRERY_ALLOW_REMOTE),
    allowedHosts: hostNamesOf('ORRERY_ALLOWED_HOSTS', env.ORRERY_ALLOWED_HOSTS),
  };
}

export interface SimulatorSettings {
  api: string;
  tickMs: number;
  ingestToken: string | null;
}

/** The live signal simulator. Its tick stays at a second or more: `setInterval` turns anything it cannot use into 1 ms. */
export function simulatorSettings(env: Env): SimulatorSettings {
  const { host, port } = listenOn(env);
  return {
    api: urlOf('ORRERY_API', env.ORRERY_API, baseUrl(host, port)),
    tickMs: whole('ORRERY_SIM_TICK_MS', env.ORRERY_SIM_TICK_MS, 30_000, 1_000, 86_400_000),
    ingestToken: given(env.ORRERY_INGEST_TOKEN) ?? null,
  };
}

export interface TagSettings {
  /** The server whose universe the scan reconciles. */
  api: string;
  /** Where the command was typed: the repository scanned unless `--root` says otherwise. */
  cwd: string;
}

/** `pnpm tags` (ADR 0014): it talks to a running server, as the simulator does. */
export function tagSettings(env: Env): TagSettings {
  const { host, port } = listenOn(env);
  return { api: urlOf('ORRERY_API', env.ORRERY_API, baseUrl(host, port)), cwd: resolve(given(env.INIT_CWD) ?? process.cwd()) };
}

export interface DogfoodSettings {
  file: string;
  port: number;
  /** A running dogfood server to record into. */
  url: string;
  probeEnv: string;
  colour: boolean;
}

/** `pnpm dogfood` and `pnpm dogfood:serve` (ADR 0003): their own log and port, so they never mix with the demo. */
export function dogfoodSettings(env: Env): DogfoodSettings {
  const port = portOf('ORRERY_DOGFOOD_PORT', env.ORRERY_DOGFOOD_PORT, 4711);
  return {
    file: pathOf(env.ORRERY_DOGFOOD_FILE, env) ?? resolve(repoRoot, 'data/dogfood.jsonl'),
    port,
    url: urlOf('ORRERY_DOGFOOD_URL', env.ORRERY_DOGFOOD_URL, `http://127.0.0.1:${port}`),
    probeEnv: given(env.ORRERY_PROBE_ENV) ?? 'local',
    // no-color.org: any non-empty value turns colour off.
    colour: given(env.NO_COLOR) === undefined,
  };
}
