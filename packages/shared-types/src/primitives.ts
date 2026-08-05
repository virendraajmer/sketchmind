/**
 * Primitive vocabulary shared by every SketchMind model.
 *
 * Ids are branded (D-5): `ObjectId` and `StrokeId` are both strings at runtime,
 * but passing one where the other belongs is a compile error. That swap is
 * exactly the mistake that produces a diagram which validates and still renders
 * wrong, so the compiler is the right place to catch it.
 */
import { z } from "zod";

export const ObjectIdSchema = z.string().min(1).brand<"ObjectId">();
export type ObjectId = z.infer<typeof ObjectIdSchema>;

export const NodeIdSchema = z.string().min(1).brand<"NodeId">();
export type NodeId = z.infer<typeof NodeIdSchema>;

export const StrokeIdSchema = z.string().min(1).brand<"StrokeId">();
export type StrokeId = z.infer<typeof StrokeIdSchema>;

export const DiagramIdSchema = z.string().min(1).brand<"DiagramId">();
export type DiagramId = z.infer<typeof DiagramIdSchema>;

export const SessionIdSchema = z.string().min(1).brand<"SessionId">();
export type SessionId = z.infer<typeof SessionIdSchema>;

export const StepIdSchema = z.string().min(1).brand<"StepId">();
export type StepId = z.infer<typeof StepIdSchema>;



/**
 * Schema version carried by every top-level model (Volume 04 §Versioning).
 * A literal rather than a free string: an unrecognised version must fail
 * validation, not flow through as an unchecked value.
 */
export const SCHEMA_VERSION = "1.0" as const;
export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);
export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;

/**
 * Pipeline stages, used for error attribution (Volume 12 §Error Contracts) and
 * runtime events (Volume 16). `agent` is not in the volumes -- it is where AD-1
 * reasoning steps report from, since they no longer sit at a fixed stage.
 */
export const PipelineStageSchema = z.enum([
  "intent",
  "vil",
  "shape-graph",
  "diagram-ast",
  "constraint",
  "layout",
  "stroke",
  "render",
  "export",
  "agent",
]);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

/** Where a tool executes, and where an agent step ran (AD-4). */
export const LocusSchema = z.enum(["server", "client"]);
export type Locus = z.infer<typeof LocusSchema>;

/** Visual focus priority (Volume 13 §Visual Focus). Drives stroke ordering. */
export const ImportanceSchema = z.enum(["primary", "secondary", "supporting"]);
export type Importance = z.infer<typeof ImportanceSchema>;

/** Level of detail (Volume 13 §Responsibilities). */
export const DetailLevelSchema = z.enum(["minimal", "standard", "detailed"]);
export type DetailLevel = z.infer<typeof DetailLevelSchema>;

/**
 * Free-form metadata bag. `unknown` rather than `any` so consumers are forced
 * to narrow before use, and plugins can attach domain data without a schema
 * change (Volume 04 §Extensibility).
 */
export const MetadataSchema = z.record(z.string(), z.unknown());
export type Metadata = z.infer<typeof MetadataSchema>;
