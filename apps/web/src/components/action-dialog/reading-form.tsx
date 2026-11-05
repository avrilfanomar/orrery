import { PASS_FAIL_UNIT, formatThreshold } from '@orrery/core';
import { useState } from 'react';
import { Field } from './fields.js';
import { Frame, type FormProps } from './frame.js';

const localInputValue = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function ReadingForm({ node, session }: FormProps) {
  const def = node.definition;
  const measure = def.measure;
  const [value, setValue] = useState('');
  const [observedAt, setObservedAt] = useState(localInputValue(new Date()));
  const [source, setSource] = useState('manual');

  const passFail = measure?.unit === PASS_FAIL_UNIT;
  return (
    <Frame
      session={session}
      title="Record a reading"
      sub={measure ? `Judged against v${def.version}: target ${formatThreshold(measure, 'target')}, warning ${formatThreshold(measure, 'warn')}.` : ''}
      verb="Record"
      disabled={value === ''}
      build={() => {
        const v = passFail ? (value === 'pass' ? 1 : 0) : Number(value);
        return { type: 'reading.record', data: { nodeId: node.id, value: v, observedAt: new Date(observedAt).toISOString(), source } };
      }}
    >
      {measure && (
        <>
          {passFail ? (
            <div className="seg" role="radiogroup" aria-label="Result">
              {['pass', 'fail'].map((r) => (
                <button key={r} type="button" role="radio" aria-checked={value === r} className={value === r ? 'on' : ''} onClick={() => setValue(r)}>
                  {r}
                </button>
              ))}
            </div>
          ) : (
            <Field label={`Value (${measure.unit})`}>
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
    </Frame>
  );
}
