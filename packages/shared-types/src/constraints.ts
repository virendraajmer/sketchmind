/**
 * Constraint Grammar and Constraint Graph (Volume 14 §Constraint Grammar,
 * Volume 05 §Constraint Graph).
 *
 * This is spatial *intent*: "the load hangs below the pulley". It is not
 * geometry -- there is no number here saying how far below. The layout solver
 * decides that in Phase 6, and it is the only component allowed to.
 *
 * Note this vocabulary is deliberately different from `RelationshipType`.
 * Relationships are semantic ("the rope wraps the pulley"); constraints are
 * spatial ("wrapAround"). Most map one-to-one, but not all -- `intersects` is a
 * meaningful relationship with no single spatial constraint, and `equalSpacing`
 * is a spatial constraint nobody states as a relationship. Collapsing the two
 * would lose whichever half had no counterpart.
 */
import { z } from "zod";
import { SchemaVersionSchema, MetadataSchema } from "./primitives";

/** The 15 constraint types of Volume 14. Plugins may register more. */
export const ConstraintTypeSchema = z.enum([
  "above",
  "below",
  "leftOf",
  "rightOf",
  "inside",
  "outside",
  "connectedTo",
  "attachedTo",
  "wrapAround",
  "parallelTo",
  "perpendicularTo",
  "centeredOn",
  "alignedWith",
  "equalSpacing",
  "mirrorOf",
]);
export type ConstraintType = z.infer<typeof ConstraintTypeSchema>;

/**
 * `required` constraints must hold or the layout fails. `preferred` ones may be
 * dropped when they conflict, which is what lets the solver produce a usable
 * diagram instead of no diagram when the agent over-specifies.
 */
export const ConstraintPrioritySchema = z.enum(["required", "preferred"]);
export type ConstraintPriority = z.infer<typeof ConstraintPrioritySchema>;

export const ConstraintSchema = z.object({
  id: z.string().min(1),
  type: ConstraintTypeSchema,
  from: z.string().min(1),
  to: z.string().min(1),
  priority: ConstraintPrioritySchema.default("required"),
  /**
   * Solver hints -- gap counts, spacing multiples, axis selection. Deliberately
   * unitless and unconstrained: these are relative quantities, not coordinates.
   */
  parameters: MetadataSchema.optional(),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

/** Nodes are object ids; edges are constraints (Volume 05 §Constraint Graph). */
export const ConstraintGraphSchema = z.object({
  version: SchemaVersionSchema,
  nodes: z.array(z.string().min(1)),
  constraints: z.array(ConstraintSchema).default([]),
  metadata: MetadataSchema.optional(),
});
export type ConstraintGraph = z.infer<typeof ConstraintGraphSchema>;
