/**
 * The agent loop (AD-1, AD-2, AD-4, AD-8).
 *
 * `observe -> reason -> select tool(s) -> execute -> observe -> ...` until the
 * model answers instead of calling a tool, or a budget runs out, or the run is
 * cancelled. That is the whole of it, and it is deliberately the whole of it:
 * everything Phases 5-12 add is a tool, not a change here.
 *
 * Read AD-1 alongside this file. The docs describe nine pipeline stages running
 * in a fixed order every time. Here they are tools the model may call, skip,
 * reorder, or repeat, so "draw a circle" costs one round trip and "draw a
 * hydraulic press" costs as many as it needs. The loop has no opinion about
 * which; it only supplies the machinery and the bounds.
 *
 * Nothing in this file throws on account of the model or a tool (AD-2). The only
 * exception that escapes is a provider that cannot answer at all -- not the
 * agent producing bad output, but the transport being unable to run.
 */
import {
  makeError,
  type AgentTrace,
  type AgentTraceStep,
  type Locus,
  type Metadata,
  type SketchMindError,
} from "@sketchmind/shared-types";
import {
  LLMProviderError,
  type LLMProvider,
  type Message,
  type ToolCall,
  type ToolResponse,
} from "@sketchmind/llm-provider";
import { BudgetTracker, composeRunSignal, resolveBudget, type StopReason } from "./internal/budget.js";
import { executeToolCall, type ToolOutcome } from "./internal/execute.js";
import type { ToolRegistry } from "./tools.js";

const PACKAGE = "@sketchmind/agent-core";

const DEFAULT_SYSTEM_PROMPT = [
  "You are SketchMind's drawing agent. You explain things by drawing them on a whiteboard,",
  "the way a teacher would: one step at a time, in an order that makes sense to watch.",
  "",
  "Use the tools to do the work. Call as many or as few as the request actually needs --",
  "a simple shape does not need the same reasoning as a mechanism. When a tool reports a",
  "problem, read it, fix the cause, and continue; a failed tool is information, not a dead end.",
  "When the drawing is finished, reply in prose instead of calling another tool.",
].join("\n");

export interface RunAgentOptions {
  readonly sessionId: string;
  /** What the user asked for, in their words. */
  readonly goal: string;
  readonly provider: LLMProvider;
  readonly registry: ToolRegistry;
  /** Which side is running. Selects the advertised tool catalogue (AD-4). */
  readonly locus?: Locus;
  readonly systemPrompt?: string;
  /** Partial: unset fields take the AD-8 defaults. */
  readonly budget?: Partial<{ maxSteps: number; maxTokens: number; timeoutMs: number }>;
  readonly signal?: AbortSignal;
  /** Called as each step completes. Phase 9's SSE stream is one line here. */
  readonly onStep?: (step: AgentTraceStep) => void;
  /** Prior conversation, for a follow-up turn on an existing session. */
  readonly history?: readonly Message[];
  readonly maxResultChars?: number;
  readonly metadata?: Metadata;
  /** Injected clock, so budget tests assert rather than race. */
  readonly now?: () => number;
}

export type AgentRunStatus = "completed" | "budget-exhausted" | "cancelled" | "failed";

export interface AgentRunResult {
  readonly status: AgentRunStatus;
  readonly stopReason: StopReason;
  /** The model's final prose. Empty when the run stopped before answering. */
  readonly output: string;
  readonly trace: AgentTrace;
  /** The full conversation, ready to pass back as `history` for a follow-up. */
  readonly messages: readonly Message[];
  /** Set only when `status` is `failed`. */
  readonly error?: SketchMindError;
}

const STATUS_BY_REASON: Record<StopReason, AgentRunStatus> = {
  completed: "completed",
  "budget-steps": "budget-exhausted",
  "budget-tokens": "budget-exhausted",
  "budget-time": "budget-exhausted",
  cancelled: "cancelled",
  "provider-error": "failed",
};

