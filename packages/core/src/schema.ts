// Runtime schemas for everything that crosses a boundary: the stored event log
// and the commands the API accepts. Types are inferred from here so the schema
// and the type can never disagree.
import { z } from 'zod';
import { DIMENSIONS, NODE_KINDS, PRIORITIES } from './constants.js';

export const NodeIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Ids are 1–64 lowercase letters, digits and dashes');

const IsoSchema = z.string().datetime({ offset: true });

/** Every evolutionary change carries its reason, so "why did this go red?" stays answerable. */
const ReasonSchema = z.string().trim().min(3, 'Give a reason — every change to the model is kept with its why').max(500);

const TitleSchema = z.string().trim().min(1, 'A title is required').max(140);
const DescriptionSchema = z.string().max(4000);
const OwnerSchema = z.string().trim().max(80).nullable();
const PrioritySchema = z.enum(PRIORITIES);
const DimensionsSchema = z.array(z.enum(DIMENSIONS)).max(DIMENSIONS.length);

export const MeasureSpecSchema = z
  .object({
    unit: z.string().trim().min(1).max(24),
    direction: z.enum(['higher', 'lower']),
    target: z.number().finite(),
    warn: z.number().finite(),
    staleAfterHours: z.number().positive().max(24 * 400),
  })
  .refine((m) => (m.direction === 'higher' ? m.warn <= m.target : m.warn >= m.target), {
    message: 'The warning threshold must sit on the bad side of the target',
    path: ['warn'],
  });
export type MeasureSpec = z.infer<typeof MeasureSpecSchema>;

export const ScenarioSpecSchema = z.object({
  stimulus: z.string().trim().min(1).max(500),
  environment: z.string().trim().max(500),
  response: z.string().trim().min(1).max(500),
});
export type ScenarioSpec = z.infer<typeof ScenarioSpecSchema>;

export const RollupRuleSchema = z
  .discriminatedUnion('strategy', [
    z.object({ strategy: z.literal('worst') }),
    z.object({ strategy: z.literal('weighted'), okAt: z.number().min(0).max(1), warnAt: z.number().min(0).max(1) }),
    z.object({ strategy: z.literal('quorum'), okShare: z.number().gt(0).max(1), warnShare: z.number().min(0).max(1) }),
  ])
  .superRefine((r, ctx) => {
    if (r.strategy === 'weighted' && r.warnAt > r.okAt) {
      ctx.addIssue({ code: 'custom', message: 'The warning score must not exceed the on-target score' });
    }
    if (r.strategy === 'quorum' && r.warnShare > r.okShare) {
      ctx.addIssue({ code: 'custom', message: 'The warning share must not exceed the on-target share' });
    }
  });
export type RollupRule = z.infer<typeof RollupRuleSchema>;

// ---------------------------------------------------------------------------
// Event payloads — the append-only log is the source of truth (ADR 0001, decision 4).
// ---------------------------------------------------------------------------

const NodeCreatedData = z.object({
  id: NodeIdSchema,
  kind: z.enum(NODE_KINDS),
  title: TitleSchema,
  description: DescriptionSchema,
  parentId: NodeIdSchema.nullable(),
  links: z.array(NodeIdSchema).max(20),
  priority: PrioritySchema,
  dimensions: DimensionsSchema,
  owner: OwnerSchema,
  measure: MeasureSpecSchema.nullable(),
  rollup: RollupRuleSchema,
  scenario: ScenarioSpecSchema.nullable(),
  reason: z.string().trim().max(500).nullable(),
});

const NodeEditedData = z.object({
  id: NodeIdSchema,
  title: TitleSchema.optional(),
  description: DescriptionSchema.optional(),
  owner: OwnerSchema.optional(),
  dimensions: DimensionsSchema.optional(),
});

const NodeRedefinedData = z.object({
  id: NodeIdSchema,
  measure: MeasureSpecSchema.nullable().optional(),
  rollup: RollupRuleSchema.optional(),
  scenario: ScenarioSpecSchema.nullable().optional(),
  reason: ReasonSchema,
});

