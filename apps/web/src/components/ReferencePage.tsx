// A file, a directory or a link, and every node that references it (ADR 0014):
// the way back from the code to the requirements it serves. Its URL is a
// permalink, so a code review or an editor can link a file here. Which nodes
// are listed, and why, is decided in core (referencedBy, countsToward).
import {
  ancestorDirectories,
  countsToward,
  describeTarget,
  isUrlTarget,
  kindLabel,
  referenceHref,
  referencedBy,
  type ReferenceTarget,
  type Referrer,
  type Repository,
  type UniverseView,
} from '@orrery/core';
import { useMemo } from 'react';
import { KindTag } from './bits.js';
import { NodeButton } from './Connections.js';
import { safeHref } from './Provenance.js';

interface Props {
  view: UniverseView;
  target: ReferenceTarget;
  repos: readonly Repository[];
  onFocus: (id: string) => void;
  onTarget: (target: ReferenceTarget) => void;
}

export function ReferencePage({ view, target, repos, onFocus, onTarget }: Props) {
  const referrers = useMemo(() => referencedBy(view, target), [view, target]);
  const url = isUrlTarget(target);
  const nodes = new Set(referrers.map((r) => r.node.id)).size;

  return (
    <article className="focus reference-page">
      {!url && <DirectoryCrumbs target={target} repos={repos} onTarget={onTarget} />}
      <TargetHead target={target} repos={repos} />
      <section className="panel">
        <div className="panel-head">
          <h2>
            Referenced by {nodes} node{nodes === 1 ? '' : 's'}
          </h2>
          <span className="muted">{url ? 'everything that links here' : 'directly, through a directory above it, or through a file below it'}</span>
        </div>
        {referrers.length === 0 ? (
          <p className="muted">Nothing in this universe references it{view.live ? '' : ' at this moment'}.</p>
        ) : (
          <ul className="conn-list referrers">
            {referrers.map((r, i) => (
              <ReferrerRow key={i} referrer={r} view={view} onFocus={onFocus} onTarget={onTarget} />
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

/** The repository, then every directory above the target, each a page of its own. */
function DirectoryCrumbs({ target, repos, onTarget }: { target: { repo: string; path: string } } & Pick<Props, 'repos' | 'onTarget'>) {
  const repo = repos.find((r) => r.id === target.repo);
  const last = target.path.split('/').filter(Boolean).at(-1);
  return (
    <nav className="crumbs" aria-label="Directories above it">
      <span className="crumb">
        <span className="muted">{repo?.label ?? target.repo} </span>
        <span className="sep" aria-hidden="true">›</span>
      </span>
      {ancestorDirectories(target.path).map((dir) => (
        <span key={dir} className="crumb">
          <button type="button" onClick={() => onTarget({ repo: target.repo, path: dir })}>
            {dir.split('/').at(-2)}/
          </button>
          <span className="sep" aria-hidden="true">›</span>
        </span>
      ))}
      <span className="crumb is-current">{target.path.endsWith('/') ? `${last}/` : last}</span>
    </nav>
  );
}

/** What the target is, and the way out to it when there is one. */
function TargetHead({ target, repos }: Pick<Props, 'target' | 'repos'>) {
  const href = safeHref(referenceHref(target, repos));
  const url = isUrlTarget(target);
  const repo = url ? null : repos.find((r) => r.id === target.repo);
  const what = url ? 'Link' : target.path.endsWith('/') ? 'Directory' : 'File';
  const missing = url ? 'Not an http(s) link.' : `No browse link: the server has no repository “${target.repo}” configured (ORRERY_REPOS_FILE).`;
  return (
    <header className="focus-head">
      <div className="eyebrow">
        <span className="kind">{what}</span>
      </div>
      <h1 className="reference-title">{describeTarget(target)}</h1>
      <p className="desc">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            Open it{repo ? ` in ${repo.label}` : ''} ↗
          </a>
        ) : (
          <span className="muted">{missing}</span>
        )}
      </p>
    </header>
  );
}

function ReferrerRow({ referrer, view, onFocus, onTarget }: { referrer: Referrer; view: UniverseView } & Pick<Props, 'onFocus' | 'onTarget'>) {
  const { node, ref, match } = referrer;
  const parents = countsToward(view, node.id).filter((c) => c.depth === 1);
  return (
    <li className="referrer">
      <KindTag kind={node.kind} />
      <NodeButton node={node} onFocus={onFocus} />
      <span className="ref-kind">{kindLabel(ref.kind)}</span>
      {ref.origin === 'tag' && <span className="tag">tagged</span>}
      {match !== 'exact' && (
        <span className="muted">
          {match === 'directory' ? 'through ' : 'through the file '}
          <button type="button" className="link-btn" onClick={() => onTarget(ref.target)}>
            {describeTarget(ref.target)}
          </button>
        </span>
      )}
      {parents.length > 0 && (
        <span className="referrer-up muted">
          counts toward{' '}
          {parents.map((c, i) => (
            <span key={c.node.id}>
              {i > 0 && ', '}
              <button type="button" className="link-btn" onClick={() => onFocus(c.node.id)}>
                {c.node.title}
              </button>
            </span>
          ))}
        </span>
      )}
    </li>
  );
}
