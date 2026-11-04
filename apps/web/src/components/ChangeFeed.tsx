import type { TimelineEntry, UniverseView } from '@ru/core';
import { fmtDate, fmtDateTime } from './bits.js';

interface Props {
  changes: TimelineEntry[];
  view: UniverseView;
  onFocus: (id: string) => void;
  onAsOf: (asOf: string) => void;
  onClose: () => void;
}

/** How the model itself has evolved — not the readings, the requirements. */
export function ChangeFeed({ changes, view, onFocus, onAsOf, onClose }: Props) {
  const groups = new Map<string, TimelineEntry[]>();
  for (const c of changes) {
    const k = fmtDate.format(new Date(c.at));
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  return (
    <aside className="drawer" aria-label="Model changes">
      <header>
        <div>
          <h2>Model changes</h2>
          <p className="muted">Every change, with who made it and why. Readings are not listed.</p>
        </div>
        <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close changes">
          ×
        </button>
      </header>
      <div className="drawer-body">
        {[...groups.entries()].map(([d, list]) => (
          <section key={d}>
            <h3>{d}</h3>
            <ol>
              {list.map((c) => (
                <li key={c.seq}>
                  <button type="button" className="change" onClick={() => view.nodes[c.nodeId] && onFocus(c.nodeId)}>
                    <span className="change-meta">
                      {fmtDateTime.format(new Date(c.at))} · {c.actor}
                    </span>
                    <span className="change-summary">{c.summary}</span>
                    {c.reason && <q className="why">{c.reason}</q>}
                  </button>
                  <button type="button" className="link-btn" onClick={() => onAsOf(new Date(Date.parse(c.at) - 60_000).toISOString())}>
                    see the universe just before this
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </aside>
  );
}
