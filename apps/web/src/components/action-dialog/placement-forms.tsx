// The forms that change where a node sits or whether it counts. All of them
// change how something is judged, so all of them ask for a reason.
import type { UniverseView } from '@orrery/core';
import { useMemo, useState } from 'react';
import { Field, NodePicker, ReasonField } from './fields.js';
import { Frame, type FormProps } from './frame.js';

/** Everything that contributes, directly or transitively, to `id` — illegal new parents for it. */
function contributorsOf(view: UniverseView, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = view.nodes[stack.pop()!];
    if (!cur) continue;
    for (const c of [...cur.childIds, ...cur.linkedFromIds]) {
      if (!out.has(c)) {
        out.add(c);
        stack.push(c);
      }
    }
  }
  return out;
}

/** Move and link share a picker; they differ in what is already taken. */
function PlaceForm({ mode, node, view, session }: FormProps & { mode: 'move' | 'link' }) {
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const exclusions = useMemo(() => {
    const ex = contributorsOf(view, node.id);
    ex.add(node.id);
    if (node.parentId) ex.add(node.parentId);
    node.links.forEach((l) => ex.add(l));
    return ex;
  }, [view, node]);

  const move = mode === 'move';
  return (
    <Frame
      session={session}
      title={move ? 'Move' : 'Also count it elsewhere'}
      sub={
        move
          ? 'Give it a different primary parent. The old placement stays in the history.'
          : 'A link makes this node contribute to a second parent without leaving its home — for example, one KPI evidencing two requirements.'
      }
      verb={move ? 'Move' : 'Link'}
      build={() => (move ? { type: 'node.move', data: { id: node.id, parentId: target, reason } } : { type: 'node.link', data: { id: node.id, target, reason } })}
    >
      <Field label={move ? 'New parent' : 'Also contributes to'} hint="Nodes that already contribute to this one are not offered — that would be a cycle.">
        <NodePicker view={view} exclude={exclusions} value={target} onChange={setTarget} />
      </Field>
      <ReasonField value={reason} onChange={setReason} />
    </Frame>
  );
}

export const MoveForm = (p: FormProps) => <PlaceForm mode="move" {...p} />;
export const LinkForm = (p: FormProps) => <PlaceForm mode="link" {...p} />;

/** Unlink, deprecate and reactivate carry nothing but a reason. */
function ReasonOnlyForm({ node, view, session, extra, mode }: FormProps & { mode: 'unlink' | 'deprecate' | 'reactivate' }) {
  const [reason, setReason] = useState('');
  const target = extra ?? '';

  const copy = {
    unlink: { title: `Stop counting it toward “${view.nodes[target]?.title ?? target}”`, sub: 'The link is removed from now on; the past keeps it.', verb: 'Unlink' },
    deprecate: { title: 'Deprecate', sub: 'It stays in the history and in time travel, but stops counting toward its parent from now on.', verb: 'Deprecate' },
    reactivate: { title: 'Reactivate', sub: 'It counts toward its parent again from now on.', verb: 'Reactivate' },
  }[mode];
  return (
    <Frame
      session={session}
      {...copy}
      build={() => (mode === 'unlink' ? { type: 'node.unlink', data: { id: node.id, target, reason } } : { type: mode === 'deprecate' ? 'node.deprecate' : 'node.reactivate', data: { id: node.id, reason } })}
    >
      <ReasonField value={reason} onChange={setReason} />
    </Frame>
  );
}

export const UnlinkForm = (p: FormProps) => <ReasonOnlyForm mode="unlink" {...p} />;
export const DeprecateForm = (p: FormProps) => <ReasonOnlyForm mode="deprecate" {...p} />;
export const ReactivateForm = (p: FormProps) => <ReasonOnlyForm mode="reactivate" {...p} />;
