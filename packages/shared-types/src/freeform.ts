/**
 * FreeformShape (AD-5): a one-off shape composed from geometric sub-primitives,
 * without registering a primitive manifest.
 *
 * Why this exists: the Primitive SDK (Volume 07) requires a registered,
 * versioned manifest per shape. That is right for a pulley, which will be drawn
 * a thousand times. It is ceremony for a lightning bolt the agent needs once, in
 * the middle of one diagram, and the ceremony is exactly what would make the
 * agent give up and draw a rectangle instead.
 *
 * ## The honest tradeoff
 *
 * Sub-parts are placed in **unit space**: a 0..1 box local to the shape, with no
 * connection to diagram coordinates. This is a deliberate, bounded relaxation of
 * "the model never emits coordinates" -- the model emits *proportions within a
 * shape it is inventing*, which is closer to describing an SVG viewBox than to
 * doing layout. It cannot position anything on the board this way; the layout
 * engine still decides where the shape goes and how large it is.
 *
 * The relaxation is bounded three ways: values outside 0..1 are rejected, a
 * FreeformShape may not contain another FreeformShape, and it is not part of the
 * Diagram AST -- it is referenced by id from an object's `properties`, so the
 * AST stays geometry-free and the purity test keeps passing.
 *
 * When a freeform shape gets reused, Phase 12's learning loop promotes it to a
 * registered primitive. That is the intended path from expedient to permanent.
 */
import { z } from "zod";
import { SchemaVersionSchema, MetadataSchema } from "./primitives";

/** Geometric building blocks. Deliberately fewer than the stroke types -- these
 * are shape parts, not drawing acts, so `erase` and `hatch` have no place. */
export const SubPrimitiveKindSchema = z.enum([
  "line",
  "polyline",
  "curve",
  "arc",
  "circle",
  "ellipse",
  "rectangle",
  "polygon",
]);
export type SubPrimitiveKind = z.infer<typeof SubPrimitiveKindSchema>;

/** A point in the shape's local 0..1 box. Never a diagram coordinate. */
export const UnitPointSchema = z.object({
  u: z.number().min(0).max(1),
  v: z.number().min(0).max(1),
});
export type UnitPoint = z.infer<typeof UnitPointSchema>;

export const SubPrimitiveSchema = z.object({
  id: z.string().min(1),
  kind: SubPrimitiveKindSchema,
  /** Control points in unit space, ordered as the pen would travel them. */
  points: z.array(UnitPointSchema).min(1),
  closed: z.boolean().default(false),
  /** Draw order within the shape; ascending, and it is the teaching order. */
  order: z.number().int().nonnegative().default(0),
});
export type SubPrimitive = z.infer<typeof SubPrimitiveSchema>;

export const FreeformShapeSchema = z.object({
  version: SchemaVersionSchema,
  id: z.string().min(1),
  /** Semantic name, e.g. `lightning-bolt`. Used when promoting to a primitive. */
  name: z.string().min(1),
  /** Why the agent needed a new shape -- read by the Phase 12 learning loop. */
  rationale: z.string().optional(),
  parts: z.array(SubPrimitiveSchema).min(1),
  /** Anchors in unit space, so labels and connectors can attach semantically. */
  anchors: z
    .array(z.object({ name: z.string().min(1), at: UnitPointSchema }))
    .default([]),
  /** Width:height the shape wants; the layout engine scales, never distorts. */
  aspectRatio: z.number().positive().default(1),
  metadata: MetadataSchema.optional(),
});
export type FreeformShape = z.infer<typeof FreeformShapeSchema>;
