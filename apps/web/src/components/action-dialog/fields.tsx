// Small, stateless form controls shared by every action form.
import { DIMENSIONS, KIND_LABELS, PRIORITIES, type Dimension, type Priority, type UniverseView } from '@ru/core';
import type { ReactNode } from 'react';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function ReasonField({ value, onChange, required = true }: { value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <Field label={required ? 'Why? (kept with the change)' : 'Why now? (optional)'} hint={required ? 'Future readers will see this next to the change.' : undefined}>
      <textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} required={required} minLength={required ? 3 : undefined} />
    </Field>
  );
}

export function DimensionPicker({ value, onChange }: { value: Dimension[]; onChange: (d: Dimension[]) => void }) {
  return (
    <fieldset className="group">
      <legend>Quality dimensions</legend>
      <div className="chips">
        {DIMENSIONS.map((d) => (
          <button
            key={d}
            type="button"
            className={`chip-toggle${value.includes(d) ? ' on' : ''}`}
            aria-pressed={value.includes(d)}
            onClick={() => onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d])}
          >
            {d}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function PriorityPicker({ value, onChange }: { value: Priority; onChange: (p: Priority) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label="Priority">
      {PRIORITIES.map((p) => (
        <button key={p} type="button" role="radio" aria-checked={value === p} className={value === p ? 'on' : ''} onClick={() => onChange(p)}>
          {p}
        </button>
      ))}
    </div>
  );
}

export function NodePicker({ view, exclude, value, onChange }: { view: UniverseView; exclude: Set<string>; value: string; onChange: (id: string) => void }) {
  const options = Object.values(view.nodes)
    .filter((n) => n.lifecycle === 'active' && !exclude.has(n.id))
    .sort((a, b) => a.title.localeCompare(b.title));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} required>
      <option value="" disabled>
        Choose a node…
      </option>
      {options.map((n) => (
        <option key={n.id} value={n.id}>
          {KIND_LABELS[n.kind]} — {n.title}
        </option>
      ))}
    </select>
  );
}
