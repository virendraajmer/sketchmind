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
import { DiagramASTSchema } from "./diagram.js";
import { DrawingFrameSchema } from "./stroke.js";
import { BoundingBoxSchema } from "./layout.js";
import { CritiqueFindingSchema, CritiqueTierSchema } from "./critique.js";

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
  z.object({
    ...base,
    type: z.literal("SessionStarted"),
    userInput: z.string(),
    /**
     * Computed server-side from `config.vision.mode !== "off" && resolveRoleProvider("vision")
     * !== undefined` (see `apps/api/src/routes/vision.ts`'s gate). Carried on the wire so
     * `apps/studio` builds the client agent's tool registry without `capture_canvas` and
     * `critique_canvas` when false -- see "The gate" in the Phase 10 design spec.
     */
    visionEnabled: z.boolean(),
  }),
  z.object({ ...base, type: z.literal("StageStarted"), stage: PipelineStageSchema }),
  z.object({
    ...base,
    type: z.literal("StageCompleted"),
    stage: PipelineStageSchema,
    durationMs: z.number().nonnegative(),
  }),
  /**
   * One completed agent step, carrying the whole `AgentTraceStep` rather than a
   * pointer to it. The trace panel is the primary debugging surface for an
   * autonomous agent (AD-8), and a panel that has to fetch each step's detail
   * separately cannot show it live.
   */
  z.object({
    ...base,
    type: z.literal("AgentStep"),
    stepId: z.string().min(1),
    locus: LocusSchema,
    toolName: z.string().optional(),
    thought: z.string().optional(),
    toolArgs: z.record(z.string(), z.unknown()).optional(),
    toolResult: z.unknown().optional(),
    error: SketchMindErrorSchema.optional(),
    tokensIn: z.number().int().nonnegative().optional(),
    tokensOut: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  /**
   * The diagram exists semantically, before any geometry has been solved. Sent
   * as its own event so the inspector fills in while layout is still running.
   */
  z.object({ ...base, type: z.literal("DiagramASTReady"), ast: DiagramASTSchema }),
  /**
   * One playback tick. The only event carrying geometry.
   *
   * `bounds` is the extent of the *whole* drawing, not of this frame, and it is
   * here rather than in a setup event so a client can fit its viewport from the
   * very first tick. Fitting to the frame instead would zoom the view on every
   * new stroke.
   */
  z.object({
    ...base,
    type: z.literal("FrameUpdate"),
    frame: DrawingFrameSchema,
    bounds: BoundingBoxSchema.optional(),
  }),
  z.object({
    ...base,
    type: z.literal("VisionCritique"),
    tier: CritiqueTierSchema,
    findings: z.array(CritiqueFindingSchema),
    /** Whether the agent acted on these findings or judged them not worth it. */
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

/**
 * A `RuntimeEvent` minus the two fields whoever is emitting already knows.
 *
 * Written as a conditional so it *distributes* over the union. A bare
 * `Omit<RuntimeEvent, "sessionId" | "at">` collapses to the members' common
 * keys and silently throws away `strokeId`, `frame`, `ast` and the rest -- which
 * type-checks, and then rejects every event body that carries a payload.
 *
 * Both emitters need this: the runtime stamps its own session id, and the API
 * stamps both. Defining it beside the union is what stops a third emitter
 * rediscovering the same trap.
 */
export type RuntimeEventBody = RuntimeEvent extends infer T
  ? T extends object
    ? Omit<T, "sessionId" | "at">
    : never
  : never;
