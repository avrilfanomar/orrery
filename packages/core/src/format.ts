// Formatting shared by the server (timeline summaries) and the UI, so a value
// reads the same everywhere.
import { PASS_FAIL_UNIT } from './constants.js';
import type { MeasureSpec, RollupRule } from './schema.js';

const CURRENCIES = new Set(['€', '$', '£']);

export function formatNumber(v: number): string {
  const abs = Math.abs(v);
  const digits = abs < 1 ? 3 : abs < 100 ? 2 : abs < 1000 ? 1 : 0;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(v);
}

export function formatValue(v: number, unit: string): string {
  if (unit === PASS_FAIL_UNIT) return v >= 1 ? 'pass' : 'fail';
  if (unit === '%') return `${formatNumber(v)}%`;
  if (CURRENCIES.has(unit)) return `${unit}${formatNumber(v)}`;
  return `${formatNumber(v)} ${unit}`;
}

export function formatThreshold(spec: MeasureSpec, which: 'target' | 'warn'): string {
  if (spec.unit === PASS_FAIL_UNIT) return 'pass';
  const op = spec.direction === 'higher' ? '≥' : '≤';
  return `${op} ${formatValue(spec[which], spec.unit)}`;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function describeRollup(r: RollupRule): string {
  switch (r.strategy) {
    case 'worst':
      return 'Worst of its contributors';
    case 'weighted':
      return `Priority-weighted score — on target at ${pct(r.okAt)}, warning at ${pct(r.warnAt)}`;
    case 'quorum':
      return `Quorum — on target when ${pct(r.okShare)} of contributors are, warning at ${pct(r.warnShare)}`;
  }
}

export function shortRollup(r: RollupRule): string {
  switch (r.strategy) {
    case 'worst':
      return 'worst-of';
    case 'weighted':
      return `weighted (${pct(r.okAt)}/${pct(r.warnAt)})`;
    case 'quorum':
      return `quorum (${pct(r.okShare)}/${pct(r.warnShare)})`;
  }
}

export function formatDuration(ms: number): string {
  const h = ms / 3.6e6;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}
