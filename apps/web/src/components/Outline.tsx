// The whole universe as a tree, for orientation. It always shows where the
// focus sits; "Issues only" prunes it to the paths that are not green.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { KIND_LABELS, type UniverseView } from '@ru/core';
import { StatusDot } from './bits.js';

interface Props {
  view: UniverseView;
  focusId: string;
  onFocus: (id: string) => void;
}

function ancestors(view: UniverseView, id: string): string[] {
  const out: string[] = [];
  let cur = view.nodes[id]?.parentId ?? null;
  while (cur && !out.includes(cur)) {
    out.push(cur);
    cur = view.nodes[cur]?.parentId ?? null;
  }
  return out;
}

export function Outline({ view, focusId, onFocus }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([...view.rootIds, ...ancestors(view, focusId)]));
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    setExpanded((prev) => {
      const missing = [focusId, ...ancestors(view, focusId)].filter((id) => !prev.has(id));
      return missing.length ? new Set([...prev, ...missing]) : prev;
    });
  }, [focusId, view]);

  // When filtering, show matching nodes plus the path to them, fully expanded.
  const filter = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!issuesOnly && !q) return null;
    const keep = new Set<string>();
    for (const n of Object.values(view.nodes)) {
      const matchesIssue = !issuesOnly || (n.evaluation.status !== 'ok' && n.lifecycle === 'active');
      const matchesText = !q || n.title.toLowerCase().includes(q) || n.id.includes(q);
      if (matchesIssue && matchesText) {
        keep.add(n.id);
        for (const a of ancestors(view, n.id)) keep.add(a);
      }
    }
    return keep;
  }, [view, issuesOnly, query]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNode = (id: string, depth: number): ReactNode => {
    const n = view.nodes[id];
    if (!n || (filter && !filter.has(id))) return null;
    const kids = n.childIds.filter((c) => !filter || filter.has(c));
    const open = filter ? true : expanded.has(id);
    return (
      <li key={id}>
        <div className={`row${id === focusId ? ' is-focus' : ''}${n.lifecycle === 'deprecated' ? ' is-deprecated' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
          {kids.length ? (
            <button type="button" className="chev" aria-label={`What contributes to ${n.title}`} aria-expanded={open} onClick={() => toggle(id)}>
              <svg width="10" height="10" viewBox="0 0 10 10" style={{ transform: open ? 'rotate(90deg)' : undefined }}>
                <path d="M3 1.5L6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          ) : (
            <span className="chev-spacer" />
          )}
          <button type="button" className="row-main" onClick={() => onFocus(id)} aria-current={id === focusId ? 'location' : undefined} title={`${KIND_LABELS[n.kind]} — ${n.evaluation.reason}`}>
            <StatusDot status={n.evaluation.status} />
            <span className="row-title">{n.title}</span>
            <span className="row-kind">{KIND_LABELS[n.kind]}</span>
          </button>
        </div>
        {open && kids.length > 0 && <ul>{kids.map((c) => renderNode(c, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <nav className="outline" aria-label="Universe outline">
      <div className="outline-tools">
        <input type="search" placeholder="Find a node…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a node" />
        <label className="switch">
          <input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} />
          Issues only
        </label>
      </div>
      {/* Nested lists of buttons, not role="tree": that role promises arrow-key navigation this outline does not offer (ADR 0011). */}
      <ul className="tree">
        {view.rootIds.map((id) => renderNode(id, 0))}
      </ul>
      {filter && filter.size === 0 && <p className="hint pad">Nothing matches.</p>}
    </nav>
  );
}
