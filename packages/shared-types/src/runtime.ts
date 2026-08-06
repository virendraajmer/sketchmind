/**
 * Runtime state and events (Volume 16).
 *
 * `RuntimeEvent` is a discriminated union on `type`, which is what lets the
 * browser handle an SSE frame with an exhaustive `switch` the compiler can
 * check. Adding an event type then produces a compile error at every consumer
 * that forgot it -- the alternative, a loose `{ type: string; payload: any }`,
 * fails silently at runtime in the browser where nobody is watching.
 */
import { z } from "zod";
import { PipelineStageSchema, LocusSchema, MetadataSchema } from "./primitives.js";
import { SketchMindErrorSchema } from "./errors.js";

export const SessionStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** One drawing request (Volume 16 §Session). */
export const SessionSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  userInput: z.string().min(1),
  status: SessionStatusSchema,
  currentStage: PipelineStageSchema.optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  metadata: MetadataSchema.optional(),
});
export type Session = z.infer<typeof SessionSchema>;

/**
 * `cancelled` is a Phase 7 addition. Volume 06 lists Cancel alongside Play and
 * Pause as a first-class runtime operation, and a cancelled playback is not the
 * same observable state as a paused or completed one -- the trace panel has to
 * tell them apart.
 */
export const PlaybackStateSchema = z.object({
  status: z.enum(["idle", "playing", "paused", "completed", "cancelled"]),
  /** Index of the next stroke to draw. */
  cursor: z.number().int().nonnegative(),
  speed: z.number().positive().default(1),
});
export type PlaybackState = z.infer<typeof PlaybackStateSchema>;

const base = { sessionId: z.string().min(1), at: z.string() };

/**
 * Volume 16 §Event Bus. `AgentStep` and `VisionCritique` are additions -- an
 * agent-driven pipeline (AD-1) has no fixed stage sequence to report, so the
 * observable unit is the step, and AD-3's self-correction loop is invisible
 * without an event of its own.
 */
export const RuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("SessionStarted"), userInput: z.string() }),
  z.object({ ...base, type: z.literal("StageStarted"), stage: PipelineStageSchema }),
  z.object({
    ...base,
    type: z.literal("StageCompleted"),
    stage: PipelineStageSchema,
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    ...base,
    type: z.literal("AgentStep"),
    stepId: z.string().min(1),
    locus: LocusSchema,
    toolName: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("VisionCritique"),
    findings: z.array(z.string()),
    accepted: z.boolean(),
  }),
  z.object({ ...base, type: z.literal("StrokeStarted"), strokeId: z.string().min(1) }),
  z.object({ ...base, type: z.literal("StrokeCompleted"), strokeId: z.string().min(1) }),
  z.object({ ...base, type: z.literal("PlaybackPaused"), cursor: z.number().int() }),
  z.object({ ...base, type: z.literal("PlaybackResumed"), cursor: z.number().int() }),
  z.object({ ...base, type: z.literal("SessionCompleted"), durationMs: z.number().nonnegative() }),
  z.object({ ...base, type: z.literal("SessionFailed"), error: SketchMindErrorSchema }),
  z.object({ ...base, type: z.literal("SessionCancelled"), reason: z.string().optional() }),
]);
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export type RuntimeEventType = RuntimeEvent["type"];
