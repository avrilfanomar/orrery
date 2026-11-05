// Small, reused visual atoms. A status is never colour alone: it always has
// an icon shape and a label (dataviz rule: status ships with icon + label).
import {
  KIND_LABELS,
  PASS_FAIL_UNIT,
  STATUS_LABELS,
  type NodeKind,
  type Priority,
  type SeriesPoint,
  type Status,
} from '@orrery/core';

export function StatusIcon({ status, size = 14 }: { status: Status; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true } as const;
  switch (status) {
    case 'ok':
      return (
        <svg {...common} className="st-icon st-ok">
          <circle cx="8" cy="8" r="7" fill="var(--st-ok)" />
          <path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'warn':
      return (
        <svg {...common} className="st-icon st-warn">
          <path d="M8 1.2l7 12.6H1z" fill="var(--st-warn)" strokeLinejoin="round" />
          <path d="M8 5.6v4" stroke="#0b0b0b" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="8" cy="11.8" r="0.95" fill="#0b0b0b" />
        </svg>
      );
    case 'breach':
      return (
        <svg {...common} className="st-icon st-breach">
          <path d="M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1z" fill="var(--st-breach)" />
          <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'unknown':
      return (
        <svg {...common} className="st-icon st-unknown">
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="var(--st-unknown)" strokeWidth="1.6" strokeDasharray="2.4 1.9" />
          <path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.4" fill="none" stroke="var(--ink-2)" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="8" cy="11.4" r="0.85" fill="var(--ink-2)" />
        </svg>
      );
  }
}

export function StatusBadge({ status, size = 'md' }: { status: Status; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`badge badge-${size} bg-${status}`}>
      <StatusIcon status={status} size={size === 'lg' ? 18 : size === 'sm' ? 12 : 14} />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function StatusDot({ status }: { status: Status }) {
  return <span className={`dot dot-${status}`} aria-label={STATUS_LABELS[status]} role="img" />;
}

export function KindTag({ kind }: { kind: NodeKind }) {
  return <span className={`kind kind-${kind}`}>{KIND_LABELS[kind]}</span>;
}

export function PriorityTag({ priority }: { priority: Priority }) {
  return <span className={`prio prio-${priority}`}>{priority}</span>;
}

const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** One cell per day, oldest first. Unknown is hatched; a day before the node existed is an empty outline. */
export function Ribbon({ ribbon, times, compact = false }: { ribbon: (Status | null)[]; times: string[]; compact?: boolean }) {
  return (
    <span className={`ribbon${compact ? ' ribbon-compact' : ''}`} role="img" aria-label={`Daily status for the last ${ribbon.length} days`}>
      {ribbon.map((s, i) => (
        <span
          key={i}
          className={`cell ${s ? `cell-${s}` : 'cell-none'}`}
          title={`${times[i] ? day.format(new Date(times[i]!)) : ''} — ${s ? STATUS_LABELS[s] : 'did not exist yet'}`}
        />
      ))}
    </span>
  );
}

/** Coverage: how much of the subtree is actually observable. */
export function Coverage({ measured, total, wide = false }: { measured: number; total: number; wide?: boolean }) {
  const share = total === 0 ? 0 : measured / total;
  return (
    <span className={`coverage${wide ? ' coverage-wide' : ''}`} title={`${measured} of ${total} observable endpoints measured`}>
      <span className="coverage-track">
        <span className="coverage-fill" style={{ width: `${share * 100}%` }} />
      </span>
      <span className="coverage-label">
        {measured}/{total} observable
      </span>
    </span>
  );
}

/** A tiny trend: a 2px line, the target as a hairline, the latest point marked with its status. */
export function Sparkline({ points, unit, target, width = 132, height = 34 }: { points: SeriesPoint[]; unit: string; target: number; width?: number; height?: number }) {
  if (points.length === 0) return <span className="spark-empty">no readings yet</span>;
  if (unit === PASS_FAIL_UNIT) {
    const runs = points.slice(-12);
    return (
      <span className="runs" role="img" aria-label={`Last ${runs.length} runs`}>
        {runs.map((p, i) => (
          <span key={i} className={`run run-${p.s}`} title={`${new Date(p.t).toLocaleString()} — ${p.v >= 1 ? 'pass' : 'fail'}`} />
        ))}
      </span>
    );
  }
  const pad = 4;
  const ts = points.map((p) => Date.parse(p.t));
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts, t0 + 1);
  const vs = [...points.map((p) => p.v), target];
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const x = (t: number) => pad + ((t - t0) / (t1 - t0)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - lo) / (hi - lo)) * (height - pad * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(ts[i]!).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const last = points[points.length - 1]!;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Recent trend">
      <line x1={pad} x2={width - pad} y1={y(target)} y2={y(target)} className="spark-target" />
      <path d={d} className="spark-line" />
      <circle cx={x(ts[ts.length - 1]!)} cy={y(last.v)} r="3.5" className={`spark-end fill-${last.s}`} />
    </svg>
  );
}

export function Counts({ counts }: { counts: Record<Status, number> }) {
  const order: Status[] = ['breach', 'warn', 'unknown', 'ok'];
  return (
    <span className="counts">
      {order
        .filter((s) => counts[s] > 0)
        .map((s) => (
          <span key={s} className="count" title={`${counts[s]} ${STATUS_LABELS[s].toLowerCase()}`}>
            <StatusIcon status={s} size={11} />
            {counts[s]}
          </span>
        ))}
    </span>
  );
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function ago(iso: string, now: string): string {
  const diff = Date.parse(iso) - Date.parse(now);
  const abs = Math.abs(diff);
  if (abs < 3.6e6) return rtf.format(Math.round(diff / 60000), 'minute');
  if (abs < 48 * 3.6e6) return rtf.format(Math.round(diff / 3.6e6), 'hour');
  return rtf.format(Math.round(diff / 86.4e6), 'day');
}

export const fmtDateTime = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const fmtDate = day;
