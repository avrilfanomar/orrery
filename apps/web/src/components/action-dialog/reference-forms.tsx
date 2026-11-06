// Adding and removing a reference (ADR 0014). A reference moves no status and
// no yardstick, so neither asks for a reason; one can be given.
import { useQuery } from '@tanstack/react-query';
import { REFERENCE_KINDS, describeTarget, type Reference } from '@orrery/core';
import { useMemo, useState } from 'react';
import { api } from '../../api.js';
import { Field, ReasonField } from './fields.js';
import { Frame, type FormProps } from './frame.js';

type Where = 'repo' | 'url';

export function ReferenceForm({ node, view, session }: FormProps) {
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos });
  // Repositories the server configures, and any the universe already names: a reference may lead into one nobody configured.
  const repoIds = useMemo(() => {
    const ids = new Set((repos.data ?? []).map((r) => r.id));
    for (const n of Object.values(view.nodes)) for (const r of n.refs) if ('repo' in r.target) ids.add(r.target.repo);
    return [...ids];
  }, [repos.data, view]);
  const [where, setWhere] = useState<Where>('repo');
  const [kind, setKind] = useState('code');
  const [repo, setRepo] = useState('');
  const [path, setPath] = useState('');
  const [symbol, setSymbol] = useState('');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');
  const chosenRepo = repo || repoIds[0] || '';

  const switchTo = (w: Where) => {
    setWhere(w);
    if (w === 'url' && (kind === 'code' || kind === 'test')) setKind('doc');
    if (w === 'repo' && kind === 'doc') setKind('code');
  };

  const build = () => {
    const ref: Reference = {
      kind: kind.trim(),
      target: where === 'repo' ? { repo: chosenRepo.trim(), path: path.trim(), ...(symbol.trim() ? { symbol: symbol.trim() } : {}) } : { url: url.trim() },
      ...(label.trim() ? { label: label.trim() } : {}),
    };
    return { type: 'node.reference' as const, data: { id: node.id, ref, reason: reason.trim() || null } };
  };

  return (
    <Frame
      session={session}
      title="Add a reference"
      sub="Point this node at the code, test, document or ticket behind it. A reference is a way to get there and back; it never changes a status."
      verb="Add reference"
      build={build}
      disabled={where === 'repo' ? !chosenRepo || !path.trim() : !url.trim()}
    >
      <fieldset className="group">
        <legend>Where it leads</legend>
        <div className="radios">
          <label>
            <input type="radio" name="ref-where" checked={where === 'repo'} onChange={() => switchTo('repo')} /> A file or directory in a repository
          </label>
          <label>
            <input type="radio" name="ref-where" checked={where === 'url'} onChange={() => switchTo('url')} /> A link
          </label>
        </div>
      </fieldset>
      <Field label="Kind" hint="Suggested kinds are listed; any lowercase id works, such as your team’s own.">
        <input value={kind} onChange={(e) => setKind(e.target.value)} list="ref-kinds" required pattern="[a-z][a-z0-9\-]{0,31}" />
        <datalist id="ref-kinds">
          {Object.entries(REFERENCE_KINDS).map(([id, text]) => (
            <option key={id} value={id}>
              {text}
            </option>
          ))}
        </datalist>
      </Field>
      {where === 'repo' ? (
        <>
          <Field label="Repository" hint={repos.data?.length ? undefined : 'No repository is configured on this server, so it will have no link out (ORRERY_REPOS_FILE).'}>
            <input value={chosenRepo} onChange={(e) => setRepo(e.target.value)} list="ref-repos" required pattern="[a-z0-9][a-z0-9\-]{0,31}" />
            <datalist id="ref-repos">
              {repoIds.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          </Field>
          <Field label="Path" hint="Relative to the repository root; end with / for a directory. No line numbers: they move with every edit.">
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="services/checkout/src/payments.ts" required />
          </Field>
          <Field label="Symbol (optional)" hint="A function, class or test title to find in the file.">
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </Field>
        </>
      ) : (
        <Field label="URL">
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" required />
        </Field>
      )}
      <Field label="Label (optional)">
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={140} />
      </Field>
      <ReasonField value={reason} onChange={setReason} required={false} />
    </Frame>
  );
}

/** `extra` carries the reference to remove, as JSON: the form sends it back as the event will record it. */
export function UnreferenceForm({ node, session, extra }: FormProps) {
  const [reason, setReason] = useState('');
  const ref = JSON.parse(extra ?? 'null') as Reference | null;
  if (!ref) return null;
  return (
    <Frame
      session={session}
      title={`Remove the reference to ${ref.label ?? describeTarget(ref.target)}`}
      sub="It is removed from now on; the past keeps it."
      verb="Remove"
      build={() => ({ type: 'node.unreference', data: { id: node.id, ref, reason: reason.trim() || null } })}
    >
      <ReasonField value={reason} onChange={setReason} required={false} />
    </Frame>
  );
}