function providerFailure(cause: unknown): SketchMindError {
  if (cause instanceof LLMProviderError) return cause.error;
  return makeError({
    code: "PROVIDER_FAILED",
    message: cause instanceof Error ? cause.message : String(cause),
    package: PACKAGE,
    stage: "agent",
    // The transport could not answer. Unlike a tool failure, this is not
    // something the agent can reason its way out of on the next step.
    recoverable: false,
  });
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const {
    sessionId,
    goal,
    provider,
    registry,
    locus = "server",
    onStep,
    maxResultChars,
    now = Date.now,
  } = options;

  const budget = resolveBudget(options.budget);
  const tracker = new BudgetTracker(budget, now);
  const run = composeRunSignal({ timeoutMs: budget.timeoutMs, ...(options.signal ? { callerSignal: options.signal } : {}) });

  const system = [options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT].join("\n\n");
  const tools = registry.toolCallSpecs(locus);
  const allowParallelCalls = provider.capabilities.parallelToolCalls;

  const messages: Message[] = [...(options.history ?? []), { role: "user", content: goal }];
  const steps: AgentTraceStep[] = [];
  let stepCounter = 0;

  const record = (step: Omit<AgentTraceStep, "stepId" | "timestamp">): void => {
    stepCounter += 1;
    const full: AgentTraceStep = {
      ...step,
      stepId: `${sessionId}-${stepCounter}`,
      timestamp: new Date().toISOString(),
    };
    steps.push(full);
    // Synchronous by design (D-6): the callback IS the stream, and buffering
    // policy belongs to the transport, not here.
    onStep?.(full);
  };

  const finish = (
    stopReason: StopReason,
    output: string,
    error?: SketchMindError,
  ): AgentRunResult => {
    run.dispose();
    const trace: AgentTrace = {
      sessionId,
      steps,
      totalTokensIn: steps.reduce((sum, step) => sum + step.tokensIn, 0),
      totalTokensOut: steps.reduce((sum, step) => sum + step.tokensOut, 0),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };
    return {
      status: STATUS_BY_REASON[stopReason],
      stopReason,
      output,
      trace,
      messages,
      ...(error ? { error } : {}),
    };
  };

  try {
    for (;;) {
      // Cancellation before budgets: a cancelled run that reported
      // "budget-exhausted" would send the user looking for the wrong problem.
      if (run.signal.aborted) return finish("cancelled", "");

      const spent = tracker.exceeded();
      if (spent !== undefined) return finish(spent, "");

      const startedAt = now();
      let response: ToolResponse;
      try {
        response = await provider.completeWithTools({
          system,
          messages,
          tools,
          toolChoice: "auto",
          // The capability flag decides, never the provider id.
          allowParallelCalls,
          signal: run.signal,
        });
      } catch (cause) {
        const error = providerFailure(cause);
        record({
          locus,
          error,
          tokensIn: 0,
          tokensOut: 0,
          durationMs: now() - startedAt,
        });
        // An aborted in-flight request is cancellation, not a provider fault.
        if (run.signal.aborted) return finish("cancelled", "");
        return finish("provider-error", "", error);
      }

      tracker.recordStep();
      tracker.recordTokens(response.usage);
      const durationMs = now() - startedAt;

      if (response.toolCalls.length === 0) {
        // The model answered instead of calling a tool: the goal is met.
        record({
          locus,
          thought: response.text,
          tokensIn: response.usage.inputTokens,
          tokensOut: response.usage.outputTokens,
          durationMs,
        });
        messages.push({ role: "assistant", content: response.text });
        return finish("completed", response.text);
      }

      messages.push({
        role: "assistant",
        content: response.text,
        toolCalls: response.toolCalls,
      });

      const outcomes = await executeBatch(response.toolCalls, {
        registry,
        parallel: allowParallelCalls,
        context: { sessionId, signal: run.signal, locus },
        ...(maxResultChars === undefined ? {} : { maxResultChars }),
      });

      for (const [index, outcome] of outcomes.entries()) {
        const call = response.toolCalls[index]!;
        messages.push({
          role: "tool",
          toolCallId: outcome.toolCallId,
          toolName: outcome.toolName,
          content: outcome.content,
          isError: !outcome.ok,
        });
        record({
          locus,
          // The reasoning belongs to the model call, so it is attributed to the
          // first step of the batch rather than repeated on each.
          ...(index === 0 && response.text ? { thought: response.text } : {}),
          toolName: call.name,
          toolArgs: call.arguments,
          ...(outcome.ok ? { toolResult: outcome.result } : {}),
          ...(outcome.errors?.[0] ? { error: outcome.errors[0] } : {}),
          // Likewise the tokens: one model call funded the whole batch, and
          // counting it once per call would make the budget quietly wrong.
          tokensIn: index === 0 ? response.usage.inputTokens : 0,
          tokensOut: index === 0 ? response.usage.outputTokens : 0,
          durationMs: index === 0 ? durationMs : 0,
        });
      }
    }
  } finally {
    run.dispose();
  }
}

interface BatchOptions {
  readonly registry: ToolRegistry;
  readonly parallel: boolean;
  readonly context: { sessionId: string; signal: AbortSignal; locus: Locus };
  readonly maxResultChars?: number;
}

/**
 * Run one batch of tool calls (D-7).
 *
 * Parallel only when the provider says it can produce parallel batches; running
 * them concurrently otherwise would reorder state-changing tools that the model
 * intended to happen in sequence.
 */
async function executeBatch(
  calls: readonly ToolCall[],
  options: BatchOptions,
): Promise<ToolOutcome[]> {
  const execute = (call: ToolCall): Promise<ToolOutcome> =>
    executeToolCall(
      options.registry,
      call,
      options.context,
      options.maxResultChars === undefined ? {} : { maxResultChars: options.maxResultChars },
    );

  if (options.parallel && calls.length > 1) return Promise.all(calls.map(execute));

  const outcomes: ToolOutcome[] = [];
  for (const call of calls) outcomes.push(await execute(call));
  return outcomes;
}
