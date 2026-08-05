/**
 * Intent Analyzer and Visual Planning Agent outputs (Volume 03).
 *
 * Note what is closed and what is open. `intent` and `category` are enums
 * because each one selects downstream behaviour -- teaching intent drives stroke
 * ordering (Volume 13 §Teaching Intent), category drives layout strategy
 * (Volume 05 §Layout Strategies) -- so an unrecognised value has no handler and
 * must fail here rather than surface as a mystery later.
 *
 * `subject` and `domain` are open strings. The product requirement is that the
 * agent draws *anything*, and an enum of domains would be a list of the things
 * it cannot draw.
 */
import { z } from "zod";
import {
  SchemaVersionSchema,
  ImportanceSchema,
  DetailLevelSchema,
  MetadataSchema,
} from "./primitives";
import { RelationshipSchema } from "./relationships";

/** Instructional purpose (Volume 13 §Teaching Intent). */
export const TeachingIntentSchema = z.enum([
  "explain",
  "compare",
  "classify",
  "label",
  "demonstrate",
  "animate",
  "highlight",
]);
export type TeachingIntent = z.infer<typeof TeachingIntentSchema>;

/**
 * Diagram category. Each value maps to a layout strategy in Phase 6.
 * `freeform` is the honest escape hatch for a subject that fits no standard
 * shape -- it selects force-directed placement rather than failing.
 */
export const DiagramCategorySchema = z.enum([
  "schematic",
  "structural",
  "flow",
  "hierarchy",
  "cycle",
  "comparison",
  "timeline",
  "graph",
  "map",
  "freeform",
]);
export type DiagramCategory = z.infer<typeof DiagramCategorySchema>;

export const ComplexitySchema = z.enum(["simple", "moderate", "complex"]);
export type Complexity = z.infer<typeof ComplexitySchema>;

export const IntentModelSchema = z.object({
  version: SchemaVersionSchema,
  intent: TeachingIntentSchema,
  /** What is being drawn, in the user's terms. Open by design. */
  subject: z.string().min(1),
  /** Field of knowledge, e.g. `physics`. Open by design. */
  domain: z.string().min(1),
  category: DiagramCategorySchema,
  complexity: ComplexitySchema,
  /** What the learner should understand afterwards (Volume 03). */
  teachingObjective: z.string().min(1),
  /** The original user request, preserved for the agent's later reference. */
  rawRequest: z.string().min(1),
  metadata: MetadataSchema.optional(),
});
export type IntentModel = z.infer<typeof IntentModelSchema>;

const PlannedObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  importance: ImportanceSchema,
  /** Why this object earns space on the board. */
  rationale: z.string().optional(),
});

const PlannedLabelSchema = z.object({
  target: z.string().min(1),
  text: z.string().min(1),
  /** Named anchor on the target, if the label belongs to a part. */
  anchor: z.string().optional(),
});

const PlannedHighlightSchema = z.object({
  target: z.string().min(1),
  reason: z.string().min(1),
});

const PlannedAnimationSchema = z.object({
  target: z.string().min(1),
  /** A semantic behaviour the object exposes, e.g. `rotate` (Volume 04). */
  behavior: z.string().min(1),
});

/**
 * What should appear on the board, decided before anything semantic is modelled
 * (Volume 03 §Visual Planning Agent). No geometry.
 */
export const VisualPlanSchema = z.object({
  version: SchemaVersionSchema,
  detailLevel: DetailLevelSchema,
  /** A plan with no objects is a failed plan, not an empty diagram. */
  objects: z.array(PlannedObjectSchema).min(1),
  labels: z.array(PlannedLabelSchema).default([]),
  highlights: z.array(PlannedHighlightSchema).default([]),
  animations: z.array(PlannedAnimationSchema).default([]),
  /** Draw order by importance (Volume 13 §Visual Focus). */
  focusOrder: z.array(z.string().min(1)).default([]),
  metadata: MetadataSchema.optional(),
});
export type VisualPlan = z.infer<typeof VisualPlanSchema>;

const VILObjectSchema = z.object({
  id: z.string().min(1),
  /** Semantic type, e.g. `pulley`. Open -- the agent invents types (AD-5). */
  type: z.string().min(1),
  /** This object's job in the diagram, e.g. `load`, `support`. */
  role: z.string().min(1),
  importance: ImportanceSchema,
  labels: z.array(z.string().min(1)).default([]),
  behaviors: z.array(z.string().min(1)).default([]),
  /** Parameters that influence semantics, not rendering (Volume 14). */
  parameters: MetadataSchema.optional(),
});
export type VILObject = z.infer<typeof VILObjectSchema>;

const VILAnnotationSchema = z.object({
  id: z.string().min(1),
  target: z.string().min(1),
  text: z.string().min(1),
  anchor: z.string().optional(),
});

/**
 * Visual Intent Language (Volume 13): the contract between AI reasoning and the
 * deterministic engine. Describes what should be visualised, never how.
 */
export const VILSchema = z.object({
  version: SchemaVersionSchema,
  intent: TeachingIntentSchema,
  subject: z.string().min(1),
  /** Audience and situational context, e.g. grade level, prior knowledge. */
  context: MetadataSchema.default({}),
  objects: z.array(VILObjectSchema).min(1),
  relationships: z.array(RelationshipSchema).default([]),
  annotations: z.array(VILAnnotationSchema).default([]),
  /** Object ids to emphasise, in order. */
  emphasis: z.array(z.string().min(1)).default([]),
  metadata: MetadataSchema.default({}),
});
export type VIL = z.infer<typeof VILSchema>;
