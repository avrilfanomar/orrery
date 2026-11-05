// Every way the model evolves, as one dialog per command. Changes that alter
// how something is judged (definition, priority, structure, lifecycle) ask
// for a reason; the server refuses them without one.
//
// This file is only the shell: the <dialog>, the mutation and the dispatch.
// Each action's fields and its command live in ./action-dialog/.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CommandInput, NodeView, OrreryEvent, UniverseView } from '@orrery/core';
import { useEffect, useRef, type ComponentType } from 'react';
import { api } from '../api.js';
import type { FormProps, Session } from './action-dialog/frame.js';
import { EditForm, PriorityForm, RedefineForm, RefineForm } from './action-dialog/node-forms.js';
import { DeprecateForm, LinkForm, MoveForm, ReactivateForm, UnlinkForm } from './action-dialog/placement-forms.js';
import { ReadingForm } from './action-dialog/reading-form.js';

export type Action = 'refine' | 'edit' | 'priority' | 'redefine' | 'move' | 'link' | 'unlink' | 'deprecate' | 'reactivate' | 'reading';

interface Props {
  action: Action;
  extra?: string;
  node: NodeView;
  view: UniverseView;
  actor: string;
  onClose: () => void;
  onDone: (events: OrreryEvent[]) => void;
}

const FORMS: Record<Action, ComponentType<FormProps>> = {
  refine: RefineForm,
  edit: EditForm,
  priority: PriorityForm,
  redefine: RedefineForm,
  move: MoveForm,
  link: LinkForm,
  unlink: UnlinkForm,
  deprecate: DeprecateForm,
  reactivate: ReactivateForm,
  reading: ReadingForm,
};

export function ActionDialog({ action, extra, node, view, actor, onClose, onDone }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const qc = useQueryClient();

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const mutation = useMutation({
    mutationFn: (cmd: CommandInput) => api.command(cmd, actor),
    onSuccess: async (res) => {
      await qc.invalidateQueries();
      onDone(res.events);
    },
  });

  const session: Session = {
    actor,
    pending: mutation.isPending,
    error: mutation.error,
    submit: mutation.mutate,
    cancel: () => ref.current?.close(),
  };
  const Form = FORMS[action];

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="dialog-title">
      <Form node={node} view={view} extra={extra} session={session} />
    </dialog>
  );
}
