/**
 * Turn an `AgentTraceStep` into the wire event for it.
 *
 * Shared between the primary session run and a repair turn: both drive
 * `runAgent`, and both must reach the trace panel the same way. Before this
 * was factored out, a repair turn passed no `onStep` at all, which made the
 * one part of the system that rewrites the user's picture the one part with
 * no trace -- the browser saw a `VisionCritique`, then silence for up to the
 * repair budget's step count, then either a changed drawing or nothing.
 */
import type { AgentTraceStep, RuntimeEventBody } from "@sketchmind/shared-types";

export function stepEvent(step: AgentTraceStep): RuntimeEventBody {
  return {
    type: "AgentStep",
    stepId: step.stepId,
    locus: step.locus,
    ...(step.thought === undefined ? {} : { thought: step.thought }),
    ...(step.toolName === undefined ? {} : { toolName: step.toolName }),
    ...(step.toolArgs === undefined ? {} : { toolArgs: step.toolArgs }),
    ...(step.toolResult === undefined ? {} : { toolResult: step.toolResult }),
    ...(step.error === undefined ? {} : { error: step.error }),
    tokensIn: step.tokensIn,
    tokensOut: step.tokensOut,
    durationMs: step.durationMs,
  };
}
