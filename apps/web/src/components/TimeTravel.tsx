// A slider over the life of the log. Ticks mark the moments the model itself
// changed (targets, priorities, structure), so you can scrub to "just before
// the target was tightened" and see the universe as it was judged then.
import { useEffect, useRef, useState } from 'react';
import type { TimelineEntry } from '@ru/core';
import { fmtDateTime } from './bits.js';

interface Props {
  range: { from: string; to: string };
  asOf: string | null;
  /** The live view has stopped updating (App's useStalledSince): never call it live then. */
  stalled?: boolean;
  changes: TimelineEntry[];
  onChange: (asOf: string | null) => void;
}

const HOUR = 3.6e6;

export function TimeTravel({ range, asOf, stalled = false, changes, onChange }: Props) {
  const min = Date.parse(range.from);
  const max = Date.parse(range.to);
  const committed = asOf ? Math.min(max, Date.parse(asOf)) : max;
  const [draft, setDraft] = useState(committed);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => setDraft(committed), [committed]);

  const commit = (v: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onChange(v >= max - HOUR ? null : new Date(v).toISOString()), 250);
  };

  const live = !asOf;
  const span = Math.max(1, max - min);
  const ticks = changes.filter((c) => Date.parse(c.at) > min + HOUR); // skip the initial drafting burst

  return (
    <div className={`timetravel${live ? ' is-live' : ''}`}>
      <span className="tt-label" aria-live="polite">
        {live && draft >= max - HOUR ? (stalled ? 'Not live' : 'Live') : fmtDateTime.format(new Date(draft))}
      </span>
      <span className="tt-track">
        <input
          type="range"
          min={min}
          max={max}
          step={HOUR}
          value={draft}
          aria-label="Look at the universe at another moment"
          onChange={(e) => {
            const v = Number(e.target.value);
            setDraft(v);
            commit(v);
          }}
        />
        <span className="tt-ticks" aria-hidden="true">
          {ticks.map((c) => (
            <span key={c.seq} className="tt-tick" style={{ left: `${((Date.parse(c.at) - min) / span) * 100}%` }} title={`${fmtDateTime.format(new Date(c.at))} — ${c.summary}`} />
          ))}
        </span>
      </span>
      <button type="button" className={`btn btn-small${live ? ' is-on' : ''}`} onClick={() => onChange(null)} disabled={live}>
        <span className="live-dot" /> Live
      </button>
    </div>
  );
}
