/**
 * Stroke AST (Volume 06): how a human would draw the Layout Model.
 *
 * The second of the two geometry-bearing models. Strokes carry the points a pen
 * would travel; they do not carry renderer commands. "Circle" here means the
 * semantic act of drawing a circle, not `ctx.arc(...)` -- which is what lets the
 * same Stroke AST replay to Konva, to SVG, and to a PDF.
 *
 * Stroke order is the teaching order: large outlines first, details next, labels
 * last (Volume 06 §Human Drawing Rules). That ordering is the difference between
 * a diagram appearing and a diagram being explained.
 */
import { z } from "zod";
import { SchemaVersionSchema, MetadataSchema } from "./primitives";
import { PointSchema, BoundingBoxSchema } from "./layout";

/** The 12 semantic stroke types of Volume 06. Plugins may register more. */
export const StrokeTypeSchema = z.enum([
  "line",
  "curve",
  "arc",
  "circle",
  "ellipse",
  "rectangle",
  "polygon",
  "freehand",
  "arrow",
  "text",
  "hatch",
  "erase",
]);
export type StrokeType = z.infer<typeof StrokeTypeSchema>;

/**
 * Pen behaviour (Volume 06 §Pen Simulation). These are drawing *intent*; the
 * renderer decides final appearance. `jitter` is what makes the output look
 * hand-drawn rather than plotted -- it is a feature, and it is why replays must
 * seed their randomness from the stroke id to stay deterministic (AD-6).
 */
export const StrokeStyleSchema = z.object({
  width: z.number().positive().default(2),
  /** 0 = mechanical, 1 = very shaky. */
  jitter: z.number().min(0).max(1).default(0.15),
  pressureProfile: z.enum(["uniform", "taperIn", "taperOut", "taperBoth"]).default("taperBoth"),
  ink: z.enum(["pen", "pencil", "marker", "chalk"]).default("pen"),
  /** Semantic tone, resolved to a colour by the renderer's theme. */
  tone: z.string().min(1).optional(),
  dashed: z.boolean().default(false),
});
export type StrokeStyle = z.infer<typeof StrokeStyleSchema>;

/** Playback timing (Volume 06 §Stroke Timing). Milliseconds. */
export const StrokeTimingSchema = z.object({
  delayMs: z.number().nonnegative().default(0),
  durationMs: z.number().positive().default(400),
  /** Hold after this stroke completes -- the beat a teacher leaves for effect. */
  pauseAfterMs: z.number().nonnegative().default(0),
});
export type StrokeTiming = z.infer<typeof StrokeTimingSchema>;

export const StrokeSchema = z.object({
  id: z.string().min(1),
  type: StrokeTypeSchema,
  /** Diagram AST object this stroke belongs to. */
  target: z.string().min(1),
  /** Position in the drawing sequence; ascending. */
  order: z.number().int().nonnegative(),
  /** Stroke ids that must complete first (Volume 06 §Stroke Timing). */
  dependencies: z.array(z.string().min(1)).default([]),
  /**
   * The pen path. Every stroke type reduces to points: a circle is its
   * traversal, a rectangle its corners. Keeping one representation means the
   * runtime has one code path for interpolation and partial rendering.
   */
  points: z.array(PointSchema).min(1),
  /** Text content, required when `type` is `text`. */
  text: z.string().optional(),
  /**
   * `prefault`, not `default`. Zod's `.default({})` substitutes the literal
   * value without parsing it, so the nested field defaults below would never
   * run and a stroke would reach the renderer with no width or duration.
   * `.prefault({})` parses the default, filling those in.
   */
  style: StrokeStyleSchema.prefault({}),
  timing: StrokeTimingSchema.prefault({}),
  metadata: MetadataSchema.optional(),
});
export type Stroke = z.infer<typeof StrokeSchema>;

export const StrokeASTSchema = z.object({
  version: SchemaVersionSchema,
  diagramId: z.string().min(1),
  strokes: z.array(StrokeSchema),
  /** Extent covered by all strokes, for viewport fitting. */
  bounds: BoundingBoxSchema.optional(),
  /** Total playback duration at 1x, computed by the planner. */
  totalDurationMs: z.number().nonnegative().optional(),
  metadata: MetadataSchema.optional(),
});
export type StrokeAST = z.infer<typeof StrokeASTSchema>;