const NodeReprioritizedData = z.object({ id: NodeIdSchema, priority: PrioritySchema, reason: ReasonSchema });
const NodeMovedData = z.object({ id: NodeIdSchema, parentId: NodeIdSchema.nullable(), reason: ReasonSchema });
const NodeLinkData = z.object({ id: NodeIdSchema, target: NodeIdSchema, reason: ReasonSchema });
const NodeLifecycleData = z.object({ id: NodeIdSchema, reason: ReasonSchema });

const ReadingRecordedData = z.object({
  nodeId: NodeIdSchema,
  value: z.number().finite(),
  observedAt: IsoSchema,
  source: z.string().trim().min(1).max(80),
});

function envelope<T extends string, D extends z.ZodTypeAny>(type: T, data: D) {
  return z.object({
    seq: z.number().int().positive(),
    at: IsoSchema,
    actor: z.string().min(1).max(80),
    type: z.literal(type),
    data,
  });
}

export const EventSchema = z.discriminatedUnion('type', [
  envelope('node.created', NodeCreatedData),
  envelope('node.edited', NodeEditedData),
  envelope('node.redefined', NodeRedefinedData),
  envelope('node.reprioritized', NodeReprioritizedData),
  envelope('node.moved', NodeMovedData),
  envelope('node.linked', NodeLinkData),
  envelope('node.unlinked', NodeLinkData),
  envelope('node.deprecated', NodeLifecycleData),
  envelope('node.reactivated', NodeLifecycleData),
  envelope('reading.recorded', ReadingRecordedData),
]);
export type RuEvent = z.infer<typeof EventSchema>;
export type EventType = RuEvent['type'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the store has given it a sequence number. */
export type NewEvent = DistributiveOmit<RuEvent, 'seq'>;

// ---------------------------------------------------------------------------
// Commands — what a person or an integration asks for. `decide` turns a valid
// command into events, or refuses it.
// ---------------------------------------------------------------------------

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('node.create'),
    data: NodeCreatedData.extend({
      id: NodeIdSchema.optional(),
      description: DescriptionSchema.default(''),
      parentId: NodeIdSchema.nullable().default(null),
      links: z.array(NodeIdSchema).max(20).default([]),
      priority: PrioritySchema.default('medium'),
      dimensions: DimensionsSchema.default([]),
      owner: OwnerSchema.default(null),
      measure: MeasureSpecSchema.nullable().default(null),
      rollup: RollupRuleSchema.default({ strategy: 'worst' }),
      scenario: ScenarioSpecSchema.nullable().default(null),
      reason: z.string().trim().max(500).nullable().default(null),
    }),
  }),
  z.object({ type: z.literal('node.edit'), data: NodeEditedData }),
  z.object({ type: z.literal('node.redefine'), data: NodeRedefinedData }),
  z.object({ type: z.literal('node.reprioritize'), data: NodeReprioritizedData }),
  z.object({ type: z.literal('node.move'), data: NodeMovedData }),
  z.object({ type: z.literal('node.link'), data: NodeLinkData }),
  z.object({ type: z.literal('node.unlink'), data: NodeLinkData }),
  z.object({ type: z.literal('node.deprecate'), data: NodeLifecycleData }),
  z.object({ type: z.literal('node.reactivate'), data: NodeLifecycleData }),
  z.object({
    type: z.literal('reading.record'),
    data: z.object({
      nodeId: NodeIdSchema,
      value: z.number().finite(),
      observedAt: IsoSchema.optional(),
      source: z.string().trim().min(1).max(80).default('manual'),
    }),
  }),
]);
/** A command as a caller writes it (defaults may be omitted). */
export type CommandInput = z.input<typeof CommandSchema>;
/** A command after validation, with defaults filled in. */
export type Command = z.output<typeof CommandSchema>;
