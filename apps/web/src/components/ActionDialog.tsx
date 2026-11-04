// Every way the model evolves, as one dialog per command. Changes that alter
// how something is judged (definition, priority, structure, lifecycle) ask
// for a reason; the server refuses them without one.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DIMENSIONS,
  KIND_LABELS,
  NODE_KINDS,
  PASS_FAIL_UNIT,
  PRIORITIES,
  SUGGESTED_CHILD_KINDS,
  formatThreshold,
  type CommandInput,
  type Dimension,
  type MeasureSpec,
  type NodeKind,
  type NodeView,
  type Priority,
  type RollupRule,
  type RuEvent,
  type ScenarioSpec,
  type UniverseView,
} from '@ru/core';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { api } from '../api.js';

export type Action = 'refine' | 'edit' | 'priority' | 'redefine' | 'move' | 'link' | 'unlink' | 'deprecate' | 'reactivate' | 'reading';

interface Props {
  action: Action;
  extra?: string;
  node: NodeView;
  view: UniverseView;
  actor: string;
  onClose: () => void;
  onDone: (events: RuEvent[]) => void;
}

const METRIC_DEFAULT: MeasureSpec = { unit: '%', direction: 'higher', target: 95, warn: 90, staleAfterHours: 24 };
const PASS_FAIL_DEFAULT: MeasureSpec = { unit: PASS_FAIL_UNIT, direction: 'higher', target: 1, warn: 1, staleAfterHours: 24 * 8 };
const SCENARIO_DEFAULT: ScenarioSpec = { stimulus: '', environment: '', response: '' };

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

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function ReasonField({ value, onChange, required = true }: { value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <Field label={required ? 'Why? (kept with the change)' : 'Why now? (optional)'} hint={required ? 'Future readers will see this next to the change.' : undefined}>
      <textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} required={required} minLength={required ? 3 : undefined} />
    </Field>
  );
}

function MeasureFields({ value, onChange }: { value: MeasureSpec; onChange: (m: MeasureSpec) => void }) {
  const passFail = value.unit === PASS_FAIL_UNIT;
  const num = (k: 'target' | 'warn' | 'staleAfterHours') => (e: ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: Number(e.target.value) });
  return (
    <fieldset className="group">
      <legend>How it is measured</legend>
      <div className="seg" role="radiogroup" aria-label="Measure type">
        <button type="button" className={!passFail ? 'on' : ''} onClick={() => onChange(passFail ? METRIC_DEFAULT : value)}>
          Metric with target
        </button>
        <button type="button" className={passFail ? 'on' : ''} onClick={() => onChange({ ...PASS_FAIL_DEFAULT, staleAfterHours: value.staleAfterHours })}>
          Pass/fail check
        </button>
      </div>
      {!passFail && (
        <div className="grid-4">
          <Field label="Unit">
            <input value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value })} required maxLength={24} />
          </Field>
          <Field label="Better when">
            <select value={value.direction} onChange={(e) => onChange({ ...value, direction: e.target.value as MeasureSpec['direction'] })}>
              <option value="higher">higher</option>
              <option value="lower">lower</option>
            </select>
          </Field>
          <Field label="Target">
            <input type="number" step="any" value={value.target} onChange={num('target')} required />
          </Field>
          <Field label="Warning until" hint="Beyond this it is a breach">
            <input type="number" step="any" value={value.warn} onChange={num('warn')} required />
          </Field>
        </div>
      )}
      <Field label="Unknown when the latest reading is older than (hours)" hint="Unmeasured is never green.">
        <input type="number" min={1} step="any" value={value.staleAfterHours} onChange={num('staleAfterHours')} required />
      </Field>
    </fieldset>
  );
}

