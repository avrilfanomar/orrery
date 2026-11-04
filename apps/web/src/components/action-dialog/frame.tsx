// What every action form shares: heading, submit-to-command wiring, error and footer.
import type { CommandInput, NodeView, UniverseView } from '@ru/core';
import type { ReactNode } from 'react';

/** What the dialog shell lends each form: who is acting and how to send a command. */
export interface Session {
  actor: string;
  pending: boolean;
  error: Error | null;
  submit: (cmd: CommandInput) => void;
  cancel: () => void;
}

export interface FormProps {
  node: NodeView;
  view: UniverseView;
  session: Session;
  /** The unlink target, when the action needs one chosen elsewhere. */
  extra?: string;
}

interface FrameProps {
  session: Session;
  title: string;
  sub: string;
  verb: string;
  /** Builds the command from the form state; called only on submit. */
  build: () => CommandInput;
  disabled?: boolean;
  children: ReactNode;
}

export function Frame({ session, title, sub, verb, build, disabled = false, children }: FrameProps) {
  return (
    <form
      method="dialog"
      onSubmit={(e) => {
        e.preventDefault();
        session.submit(build());
      }}
    >
      <h2 id="dialog-title">{title}</h2>
      <p className="sub">{sub}</p>

      {children}

      {session.error && (
        <p className="error" role="alert">
          {session.error.message}
        </p>
      )}

      <footer>
        <span className="muted">as {session.actor}</span>
        <button type="button" className="btn" onClick={session.cancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={session.pending || disabled}>
          {session.pending ? 'Saving…' : verb}
        </button>
      </footer>
    </form>
  );
}
