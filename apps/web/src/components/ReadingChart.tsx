// The deepest level of disclosure for a measured node: every reading over the
// window, the warning and breach zones of *each definition version in turn*
// (so a tightened target visibly re-zones the chart from the moment it
// changed, and earlier readings keep the colour they had), a crosshair and a
// table view.
import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from 'react';
import {
  formatThreshold,
  formatValue,
  PASS_FAIL_UNIT,
  STATUS_LABELS,
  type Definition,
  type MeasureSpec,
  type SeriesPoint,
} from '@ru/core';
import { StatusIcon, fmtDate, fmtDateTime } from './bits.js';

interface Props {
  series: SeriesPoint[];
  definitions: Definition[];
  from: string;
  to: string;
}

const M = { l: 60, r: 18, t: 22, b: 30 };
const H = 260;

function niceTicks(lo: number, hi: number, count = 5): number[] {
  const span = hi - lo || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setW(Math.max(320, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

interface Segment {
  def: Definition & { measure: MeasureSpec };
  t0: number;
  t1: number;
}

export function ReadingChart({ series, definitions, from, to }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const t0 = Date.parse(from);
  const t1 = Date.parse(to);
  const innerW = width - M.l - M.r;
  const innerH = H - M.t - M.b;

  const segments: Segment[] = useMemo(() => {
    const out: Segment[] = [];
    definitions.forEach((d, i) => {
      if (!d.measure) return;
      const start = Math.max(t0, Date.parse(d.effectiveFrom));
      const next = definitions[i + 1];
      const end = Math.min(t1, next ? Date.parse(next.effectiveFrom) : t1);
      if (end > start) out.push({ def: d as Segment['def'], t0: start, t1: end });
    });
    return out;
  }, [definitions, t0, t1]);

  const unit = segments.at(-1)?.def.measure.unit ?? definitions.at(-1)?.measure?.unit ?? '';
  const passFail = unit === PASS_FAIL_UNIT;

  const [lo, hi] = useMemo(() => {
    if (passFail) return [-0.5, 1.5];
    const vs = [...series.map((p) => p.v), ...segments.flatMap((s) => [s.def.measure.target, s.def.measure.warn])];
    let a = Math.min(...vs);
    let b = Math.max(...vs);
    if (!Number.isFinite(a)) return [0, 1];
    if (a === b) {
      a -= 1;
      b += 1;
    }
    const pad = (b - a) * 0.12;
    return [a - pad, b + pad];
  }, [series, segments, passFail]);

  const x = (t: number) => M.l + ((t - t0) / Math.max(1, t1 - t0)) * innerW;
  const y = (v: number) => M.t + innerH - ((v - lo) / (hi - lo)) * innerH;
  const clampY = (v: number) => Math.min(M.t + innerH, Math.max(M.t, y(v)));
  const ts = useMemo(() => series.map((p) => Date.parse(p.t)), [series]);

  const yTicks = passFail ? [] : niceTicks(lo, hi, 5);
  const days = (t1 - t0) / 86.4e6;
  const xStep = days > 20 ? 5 : days > 8 ? 2 : 1;
  const xTicks: number[] = [];
  const firstMidnight = new Date(t0);
  firstMidnight.setHours(24, 0, 0, 0);
  for (let t = firstMidnight.getTime(); t < t1; t += xStep * 86.4e6) xTicks.push(t);

  // The line carries status itself: each stretch is drawn in the status its
  // readings had under the definition in force then. Markers would carpet
  // the chart whenever a long stretch is off target.
  const runs: { s: SeriesPoint['s']; d: string }[] = [];
  if (!passFail) {
    series.forEach((p, i) => {
      const pt = `${x(ts[i]!).toFixed(1)},${y(p.v).toFixed(1)}`;
      const last = runs[runs.length - 1];
      if (last && last.s === p.s) last.d += `L${pt}`;
      else {
        const prev = i > 0 ? `M${x(ts[i - 1]!).toFixed(1)},${y(series[i - 1]!.v).toFixed(1)}L${pt}` : `M${pt}`;
        runs.push({ s: p.s, d: prev });
      }
    });
  }
  const breaches = series.filter((p) => p.s === 'breach').length;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (series.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = t0 + ((px - M.l) / innerW) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < ts.length; i++) if (Math.abs(ts[i]! - t) < Math.abs(ts[best]! - t)) best = i;
    setHover(best);
  };

  const hp = hover !== null ? series[hover] : undefined;
  const hDef = hp ? definitions.find((d) => d.version === hp.version) : undefined;
  const latest = series.at(-1);

  return (
    <div className="chart" ref={wrapRef}>
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`Readings from ${fmtDate.format(new Date(t0))} to ${fmtDate.format(new Date(t1))}${latest ? `; latest ${formatValue(latest.v, unit)}` : ''}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <clipPath id="plot">
            <rect x={M.l} y={M.t} width={innerW} height={innerH} />
          </clipPath>
        </defs>

        {/* Zones per definition version: the warning band and the breach region. */}
        <g clipPath="url(#plot)">
          {!passFail &&
            segments.map((s) => {
              const m = s.def.measure;
              const xa = x(s.t0);
              const w = x(s.t1) - xa;
              const top = M.t;
              const bottom = M.t + innerH;
              const yT = clampY(m.target);
              const yW = clampY(m.warn);
              return m.direction === 'lower' ? (
                <g key={s.def.version}>
                  <rect x={xa} width={w} y={yW} height={Math.max(0, yT - yW)} className="zone-warn" />
                  <rect x={xa} width={w} y={top} height={Math.max(0, yW - top)} className="zone-breach" />
                  <line x1={xa} x2={xa + w} y1={yT} y2={yT} className="target-line" />
                </g>
              ) : (
                <g key={s.def.version}>
                  <rect x={xa} width={w} y={yT} height={Math.max(0, yW - yT)} className="zone-warn" />
                  <rect x={xa} width={w} y={yW} height={Math.max(0, bottom - yW)} className="zone-breach" />
                  <line x1={xa} x2={xa + w} y1={yT} y2={yT} className="target-line" />
                </g>
              );
            })}
        </g>

        {/* Gridlines and y axis */}
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={M.l + innerW} y1={y(v)} y2={y(v)} className="grid" />
            <text x={M.l - 8} y={y(v)} dy="0.32em" textAnchor="end" className="tick">
              {formatValue(v, unit)}
            </text>
          </g>
        ))}
        {passFail &&
          [1, 0].map((v) => (
            <text key={v} x={M.l - 8} y={y(v)} dy="0.32em" textAnchor="end" className="tick">
              {v ? 'pass' : 'fail'}
            </text>
          ))}
        <line x1={M.l} x2={M.l + innerW} y1={M.t + innerH} y2={M.t + innerH} className="axis" />
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={H - 10} textAnchor="middle" className="tick">
            {fmtDate.format(new Date(t))}
          </text>
        ))}

        {/* Definition changes: where the yardstick moved. */}
        {segments.slice(1).map((s) => (
          <g key={`v${s.def.version}`}>
            <line x1={x(s.t0)} x2={x(s.t0)} y1={M.t - 6} y2={M.t + innerH} className="version-line" />
            <text x={x(s.t0) + 4} y={M.t - 8} className="version-label">
              v{s.def.version} · target {formatThreshold(s.def.measure, 'target')}
            </text>
          </g>
        ))}

        <g clipPath="url(#plot)">
          {runs.map((r, i) => (
            <path key={i} d={r.d} className={`series-line line-${r.s}`} />
          ))}
        </g>

        {/* Breaches get a marker when they are rare enough to point at; pass/fail runs are all marked. */}
        {series.map((p, i) =>
          passFail || (p.s === 'breach' && breaches <= 60) ? (
            <circle key={i} cx={x(ts[i]!)} cy={y(passFail ? (p.v >= 1 ? 1 : 0) : p.v)} r={passFail ? 5 : 4} className={`marker fill-${p.s}`} />
          ) : null,
        )}

        {hp && (
          <g pointerEvents="none">
            <line x1={x(ts[hover!]!)} x2={x(ts[hover!]!)} y1={M.t} y2={M.t + innerH} className="crosshair" />
            <circle cx={x(ts[hover!]!)} cy={y(passFail ? (hp.v >= 1 ? 1 : 0) : hp.v)} r={5} className={`marker fill-${hp.s}`} />
          </g>
        )}
      </svg>

      {hp && (
        <div
          className="tooltip"
          style={{
            left: Math.min(width - 230, Math.max(0, x(ts[hover!]!) + 12)),
            top: 8,
          }}
        >
          <div className="tooltip-value">{formatValue(hp.v, unit)}</div>
          <div className="tooltip-row">
            <StatusIcon status={hp.s} size={12} /> {STATUS_LABELS[hp.s]}
          </div>
          <div className="tooltip-row muted">{fmtDateTime.format(new Date(hp.t))}</div>
          {hDef?.measure && (
            <div className="tooltip-row muted">
              judged by v{hDef.version}: target {formatThreshold(hDef.measure, 'target')}
            </div>
          )}
        </div>
      )}

      {!passFail && (
        <div className="chart-legend">
          <span>
            <span className="key-line" style={{ background: 'var(--series)' }} /> on target
          </span>
          <span>
            <span className="key-line" style={{ background: 'var(--st-warn)' }} /> warning
          </span>
          <span>
            <span className="key-line" style={{ background: 'var(--st-breach)' }} /> breach
          </span>
          <span>
            <span className="key-line" style={{ background: 'var(--st-ok)' }} /> target of the version in force
          </span>
          <span>
            <span className="key-zone" style={{ background: 'var(--zone-warn)' }} />
            <span className="key-zone" style={{ background: 'var(--zone-breach)' }} /> warning / breach zones
          </span>
        </div>
      )}

      <details className="table-view">
        <summary>Readings as a table ({series.length})</summary>
        <table>
          <thead>
            <tr>
              <th>Observed</th>
              <th>Value</th>
              <th>Status</th>
              <th>Definition</th>
            </tr>
          </thead>
          <tbody>
            {[...series]
              .reverse()
              .slice(0, 200)
              .map((p, i) => (
                <tr key={i}>
                  <td>{fmtDateTime.format(new Date(p.t))}</td>
                  <td className="num">{formatValue(p.v, unit)}</td>
                  <td>
                    <StatusIcon status={p.s} size={11} /> {STATUS_LABELS[p.s]}
                  </td>
                  <td>v{p.version}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
