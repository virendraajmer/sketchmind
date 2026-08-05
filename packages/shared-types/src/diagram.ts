/**
 * Diagram AST (Volume 04): the single source of truth for what a diagram is.
 *
 * "The Diagram AST describes **what exists**. It never describes **how it is
 * drawn**." Everything downstream -- constraints, layout, strokes, pixels -- is
 * derived from this, deterministically. Per AD-6, determinism is guaranteed from
 * here onward: the same AST must always produce the same pixels.
 *
 * Objects nest via `children`, so a house owns its own walls rather than the
 * diagram owning a flat list of unrelated parts. Validation in
 * `@sketchmind/diagram-ast` walks that tree.
 */
import { z } from "zod";
import { SchemaVersionSchema, MetadataSchema } from "./primitives.js";
import { RelationshipSchema } from "./relationships.js";
import { AnchorSchema } from "./shape-graph.js";
import { DiagramCategorySchema } from "./intent.js";

export const LabelSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  /** Named anchor this label points at, if it names a part. */
  anchor: z.string().optional(),
});
export type Label = z.infer<typeof LabelSchema>;

/**
 * Style *hints* (Volume 03 §Diagram AST Contract). Semantic, not visual: the
 * renderer decides what `emphasis: "strong"` looks like. There is deliberately
 * no colour hex, stroke width, or font size here -- those belong to the
 * renderer's theme, and putting them in the AST would make the AST
 * renderer-specific, which is the one thing it must never be.
 */
export const StyleHintSchema = z.object({
  emphasis: z.enum(["subtle", "normal", "strong"]).optional(),
  variant: z.string().min(1).optional(),
  /** Semantic role for theming, e.g. `danger`, `inactive`. */
  tone: z.string().min(1).optional(),
});
export type StyleHint = z.infer<typeof StyleHintSchema>;

/**
 * Recursive object type. Zod cannot infer a recursive type on its own, so the
 * interface is declared explicitly and the schema is annotated with it -- the
 * one place in this package where a type is written by hand rather than
 * inferred (D-1), because the alternative is `any` leaking through `children`.
 */
export interface DiagramObject {
  id: string;
  type: string;
  name: string;
  category: string;
  properties?: Record<string, unknown>;
  anchors: Array<z.infer<typeof AnchorSchema>>;
  behaviors: string[];
  labels: Array<z.infer<typeof LabelSchema>>;
  style?: z.infer<typeof StyleHintSchema>;
  children: DiagramObject[];
  metadata?: Record<string, unknown>;
}

export const DiagramObjectSchema: z.ZodType<DiagramObject> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    /** Semantic type, e.g. `pulley`. Open -- the agent may invent one (AD-5). */
    type: z.string().min(1),
    /** Human-readable name, e.g. `Fixed Pulley`. */
    name: z.string().min(1),
    category: z.string().min(1),
    properties: MetadataSchema.optional(),
    anchors: z.array(AnchorSchema).default([]),
    behaviors: z.array(z.string().min(1)).default([]),
    labels: z.array(LabelSchema).default([]),
    style: StyleHintSchema.optional(),
    children: z.array(DiagramObjectSchema).default([]),
    metadata: MetadataSchema.optional(),
  }),
);

/** A named set of objects treated together for layout and highlighting. */
export const DiagramGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  members: z.array(z.string().min(1)).min(1),
  metadata: MetadataSchema.optional(),
});
export type DiagramGroup = z.infer<typeof DiagramGroupSchema>;

export const AnnotationSchema = z.object({
  id: z.string().min(1),
  target: z.string().min(1),
  text: z.string().min(1),
  anchor: z.string().optional(),
  kind: z.enum(["note", "callout", "measurement", "formula"]).default("note"),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

/** Volume 04 §Metadata. All optional -- absent metadata is not an error. */
export const DiagramMetadataSchema = z.object({
  subject: z.string().optional(),
  grade: z.string().optional(),
  difficulty: z.enum(["intro", "intermediate", "advanced"]).optional(),
  source: z.string().optional(),
  tags: z.array(z.string().min(1)).default([]),
  /** Alt text and description, for screen readers and for the vision loop. */
  accessibility: z.string().optional(),
  language: z.string().optional(),
  createdAt: z.string().optional(),
});
export type DiagramMetadata = z.infer<typeof DiagramMetadataSchema>;

export const DiagramASTSchema = z.object({
  id: z.string().min(1),
  version: SchemaVersionSchema,
  subject: z.string().min(1),
  title: z.string().min(1),
  category: DiagramCategorySchema,
  /** An AST with no objects is not a diagram. */
  objects: z.array(DiagramObjectSchema).min(1),
  relationships: z.array(RelationshipSchema).default([]),
  groups: z.array(DiagramGroupSchema).default([]),
  annotations: z.array(AnnotationSchema).default([]),
  /** `prefault` so the nested `tags: []` default actually runs -- see stroke.ts. */
  metadata: DiagramMetadataSchema.prefault({}),
});
export type DiagramAST = z.infer<typeof DiagramASTSchema>;
