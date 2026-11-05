// The forms that change what a node says or how it is judged.
import { bindingLanguage, KIND_LABELS, NODE_KINDS, SUGGESTED_CHILD_KINDS, type Dimension, type MeasureSpec, type NodeKind, type Priority, type RollupRule, type ScenarioSpec } from '@ru/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { BindingFields, MeasureFields, METRIC_DEFAULT, PASS_FAIL_DEFAULT, RollupFields, SCENARIO_DEFAULT, ScenarioFields, type BindingDraft, type SourceChoice } from './definition-fields.js';
import { DimensionPicker, Field, PriorityPicker, ReasonField } from './fields.js';
import { Frame, type FormProps } from './frame.js';

export function RefineForm({ node, session }: FormProps) {
  const childKinds = SUGGESTED_CHILD_KINDS[node.kind];
  const [kind, setKind] = useState<NodeKind>(childKinds[0] ?? 'requirement');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [dimensions, setDimensions] = useState<Dimension[]>(node.dimensions.filter((d) => d !== 'business'));
  const [measure, setMeasure] = useState<MeasureSpec>(node.definition.measure ?? METRIC_DEFAULT);
  const [rollup, setRollup] = useState<RollupRule>({ strategy: 'worst' });
  // Seeded from the parent's scenario, as before the split.
  const [scenario, setScenario] = useState<ScenarioSpec>(node.definition.scenario ?? SCENARIO_DEFAULT);
  const [reason, setReason] = useState('');

  // Refining into a scenario defaults to a pass/fail check; into a KPI, to a metric.
  useEffect(() => {
    if (kind === 'scenario') setMeasure(PASS_FAIL_DEFAULT);
    else if (kind === 'kpi') setMeasure(METRIC_DEFAULT);
  }, [kind]);

  const measured = kind === 'kpi' || kind === 'scenario';
  return (
    <Frame
      session={session}
      title={`Refine “${node.title}”`}
      sub="Add the next level of detail. Iterate: a rough stub now is better than nothing — it shows up as a visible gap until it is measurable."
      verb="Add"
      build={() => ({
        type: 'node.create',
        data: {
          kind,
          title,
          description,
          parentId: node.id,
          priority,
          dimensions,
          owner: owner.trim() || null,
          measure: measured ? measure : null,
          scenario: kind === 'scenario' ? scenario : null,
          rollup,
          reason: reason.trim() || null,
        },
      })}
    >
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
      {measured && <MeasureFields value={measure} onChange={setMeasure} />}
      {!measured && <RollupFields value={rollup} onChange={setRollup} />}
      <Field label="Owner (optional)">
        <input value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={80} />
      </Field>
      <ReasonField value={reason} onChange={setReason} required={false} />
    </Frame>
  );
}

export function EditForm({ node, session }: FormProps) {
  const [title, setTitle] = useState(node.title);
  const [description, setDescription] = useState(node.description);
  const [owner, setOwner] = useState(node.owner ?? '');
  const [dimensions, setDimensions] = useState<Dimension[]>(node.dimensions);
  const [dashboardUrl, setDashboardUrl] = useState(node.dashboardUrl ?? '');

  return (
    <Frame
      session={session}
      title="Edit wording"
      sub="Wording, owner and dimensions. These do not change how anything is judged."
      verb="Save"
      build={() => ({ type: 'node.edit', data: { id: node.id, title, description, owner: owner.trim() || null, dimensions, dashboardUrl: dashboardUrl.trim() || null } })}
    >
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
      <Field label="Dashboard link" hint="Where people look at this — a Grafana panel, say. Navigation only; never fetched.">
        <input type="url" value={dashboardUrl} onChange={(e) => setDashboardUrl(e.target.value)} placeholder="https://grafana.example.com/d/…" maxLength={2000} />
      </Field>
    </Frame>
  );
}

export function PriorityForm({ node, session }: FormProps) {
  const [priority, setPriority] = useState<Priority>(node.priority);
  const [reason, setReason] = useState('');

  return (
    <Frame
      session={session}
      title="Change priority"
      sub={`Currently ${node.priority}. Priority weights this node in weighted rollups and ranks it in every list.`}
      verb="Change priority"
      build={() => ({ type: 'node.reprioritize', data: { id: node.id, priority, reason } })}
    >
      <PriorityPicker value={priority} onChange={setPriority} />
      <ReasonField value={reason} onChange={setReason} />
    </Frame>
  );
}

export function RedefineForm({ node, session }: FormProps) {
  const def = node.definition;
  const [measure, setMeasure] = useState<MeasureSpec>(def.measure ?? METRIC_DEFAULT);
  const [hasMeasure, setHasMeasure] = useState(def.measure !== null);
  const [rollup, setRollup] = useState<RollupRule>(def.rollup);
  const [scenario, setScenario] = useState<ScenarioSpec>(def.scenario ?? SCENARIO_DEFAULT);
  const [binding, setBinding] = useState<BindingDraft>({
    on: def.binding !== null,
    language: def.binding?.language ?? '',
    sourceId: def.binding?.sourceId ?? '',
    query: def.binding?.query ?? '',
  });
  const [reason, setReason] = useState('');
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.sources });
  const languages = useMemo(() => sources.data?.languages ?? [], [sources.data]);
  const sourceChoices = useMemo(() => {
    const list: SourceChoice[] = sources.data?.sources.map((s) => ({ id: s.id, runs: s.runs })) ?? [];
    // Keep the current choice selectable even if this server no longer has it.
    const cur = def.binding;
    if (cur?.sourceId && !list.some((s) => s.id === cur.sourceId)) list.push({ id: cur.sourceId, runs: [cur.language] });
    return list;
  }, [sources.data, def.binding]);
  /** Only a language some installed kind can pull may name a source; any other query documents where the number comes from. */
  const builtBinding = () => {
    const language = bindingLanguage(binding.language, languages);
    const pullable = languages.some((l) => l.id === language && l.kinds.length > 0);
    return { sourceId: pullable ? binding.sourceId || null : null, language, query: binding.query };
  };

  const hasScenario = node.kind === 'scenario' || def.scenario;
  return (
    <Frame
      session={session}
      title={`Revise definition (v${def.version} → v${def.version + 1})`}
      sub={`Takes effect now. Readings already taken stay judged against v${def.version}; nothing is repainted.`}
      verb={`Publish v${def.version + 1}`}
      build={() => ({
        type: 'node.redefine',
        data: {
          id: node.id,
          measure: hasMeasure ? measure : null,
          rollup,
          ...(hasScenario ? { scenario } : {}),
          // A binding needs a measure, so dropping the measure drops it too.
          binding: hasMeasure && binding.on ? builtBinding() : null,
          reason,
        },
      })}
    >
      {hasScenario && <ScenarioFields value={scenario} onChange={setScenario} />}
      <label className="switch">
        <input type="checkbox" checked={hasMeasure} onChange={(e) => setHasMeasure(e.target.checked)} />
        This node has its own measure
      </label>
      {hasMeasure && <MeasureFields value={measure} onChange={setMeasure} />}
      {hasMeasure && <BindingFields value={binding} onChange={setBinding} sources={sourceChoices} languages={languages} />}
      <RollupFields value={rollup} onChange={setRollup} />
      <ReasonField value={reason} onChange={setReason} />
    </Frame>
  );
}
