/**
 * Layout Model (Volume 05 §Layout Model).
 *
 * **This is one of only two models permitted to contain geometry** -- the other
 * is the Stroke AST. Volume 05 is explicit: "Only this model contains geometry."
 * `tests/geometry-purity.test.ts` enforces the converse on every semantic model.
 *
 * Everything here is produced by the layout solver from a Constraint Graph. The
 * agent never writes these numbers; if it ever appears to, something upstream is
 * broken.
 *
 * Coordinates are in an abstract diagram space with y increasing downward. They
 * are not pixels -- the renderer applies the viewport transform, which is what
 * lets one Layout Model render identically to a 400px canvas and an A3 PDF.
 */
import { z } from "zod";
import { SchemaVersionSchema, MetadataSchema } from "./primitives.js";

export const PointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type Point = z.infer<typeof PointSchema>;

export const SizeSchema = z.object({
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type Size = z.infer<typeof SizeSchema>;

export const BoundingBoxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

/** A resolved anchor: the semantic name plus the point the solver placed it at. */
export const ResolvedAnchorSchema = z.object({
  name: z.string().min(1),
  point: PointSchema,
});
export type ResolvedAnchor = z.infer<typeof ResolvedAnchorSchema>;

export const LayoutNodeSchema = z.object({
  /** Id of the corresponding Diagram AST object. */
  objectId: z.string().min(1),
  position: PointSchema,
  size: SizeSchema,
  /** Degrees, clockwise. */
  rotation: z.number().finite().default(0),
  bounds: BoundingBoxSchema,
  anchors: z.array(ResolvedAnchorSchema).default([]),
  /** Draw order; higher sits in front. */
  zIndex: z.number().int().default(0),
});
export type LayoutNode = z.infer<typeof LayoutNodeSchema>;

export const RoutingStyleSchema = z.enum(["straight", "orthogonal", "curved", "smart"]);
export type RoutingStyle = z.infer<typeof RoutingStyleSchema>;

/** A routed connector (Volume 05 §Connector Routing). */
export const ConnectorPathSchema = z.object({
  /** Id of the relationship this path realises. */
  relationshipId: z.string().min(1),
  routing: RoutingStyleSchema,
  /** Ordered waypoints from source to target, inclusive of both endpoints. */
  points: z.array(PointSchema).min(2),
  metadata: MetadataSchema.optional(),
});
export type ConnectorPath = z.infer<typeof ConnectorPathSchema>;

/** A placed label (Volume 05 §Label Placement). */
export const LayoutLabelSchema = z.object({
  labelId: z.string().min(1),
  targetId: z.string().min(1),
  position: PointSchema,
  bounds: BoundingBoxSchema,
  text: z.string().min(1),
});
export type LayoutLabel = z.infer<typeof LayoutLabelSchema>;

export const LayoutStrategySchema = z.enum([
  "hierarchical",
  "tree",
  "radial",
  "flow",
  "circular",
  "grid",
  "force-directed",
  "manual",
]);
export type LayoutStrategy = z.infer<typeof LayoutStrategySchema>;

export const LayoutModelSchema = z.object({
  version: SchemaVersionSchema,
  /** Id of the Diagram AST this layout was solved from. */
  diagramId: z.string().min(1),
  strategy: LayoutStrategySchema,
  /** Extent of the whole diagram, used to fit the viewport. */
  canvas: SizeSchema,
  nodes: z.array(LayoutNodeSchema),
  connectors: z.array(ConnectorPathSchema).default([]),
  labels: z.array(LayoutLabelSchema).default([]),
  metadata: MetadataSchema.optional(),
});
export type LayoutModel = z.infer<typeof LayoutModelSchema>;
