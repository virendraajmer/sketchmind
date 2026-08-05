/**
 * Agent-facing models (AD-1, AD-4, AD-8).
 *
 * ## Why `ToolSpec` and not `ToolDefinition`
 *
 * The Phase 2 plan listed `ToolDefinition` as
 * `{ name, description, argsSchema, locus, handler }`. The handler cannot live
 * here: `shared-types` is the foundation layer, and a handler signature would
 * drag the agent runtime's types downward into it, inverting the dependency
 * direction that `scripts/check-layering.mjs` enforces.
 *
 * So the type is split at its natural seam:
 *
 *   - `ToolSpec` (here) -- the serializable half. This is what gets rendered
 *     into the LLM prompt and what the browser receives so its agent knows what
 *     it may call.
 *   - `ToolDefinition = ToolSpec & { handler }` (Phase 4, `agent-core`) -- the
 *     executable half, which stays on whichever side actually runs it.
 *
 * That split is not bookkeeping. It is what lets the server send the browser a
 * tool catalogue without sending it server code, and it is why a client tool
 * call still has to be authorized server-side: the browser holds specs, never
 * authority.
 */
import { z } from "zod";
import { LocusSchema, MetadataSchema } from "./primitives.js";
import { SketchMindErrorSchema } from "./errors.js";

export const ToolSpecSchema = z.object({
  name: z.string().min(1),
  /** Written for the model, not for a developer: it is the model's only guide. */
  description: z.string().min(1),
  /** JSON Schema of the arguments, produced from a Zod schema via
   * `z.toJSONSchema()` at registration time. Stored as JSON Schema because it
   * must survive the wire and be readable by any provider. */
  parameters: z.record(z.string(), z.unknown()),
  locus: LocusSchema,
  /** Whether the tool changes state. Read-only tools need no confirmation and
   * can be retried freely -- a distinction the agent loop depends on. */
  readOnly: z.boolean().default(false),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

/**
 * One step of agent reasoning (AD-8). The full trace is the audit record of an
 * autonomous agent: what it thought, what it called, what came back, and what it
 * cost. Full autonomy over decisions is the requirement; being unobservable is
 * not, and this is the type that keeps the two apart.
 */
export const AgentTraceStepSchema = z.object({
  stepId: z.string().min(1),
  locus: LocusSchema,
  /** The model's reasoning, when the provider exposes it. */
  thought: z.string().optional(),
  toolName: z.string().optional(),
  toolArgs: z.record(z.string(), z.unknown()).optional(),
  toolResult: z.unknown().optional(),
  error: SketchMindErrorSchema.optional(),
  tokensIn: z.number().int().nonnegative().default(0),
  tokensOut: z.number().int().nonnegative().default(0),
  durationMs: z.number().nonnegative().default(0),
  timestamp: z.string(),
});
export type AgentTraceStep = z.infer<typeof AgentTraceStepSchema>;

export const AgentTraceSchema = z.object({
  sessionId: z.string().min(1),
  steps: z.array(AgentTraceStepSchema).default([]),
  totalTokensIn: z.number().int().nonnegative().default(0),
  totalTokensOut: z.number().int().nonnegative().default(0),
  metadata: MetadataSchema.optional(),
});
export type AgentTrace = z.infer<typeof AgentTraceSchema>;

/**
 * Budgets (AD-8). These bound cost and liveness; they never bound decisions.
 * The agent chooses freely what to draw and how -- but an agent that cannot be
 * stopped is unowned, and eventually costs money at 3am.
 */
export const AgentBudgetSchema = z.object({
  maxSteps: z.number().int().positive().default(40),
  maxTokens: z.number().int().positive().default(200_000),
  timeoutMs: z.number().int().positive().default(180_000),
});
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;
