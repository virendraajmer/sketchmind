/**
 * @sketchmind/agent-core
 *
 * The agent loop, tool registry, budgets, cancellation and tracing. One loop,
 * two loci (AD-4): the browser runs this same code with a different tool
 * catalogue, so the client and server agents cannot disagree about how a turn
 * works.
 *
 * Three properties this package exists to guarantee:
 *
 *  - **Adaptive depth (AD-1).** Pipeline stages are tools the model may call,
 *    skip, reorder or repeat. "Draw a circle" is not charged four LLM round
 *    trips for the privilege of being simple.
 *  - **Failure as observation (AD-2).** A tool that throws, a tool that does not
 *    exist, and arguments that do not validate all come back as something the
 *    model reads and fixes. The run continues.
 *  - **Bounded, never gated (AD-8).** Steps, tokens, wall clock and cancellation
 *    bound cost and liveness. Nothing here bounds the agent's *decisions*.
 *
 * It depends on `@sketchmind/llm-provider` and on no concrete provider, which is
 * what keeps swapping models a one-env-var change.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12) -- the few internal types
 * re-exported below are part of the contract, not an invitation to reach in.
 */

export const PACKAGE_NAME = "@sketchmind/agent-core";
export const PACKAGE_VERSION = "0.0.1";

export {
  ToolRegistry,
  defineTool,
  type ToolContext,
  type ToolDefinition,
  type ToolDefinitionInput,
  type ToolHandler,
} from "./tools.js";

export {
  runAgent,
  type AgentRunResult,
  type AgentRunStatus,
  type RunAgentOptions,
} from "./loop.js";

export {
  BudgetTracker,
  composeRunSignal,
  resolveBudget,
  type BudgetExceeded,
  type BudgetState,
  type RunSignal,
  type RunSignalOptions,
  type StopReason,
} from "./internal/budget.js";

export {
  DEFAULT_MAX_RESULT_CHARS,
  executeToolCall,
  type ExecuteOptions,
  type ToolOutcome,
} from "./internal/execute.js";