function RollupFields({ value, onChange }: { value: RollupRule; onChange: (r: RollupRule) => void }) {
  const pct = (v: number) => Math.round(v * 100);
  return (
    <fieldset className="group">
      <legend>How contributors roll up</legend>
      <select
        value={value.strategy}
        onChange={(e) => {
          const s = e.target.value as RollupRule['strategy'];
          onChange(s === 'worst' ? { strategy: 'worst' } : s === 'weighted' ? { strategy: 'weighted', okAt: 0.9, warnAt: 0.6 } : { strategy: 'quorum', okShare: 0.75, warnShare: 0.5 });
        }}
      >
        <option value="worst">Worst of — any problem below shows here</option>
        <option value="weighted">Priority-weighted score — critical breaches still veto</option>
        <option value="quorum">Quorum — healthy when enough contributors are</option>
      </select>
      {value.strategy === 'weighted' && (
        <div className="grid-2">
          <Field label="On target from score (%)">
            <input type="number" min={0} max={100} value={pct(value.okAt)} onChange={(e) => onChange({ ...value, okAt: Number(e.target.value) / 100 })} />
          </Field>
          <Field label="Warning from score (%)">
            <input type="number" min={0} max={100} value={pct(value.warnAt)} onChange={(e) => onChange({ ...value, warnAt: Number(e.target.value) / 100 })} />
          </Field>
        </div>
      )}
      {value.strategy === 'quorum' && (
        <div className="grid-2">
          <Field label="On target when this share is (%)">
            <input type="number" min={1} max={100} value={pct(value.okShare)} onChange={(e) => onChange({ ...value, okShare: Number(e.target.value) / 100 })} />
          </Field>
          <Field label="Warning when this share is (%)">
            <input type="number" min={0} max={100} value={pct(value.warnShare)} onChange={(e) => onChange({ ...value, warnShare: Number(e.target.value) / 100 })} />
          </Field>
        </div>
      )}
    </fieldset>
  );
}

function ScenarioFields({ value, onChange }: { value: ScenarioSpec; onChange: (s: ScenarioSpec) => void }) {
  return (
    <fieldset className="group">
      <legend>Quality scenario</legend>
      <Field label="Stimulus — what happens">
        <textarea rows={2} value={value.stimulus} onChange={(e) => onChange({ ...value, stimulus: e.target.value })} required />
      </Field>
      <Field label="Environment — under which conditions, checked how">
        <input value={value.environment} onChange={(e) => onChange({ ...value, environment: e.target.value })} />
      </Field>
      <Field label="Expected response — what must hold">
        <textarea rows={2} value={value.response} onChange={(e) => onChange({ ...value, response: e.target.value })} required />
      </Field>
    </fieldset>
  );
}

