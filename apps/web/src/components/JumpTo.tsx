// One search for the whole universe (ADR 0014): a node by title, id or
// description, a file by path, a metric by the text of its query. Ranking is
// core's (searchUniverse). It is a combobox and does what that role promises:
// the arrow keys move through the matches, Enter opens one, Escape closes the
// list and then clears the text. Ctrl+K (⌘K) brings focus here; the shortcut
// takes a modifier, since a bare character key would need a way to turn it
// off (WCAG 2.2 SC 2.1.4).
import { describeTarget, searchUniverse, type ReferenceTarget, type SearchHit, type UniverseView } from '@orrery/core';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { KindTag, StatusDot } from './bits.js';

interface Props {
  view: UniverseView;
  onFocus: (id: string) => void;
  onTarget: (target: ReferenceTarget) => void;
}

const LIST_ID = 'jump-list';

export function JumpTo({ view, onFocus, onTarget }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => searchUniverse(view, query, 10), [view, query]);
  const expanded = open && query.trim() !== '';

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const choose = (h: SearchHit) => {
    setQuery('');
    setOpen(false);
    if (h.type === 'node') onFocus(h.id);
    else onTarget(h.target);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (hits.length ? (a + step + hits.length) % hits.length : 0));
    } else if (e.key === 'Enter' && expanded && hits[active]) {
      e.preventDefault();
      choose(hits[active]!);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (expanded) setOpen(false);
      else setQuery('');
    }
  };

  return (
    <div className="jump">
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-label="Jump to a node, a file or a metric"
        aria-expanded={expanded}
        aria-controls={LIST_ID}
        aria-autocomplete="list"
        aria-activedescendant={expanded && hits[active] ? `jump-${active}` : undefined}
        placeholder="Jump to…"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <kbd className="jump-key" aria-hidden="true">
        Ctrl K
      </kbd>
      <ul id={LIST_ID} role="listbox" aria-label="Matches" className="jump-list" hidden={!expanded}>
        {expanded && hits.length === 0 && (
          <li role="option" aria-selected="false" aria-disabled="true" className="jump-none">
            Nothing matches “{query.trim()}”
          </li>
        )}
        {expanded &&
          hits.map((h, i) => (
            <li
              key={h.type === 'node' ? h.id : describeTarget(h.target)}
              id={`jump-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'is-active' : undefined}
              // Keeps focus in the input, so the list stays a popup of it.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(h);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <HitLabel hit={h} view={view} />
            </li>
          ))}
      </ul>
    </div>
  );
}

function HitLabel({ hit, view }: { hit: SearchHit; view: UniverseView }) {
  if (hit.type === 'node') {
    const n = view.nodes[hit.id]!;
    return (
      <>
        <StatusDot status={n.evaluation.status} />
        <span className="jump-title">{n.title}</span>
        <KindTag kind={n.kind} />
      </>
    );
  }
  return (
    <>
      <span className="ref-kind">{'url' in hit.target ? 'Link' : hit.target.path.endsWith('/') ? 'Directory' : 'File'}</span>
      <span className="jump-title">{hit.matched}</span>
      <span className="muted jump-meta">
        {hit.matched !== describeTarget(hit.target) ? `${describeTarget(hit.target)} · ` : ''}
        {hit.holders.length} node{hit.holders.length === 1 ? '' : 's'}
      </span>
    </>
  );
}
