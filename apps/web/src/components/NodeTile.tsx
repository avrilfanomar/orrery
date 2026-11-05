import { PASS_FAIL_UNIT, formatThreshold, formatValue, type NodeView } from '@orrery/core';
import { Counts, Coverage, KindTag, PriorityTag, Ribbon, Sparkline, StatusBadge } from './bits.js';

interface Props {
  node: NodeView;
  ribbonTimes: string[];
  via?: 'link';
  onOpen: (id: string) => void;
}

/** One contributor, summarised enough to decide whether to drill into it. */
export function NodeTile({ node, ribbonTimes, via, onOpen }: Props) {
  const ev = node.evaluation;
  const m = ev.measurement;
  const spec = node.definition.measure;
  const childCount = node.childIds.length + node.linkedFromIds.length;
  return (
    <button type="button" className={`tile edge-${ev.status}${node.lifecycle === 'deprecated' ? ' is-deprecated' : ''}`} onClick={() => onOpen(node.id)}>
      <span className="tile-top">
        <KindTag kind={node.kind} />
        <PriorityTag priority={node.priority} />
        {via === 'link' && <span className="tag tag-link" title="Primary home is elsewhere; it also counts here">linked</span>}
        {node.lifecycle === 'deprecated' && <span className="tag">deprecated</span>}
        {node.definitionCount > 1 && <span className="tag" title={`${node.definitionCount} definition versions`}>v{node.definitionCount}</span>}
      </span>
      <span className="tile-title">{node.title}</span>
      <span className="tile-status">
        <StatusBadge status={ev.status} size="sm" />
      </span>
      {spec ? (
        <span className="tile-measure">
          <span className="tile-value">{m?.value !== null && m?.value !== undefined ? formatValue(m.value, spec.unit) : '—'}</span>
          <span className="tile-target">{spec.unit === PASS_FAIL_UNIT ? 'latest run' : `target ${formatThreshold(spec, 'target')}`}</span>
          {node.spark && <Sparkline points={node.spark} unit={spec.unit} target={spec.target} />}
        </span>
      ) : (
        <span className="tile-agg">
          <Coverage {...ev.coverage} />
          {childCount > 0 ? <Counts counts={ev.counts} /> : <span className="hint">not refined yet</span>}
        </span>
      )}
      <span className="tile-reason">{ev.reason}</span>
      <Ribbon ribbon={node.ribbon} times={ribbonTimes} compact />
    </button>
  );
}
