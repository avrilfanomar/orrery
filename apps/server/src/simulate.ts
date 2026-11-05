// A stand-in for real monitoring: pushes readings through the public
// ingestion webhook, exactly as Prometheus alert hooks, CI jobs or analytics
// exports would. It first backfills any gap since the last reading (so a
// restarted demo is not stale), then keeps the fast signals moving.
import type { UniverseView } from '@orrery/core';
import { clampRound, jitter, mulberry32, PROFILES, simulatorRefusal, type Profile } from './demo.js';
import { simulatorSettings } from './settings.js';

const { api: API, tickMs: TICK_MS, ingestToken } = simulatorSettings(process.env);
const H = 3.6e6;
const rnd = mulberry32(Date.now() & 0xffff);
const headers: Record<string, string> = { 'content-type': 'application/json' };
if (ingestToken) headers.authorization = `Bearer ${ingestToken}`;

interface Reading {
  nodeId: string;
  value: number;
  observedAt: string;
  source: string;
}
interface Live {
  p: Profile;
  value: number;
  lastAt: number;
}

async function waitForServer(): Promise<UniverseView> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API}/api/universe`);
      if (res.ok) return (await res.json()) as UniverseView;
    } catch {
      // not up yet
    }
    if (attempt === 0) console.log(`sim: waiting for ${API} …`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function push(readings: Reading[]): Promise<void> {
  for (let i = 0; i < readings.length; i += 2000) {
    const res = await fetch(`${API}/api/readings`, { method: 'POST', headers, body: JSON.stringify({ readings: readings.slice(i, i + 2000) }) });
    if (!res.ok) console.error(`sim: ingestion refused (${res.status}): ${await res.text()}`);
  }
}

const universe = await waitForServer();
// The seed's "now" is thirty days after the log's first event; the live
// signals keep following the seeded script from there (see Profile.shape).
const seedMoment = Date.parse(universe.range.from) + 30 * 24 * H;

function next(l: Live, at: number): number {
  if (l.p.pass) return 1;
  const toward = l.p.base + (l.p.shape?.((seedMoment - at) / H) ?? 0);
  return clampRound(l.p, l.value + (toward - l.value) * 0.08 + l.p.noise * 0.35 * jitter(rnd));
}

// It stays up feeding nothing rather than exit: `pnpm dev` runs it under `concurrently -k`, which would stop the server too.
const refusal = simulatorRefusal(universe.rootIds);
if (refusal) console.error(`sim: feeding nothing — ${refusal}`);

const live: Live[] = [];
for (const p of refusal ? [] : PROFILES) {
  const n = universe.nodes[p.id];
  if (!n?.definition.measure || n.lifecycle !== 'active') continue;
  // A metric the server pulls itself must not be fed from both sides (ADR 0002).
  if (n.definition.binding?.sourceId) continue;
  const m = n.evaluation.measurement;
  live.push({ p, value: m?.value ?? p.base, lastAt: m?.observedAt ? Date.parse(m.observedAt) : Date.now() - p.cadenceHours * H });
}

// Backfill the gap since the last reading at each signal's own cadence.
const backfill: Reading[] = [];
for (const l of live) {
  for (let t = l.lastAt + l.p.cadenceHours * H; t <= Date.now(); t += l.p.cadenceHours * H) {
    l.value = next(l, t);
    l.lastAt = t;
    backfill.push({ nodeId: l.p.id, value: l.value, observedAt: new Date(t).toISOString(), source: l.p.source });
  }
}
if (backfill.length) {
  await push(backfill);
  console.log(`sim: backfilled ${backfill.length} readings`);
}

console.log(`sim: streaming ${live.length} signals every ${TICK_MS / 1000}s into ${API}/api/readings`);
setInterval(() => {
  const now = Date.now();
  const batch: Reading[] = [];
  for (const l of live) {
    // Fast signals (≤ 6 h cadence) stream on every tick; slower ones only when due.
    const due = l.p.cadenceHours <= 6 || now - l.lastAt >= l.p.cadenceHours * H;
    if (!due) continue;
    l.value = next(l, now);
    l.lastAt = now;
    batch.push({ nodeId: l.p.id, value: l.value, observedAt: new Date(now).toISOString(), source: l.p.source });
  }
  if (batch.length) push(batch).catch((err) => console.error(`sim: ${String(err)}`));
}, TICK_MS);
