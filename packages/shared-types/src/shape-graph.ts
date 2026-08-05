/**
 * Shape Graph (Volume 14): the semantic bridge between VIL and the Diagram AST.
 *
 * A Shape Graph represents *what a technical object is made of*. A house is a
 * roof above walls with a door inside them -- stated once, reusable everywhere,
 * with no coordinates anywhere.
 *
 * This is also where the Shape Intelligence Engine (Volume 10) registers what it
 * has learned. When the agent reasons about an object it has never drawn, the
 * result is a Shape Graph, and that graph is what makes the object reusable next
 * time instead of re-reasoned from scratch.
 */
import { z } from "zod";
import { SchemaVersionSchema, MetadataSchema } from "./primitives";
import { RelationshipTypeSchema } from "./relationships";

/** What a node stands for (Volume 14 §Graph Components). */
export const ShapeNodeKindSchema = z.enum([
  "object",
  "component",
  "label",
  "connector",
  "annotation",
]);
export type ShapeNodeKind = z.infer<typeof ShapeNodeKindSchema>;

/**
 * A named attachment point, e.g. a pulley's `rim` (Volume 04 §Anchors).
 * The name is semantic; the layout engine resolves it to a point.
 */
export const AnchorSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

export const SymmetrySchema = z.enum(["horizontal", "vertical", "radial", "rotational"]);
export type Symmetry = z.infer<typeof SymmetrySchema>;

/**
 * Repeated elements -- gear teeth, chain links, DNA base pairs
 * (Volume 14 §Repeating Structures). The count is semantic (a gear *has* twelve
 * teeth); the placement is the layout engine's problem.
 */
export const RepeatRuleSchema = z.object({
  count: z.number().int().positive(),
  symmetry: SymmetrySchema.optional(),
  /** Spacing as a relative multiple, never a distance in pixels. */
  spacingRatio: z.number().positive().optional(),
});
export type RepeatRule = z.infer<typeof RepeatRuleSchema>;

export const ShapeNodeSchema = z.object({
  id: z.string().min(1),
  kind: ShapeNodeKindSchema,
  /** Semantic type, e.g. `pulley`. Open -- the agent may invent one (AD-5). */
  type: z.string().min(1),
  /** Domain grouping, e.g. `mechanical`, `biology`. */
  category: z.string().min(1),
  /** This node's job within its parent, e.g. `support`, `load`. */
  role: z.string().min(1),
  anchors: z.array(AnchorSchema).default([]),
  behaviors: z.array(z.string().min(1)).default([]),
  /** Parameters influence semantics, not rendering (Volume 14 §Parametric). */
  parameters: MetadataSchema.optional(),
  repeat: RepeatRuleSchema.optional(),
  metadata: MetadataSchema.optional(),
});
export type ShapeNode = z.infer<typeof ShapeNodeSchema>;

export const ShapeEdgeSchema = z.object({
  id: z.string().min(1),
  type: RelationshipTypeSchema,
  from: z.string().min(1),
  to: z.string().min(1),
  metadata: MetadataSchema.optional(),
});
export type ShapeEdge = z.infer<typeof ShapeEdgeSchema>;

export const ShapeGraphSchema = z.object({
  version: SchemaVersionSchema,
  id: z.string().min(1),
  /** Id of the node representing the whole object. */
  root: z.string().min(1),
  nodes: z.array(ShapeNodeSchema).min(1),
  edges: z.array(ShapeEdgeSchema).default([]),
  /** Id of a shape this one extends (Volume 14 §Inheritance). */
  inherits: z.string().min(1).optional(),
  metadata: MetadataSchema.optional(),
});
export type ShapeGraph = z.infer<typeof ShapeGraphSchema>;
