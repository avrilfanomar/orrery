import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from './api.js';
import { ActionDialog, type Action } from './components/ActionDialog.js';
import { ChangeFeed } from './components/ChangeFeed.js';
import { Coverage, StatusBadge, fmtDateTime } from './components/bits.js';
import { Focus } from './components/Focus.js';
import { Outline } from './components/Outline.js';
import { TimeTravel } from './components/TimeTravel.js';
import { useRoute, useStoredState } from './route.js';

const LIVE_REFRESH_MS = 5000;

export function App() {
  const [route, navigate] = useRoute();
  const [actor, setActor] = useStoredState('ru.actor', 'you');
  const [changesOpen, setChangesOpen] = useState(false);
  const [dialog, setDialog] = useState<{ action: Action; extra?: string } | null>(null);

  const universe = useQuery({
    queryKey: ['universe', route.asOf],
    queryFn: () => api.universe(route.asOf),
    refetchInterval: route.asOf ? false : LIVE_REFRESH_MS,
    placeholderData: keepPreviousData,
  });
  const changes = useQuery({
    queryKey: ['changes', universe.data?.stats.changes ?? 0],
    queryFn: () => api.changes(null),
    enabled: !!universe.data,
    placeholderData: keepPreviousData,
  });

  if (!universe.data) {
    return (
      <div className="splash">
        {universe.isError ? (
          <>
            <h1>Cannot reach the API</h1>
            <p className="muted">{universe.error.message}. Is the server running (`pnpm dev`)?</p>
          </>
        ) : (
          <p className="muted">Loading the universe…</p>
        )}
      </div>
    );
  }

  const view = universe.data;
  const rootId = view.rootIds[0];
  const focusId = route.focus && view.nodes[route.focus] ? route.focus : rootId;
  const missing = route.focus && !view.nodes[route.focus];
  const root = rootId ? view.nodes[rootId] : undefined;
  const focus = (id: string) => navigate({ focus: id });

  return (
    <div className={`app${view.live ? '' : ' is-past'}${universe.isPlaceholderData ? ' is-refetching' : ''}`}>
      <header className="topbar">
        <button type="button" className="brand" onClick={() => rootId && focus(rootId)}>
          <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
            {/* docs/brand/logo-small.svg: the apex is the worst of its children, and the amber edge is the signal behind it */}
            <g fill="none" stroke="var(--muted)" strokeWidth="2.8" strokeLinecap="round">
              <line x1="13.66" y1="11.61" x2="7.62" y2="21.59" />
              <line x1="17.74" y1="11.61" x2="23.47" y2="21.07" />
            </g>
            <line x1="15.7" y1="13.65" x2="15.7" y2="20.35" stroke="var(--st-warn)" strokeWidth="2.8" strokeLinecap="round" />
            <polygon points="15.7,2.85 21.1,8.25 15.7,13.65 10.3,8.25" fill="var(--st-warn)" />
            <circle cx="5.7" cy="24.75" r="3.7" fill="var(--st-ok)" />
            <polygon points="15.7,20.35 20.1,24.75 15.7,29.15 11.3,24.75" fill="var(--st-warn)" />
            <circle cx="25.7" cy="24.75" r="3.15" fill="none" stroke="var(--st-unknown)" strokeWidth="2.3" strokeDasharray="3.2 2.2" />
          </svg>
          <span>Requirement Universe</span>
        </button>
        {root && (
          <div className="overall">
            <span className="overall-title">{root.title}</span>
            <StatusBadge status={root.evaluation.status} size="sm" />
            <Coverage {...root.evaluation.coverage} />
          </div>
        )}
        <TimeTravel range={view.range} asOf={route.asOf} changes={changes.data ?? []} onChange={(asOf) => navigate({ asOf }, { replace: true })} />
        <button type="button" className={`btn btn-small${changesOpen ? ' is-on' : ''}`} onClick={() => setChangesOpen((o) => !o)} aria-expanded={changesOpen}>
          Changes {view.stats.changes > 0 && <span className="pill">{view.stats.changes}</span>}
        </button>
        <label className="actor" title="Recorded as the author of your changes (identity is out of scope for the PoC)">
          as
          <input value={actor} onChange={(e) => setActor(e.target.value.slice(0, 80))} aria-label="Acting as" />
        </label>
      </header>

      {!view.live && (
        <div className="past-banner" role="status">
          Viewing the universe as it was known on <strong>{fmtDateTime.format(new Date(view.asOf))}</strong> — with the targets and priorities in force then.
          <button type="button" className="btn btn-small" onClick={() => navigate({ asOf: null }, { replace: true })}>
            Back to live
          </button>
        </div>
      )}
      {missing && (
        <div className="past-banner" role="status">
          “{route.focus}” did not exist at this moment — showing the top level instead.
        </div>
      )}

      <div className={`body${changesOpen ? ' with-drawer' : ''}`}>
        {focusId && <Outline view={view} focusId={focusId} onFocus={focus} />}
        <main className="main">
          {focusId ? (
            <Focus key={focusId} view={view} id={focusId} asOf={route.asOf} onFocus={focus} onAction={(action, extra) => setDialog({ action, extra })} />
          ) : (
            <p className="muted">The universe is empty.</p>
          )}
        </main>
        {changesOpen && (
          <ChangeFeed
            changes={changes.data ?? []}
            view={view}
            onFocus={focus}
            onAsOf={(asOf) => navigate({ asOf }, { replace: true })}
            onClose={() => setChangesOpen(false)}
          />
        )}
      </div>

      {dialog && focusId && view.nodes[focusId] && (
        <ActionDialog
          action={dialog.action}
          extra={dialog.extra}
          node={view.nodes[focusId]!}
          view={view}
          actor={actor}
          onClose={() => setDialog(null)}
          onDone={(events) => {
            setDialog(null);
            const created = events.find((e) => e.type === 'node.created');
            if (created && created.type === 'node.created') focus(created.data.id);
          }}
        />
      )}
    </div>
  );
}