function DimensionPicker({ value, onChange }: { value: Dimension[]; onChange: (d: Dimension[]) => void }) {
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

function PriorityPicker({ value, onChange }: { value: Priority; onChange: (p: Priority) => void }) {
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

function NodePicker({ view, exclude, value, onChange }: { view: UniverseView; exclude: Set<string>; value: string; onChange: (id: string) => void }) {
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

const localInputValue = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function ActionDialog({ action, extra, node, view, actor, onClose, onDone }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const qc = useQueryClient();
  const def = node.definition;

  // One bag of form state; each action reads the fields it needs.
  const childKinds = SUGGESTED_CHILD_KINDS[node.kind];
  const [kind, setKind] = useState<NodeKind>(childKinds[0] ?? 'requirement');
  const [title, setTitle] = useState(action === 'edit' ? node.title : '');
  const [description, setDescription] = useState(action === 'edit' ? node.description : '');
  const [owner, setOwner] = useState(action === 'edit' ? (node.owner ?? '') : '');
  const [priority, setPriority] = useState<Priority>(action === 'priority' ? node.priority : 'medium');
  const [dimensions, setDimensions] = useState<Dimension[]>(action === 'edit' ? node.dimensions : node.dimensions.filter((d) => d !== 'business'));
  const [measure, setMeasure] = useState<MeasureSpec>(def.measure ?? METRIC_DEFAULT);
  const [hasMeasure, setHasMeasure] = useState(def.measure !== null);
  const [rollup, setRollup] = useState<RollupRule>(action === 'redefine' ? def.rollup : { strategy: 'worst' });
  const [scenario, setScenario] = useState<ScenarioSpec>(def.scenario ?? SCENARIO_DEFAULT);
  const [target, setTarget] = useState(action === 'unlink' ? (extra ?? '') : '');
  const [reason, setReason] = useState('');
  const [value, setValue] = useState('');
  const [observedAt, setObservedAt] = useState(localInputValue(new Date()));
  const [source, setSource] = useState('manual');

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  // Refining into a scenario defaults to a pass/fail check; into a KPI, to a metric.
  useEffect(() => {
    if (action !== 'refine') return;
    if (kind === 'scenario') setMeasure(PASS_FAIL_DEFAULT);
    else if (kind === 'kpi') setMeasure(METRIC_DEFAULT);
  }, [kind, action]);

  const exclusions = useMemo(() => {
    const ex = contributorsOf(view, node.id);
    ex.add(node.id);
    if (action === 'move' && node.parentId) ex.add(node.parentId);
    if (action === 'link') {
      if (node.parentId) ex.add(node.parentId);
      node.links.forEach((l) => ex.add(l));
    }
    if (action === 'move') node.links.forEach((l) => ex.add(l));
    return ex;
  }, [view, node, action]);

  const mutation = useMutation({
    mutationFn: (cmd: CommandInput) => api.command(cmd, actor),
    onSuccess: async (res) => {
      await qc.invalidateQueries();
      onDone(res.events);
    },
  });

  const build = (): CommandInput => {
    const id = node.id;
    switch (action) {
      case 'refine': {
        const measured = kind === 'kpi' || kind === 'scenario';
        return {
          type: 'node.create',
          data: {
            kind,
            title,
            description,
            parentId: id,
            priority,
            dimensions,
            owner: owner.trim() || null,
            measure: measured ? measure : null,
            scenario: kind === 'scenario' ? scenario : null,
            rollup,
            reason: reason.trim() || null,
          },
        };
      }
      case 'edit':
        return { type: 'node.edit', data: { id, title, description, owner: owner.trim() || null, dimensions } };
      case 'priority':
        return { type: 'node.reprioritize', data: { id, priority, reason } };
      case 'redefine':
        return {
          type: 'node.redefine',
          data: {
            id,
            measure: hasMeasure ? measure : null,
            rollup,
            ...(node.kind === 'scenario' || def.scenario ? { scenario } : {}),
            reason,
          },
        };
      case 'move':
        return { type: 'node.move', data: { id, parentId: target, reason } };
      case 'link':
        return { type: 'node.link', data: { id, target, reason } };
      case 'unlink':
        return { type: 'node.unlink', data: { id, target, reason } };
      case 'deprecate':
        return { type: 'node.deprecate', data: { id, reason } };
      case 'reactivate':
        return { type: 'node.reactivate', data: { id, reason } };
      case 'reading': {
        const v = def.measure?.unit === PASS_FAIL_UNIT ? (value === 'pass' ? 1 : 0) : Number(value);
        return { type: 'reading.record', data: { nodeId: id, value: v, observedAt: new Date(observedAt).toISOString(), source } };
      }
    }
  };

  const copy: Record<Action, { title: string; sub: string; verb: string }> = {
    refine: { title: `Refine “${node.title}”`, sub: 'Add the next level of detail. Iterate: a rough stub now is better than nothing — it shows up as a visible gap until it is measurable.', verb: 'Add' },
    edit: { title: 'Edit wording', sub: 'Wording, owner and dimensions. These do not change how anything is judged.', verb: 'Save' },
    priority: { title: 'Change priority', sub: `Currently ${node.priority}. Priority weights this node in weighted rollups and ranks it in every list.`, verb: 'Change priority' },
    redefine: { title: `Revise definition (v${def.version} → v${def.version + 1})`, sub: `Takes effect now. Readings already taken stay judged against v${def.version}; nothing is repainted.`, verb: `Publish v${def.version + 1}` },
    move: { title: 'Move', sub: 'Give it a different primary parent. The old placement stays in the history.', verb: 'Move' },
    link: { title: 'Also count it elsewhere', sub: 'A link makes this node contribute to a second parent without leaving its home — for example, one KPI evidencing two requirements.', verb: 'Link' },
    unlink: { title: `Stop counting it toward “${view.nodes[target]?.title ?? target}”`, sub: 'The link is removed from now on; the past keeps it.', verb: 'Unlink' },
    deprecate: { title: 'Deprecate', sub: 'It stays in the history and in time travel, but stops counting toward its parent from now on.', verb: 'Deprecate' },
    reactivate: { title: 'Reactivate', sub: 'It counts toward its parent again from now on.', verb: 'Reactivate' },
    reading: { title: 'Record a reading', sub: def.measure ? `Judged against v${def.version}: target ${formatThreshold(def.measure, 'target')}, warning ${formatThreshold(def.measure, 'warn')}.` : '', verb: 'Record' },
  };
  const c = copy[action];

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="dialog-title">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(build());
        }}
      >
        <h2 id="dialog-title">{c.title}</h2>
        <p className="sub">{c.sub}</p>

        {action === 'refine' && (
          <>
            <Field label="Kind">
              <div className="seg">
                {[...childKinds, ...NODE_KINDS.filter((k) => !childKinds.includes(k) && k !== 'product')].map((k) => (
                  <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                    {KIND_LABELS[k]}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Title">
              <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={140} autoFocus placeholder={kind === 'kpi' ? 'e.g. Zero-result search rate' : 'Short and testable'} />
            </Field>
            <Field label="Description (optional)">
              <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="Priority">
              <PriorityPicker value={priority} onChange={setPriority} />
            </Field>
            <DimensionPicker value={dimensions} onChange={setDimensions} />
            {kind === 'scenario' && <ScenarioFields value={scenario} onChange={setScenario} />}
            {(kind === 'kpi' || kind === 'scenario') && <MeasureFields value={measure} onChange={setMeasure} />}
            {kind !== 'kpi' && kind !== 'scenario' && <RollupFields value={rollup} onChange={setRollup} />}
            <Field label="Owner (optional)">
              <input value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={80} />
            </Field>
            <ReasonField value={reason} onChange={setReason} required={false} />
          </>
        )}

        {action === 'edit' && (
          <>
            <Field label="Title">
              <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={140} />
            </Field>
            <Field label="Description">
              <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="Owner">
              <input value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={80} />
            </Field>
            <DimensionPicker value={dimensions} onChange={setDimensions} />
          </>
        )}

        {action === 'priority' && (
          <>
            <PriorityPicker value={priority} onChange={setPriority} />
            <ReasonField value={reason} onChange={setReason} />
          </>
        )}

        {action === 'redefine' && (
          <>
            {(node.kind === 'scenario' || def.scenario) && <ScenarioFields value={scenario} onChange={setScenario} />}
            <label className="switch">
              <input type="checkbox" checked={hasMeasure} onChange={(e) => setHasMeasure(e.target.checked)} />
              This node has its own measure
            </label>
            {hasMeasure && <MeasureFields value={measure} onChange={setMeasure} />}
            <RollupFields value={rollup} onChange={setRollup} />
            <ReasonField value={reason} onChange={setReason} />
          </>
        )}

        {(action === 'move' || action === 'link') && (
          <>
            <Field label={action === 'move' ? 'New parent' : 'Also contributes to'} hint="Nodes that already contribute to this one are not offered — that would be a cycle.">
              <NodePicker view={view} exclude={exclusions} value={target} onChange={setTarget} />
            </Field>
            <ReasonField value={reason} onChange={setReason} />
          </>
        )}

        {(action === 'unlink' || action === 'deprecate' || action === 'reactivate') && <ReasonField value={reason} onChange={setReason} />}

        {action === 'reading' && def.measure && (
          <>
            {def.measure.unit === PASS_FAIL_UNIT ? (
              <div className="seg" role="radiogroup" aria-label="Result">
                {['pass', 'fail'].map((r) => (
                  <button key={r} type="button" role="radio" aria-checked={value === r} className={value === r ? 'on' : ''} onClick={() => setValue(r)}>
                    {r}
                  </button>
                ))}
              </div>
            ) : (
              <Field label={`Value (${def.measure.unit})`}>
                <input type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
              </Field>
            )}
            <div className="grid-2">
              <Field label="Observed at">
                <input type="datetime-local" value={observedAt} onChange={(e) => setObservedAt(e.target.value)} required />
              </Field>
              <Field label="Source">
                <input value={source} onChange={(e) => setSource(e.target.value)} required maxLength={80} />
              </Field>
            </div>
          </>
        )}

        {mutation.error && (
          <p className="error" role="alert">
            {mutation.error.message}
          </p>
        )}

        <footer>
          <span className="muted">as {actor}</span>
          <button type="button" className="btn" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending || (action === 'reading' && value === '')}>
            {mutation.isPending ? 'Saving…' : c.verb}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
