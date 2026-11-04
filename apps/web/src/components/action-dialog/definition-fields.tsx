// The pieces of a node's definition: how it is measured, where the number
// comes from, how contributors roll up, and its quality scenario.
import { PASS_FAIL_UNIT, type MeasureSpec, type QueryLanguage, type RollupRule, type ScenarioSpec } from '@ru/core';
import type { ChangeEvent } from 'react';
import { Field } from './fields.js';

export const METRIC_DEFAULT: MeasureSpec = { unit: '%', direction: 'higher', target: 95, warn: 90, staleAfterHours: 24 };
export const PASS_FAIL_DEFAULT: MeasureSpec = { unit: PASS_FAIL_UNIT, direction: 'higher', target: 1, warn: 1, staleAfterHours: 24 * 8 };
export const SCENARIO_DEFAULT: ScenarioSpec = { stimulus: '', environment: '', response: '' };

export function MeasureFields({ value, onChange }: { value: MeasureSpec; onChange: (m: MeasureSpec) => void }) {
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

export interface BindingDraft {
  on: boolean;
  /** Carried through unchanged: re-labelling a probe as PromQL would log a new, wrong yardstick (ADR 0003). */
  language: QueryLanguage;
  sourceId: string;
  query: string;
}

/** Where the number comes from (ADR 0002). Part of the definition: a new query is a new yardstick. */
export function BindingFields({ value, onChange, sourceIds }: { value: BindingDraft; onChange: (b: BindingDraft) => void; sourceIds: string[] }) {
  const probe = value.language === 'probe';
  return (
    <fieldset className="group">
      <legend>Where the number comes from</legend>
      <label className="switch">
        <input type="checkbox" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} />
        Record the query behind it
      </label>
      {value.on && (
        <>
          {!probe && (
            <Field label="Source" hint={sourceIds.length ? 'Pick a source to have the server pull it; “none” only documents the query.' : 'No sources are configured on this server, so the query is documentation only.'}>
              <select value={value.sourceId} onChange={(e) => onChange({ ...value, sourceId: e.target.value })}>
                <option value="">none — documented only</option>
                {sourceIds.map((id) => (
                  <option key={id} value={id}>
                    {id} — pull it
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field
            label={probe ? 'Probe (id@version)' : 'PromQL query'}
            hint={
              probe
                ? 'Measured by `pnpm dogfood`, never pulled. A new version is a new method, so it starts a new yardstick.'
                : 'Must return one series in the measure’s unit — aggregate with sum(…) if needed. Changing it later starts a new version.'
            }
          >
            <textarea rows={3} className="mono" value={value.query} onChange={(e) => onChange({ ...value, query: e.target.value })} required maxLength={2000} spellCheck={false} />
          </Field>
        </>
      )}
    </fieldset>
  );
}

export function RollupFields({ value, onChange }: { value: RollupRule; onChange: (r: RollupRule) => void }) {
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

export function ScenarioFields({ value, onChange }: { value: ScenarioSpec; onChange: (s: ScenarioSpec) => void }) {
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
