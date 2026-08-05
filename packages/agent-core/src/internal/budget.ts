/**
 * Budgets and cancellation (AD-8, D-4, D-5).
 *
 * AD-8 is precise about what these are for: they bound **cost and liveness**,
 * never decisions. The agent chooses freely what to draw and how. It does not
 * get to choose to run forever.
 *
 * Two design points worth the words:
 *
 * - Wall clock is an **absolute deadline** computed once, compared at each step
 *   boundary. A `setTimeout` cannot stop an in-flight `await` anyway, leaks a
 *   handle if the run finishes early, and needs fake timers to test. The
 *   deadline also composes with the `AbortSignal` that genuinely does cancel the
 *   HTTP request.
 * - Exhaustion is a **reason, not an exception**. The run resolves with whatever
 *   it accomplished. A budget that discarded the work done so far would bound
 *   cost by destroying value.
 */
import { AgentBudgetSchema, type AgentBudget } from "@sketchmind/shared-types";
import type { TokenUsage } from "@sketchmind/llm-provider";

/** Why a run stopped. `completed` is the only one that is not a limit. */
export type StopReason =
  | "completed"
  | "budget-steps"
  | "budget-tokens"
  | "budget-time"
  | "cancelled"
  | "provider-error";

export type BudgetExceeded = Extract<
  StopReason,
  "budget-steps" | "budget-tokens" | "budget-time"
>;

export interface BudgetState {
  readonly steps: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly deadline: number;
}

/** Apply the AD-8 defaults and reject a budget that could never be satisfied. */
export function resolveBudget(budget: Partial<AgentBudget> = {}): AgentBudget {
  return AgentBudgetSchema.parse(budget);
}

export class BudgetTracker {
  readonly budget: AgentBudget;

  private readonly now: () => number;
  private readonly startedAt: number;
  private steps = 0;
  private tokensIn = 0;
  private tokensOut = 0;

  constructor(budget: AgentBudget, now: () => number = Date.now) {
    this.budget = budget;
    this.now = now;
    this.startedAt = now();
  }

  recordStep(): void {
    this.steps += 1;
  }

  recordTokens(usage: TokenUsage): void {
    this.tokensIn += usage.inputTokens;
    this.tokensOut += usage.outputTokens;
  }

  get state(): BudgetState {
    return {
      steps: this.steps,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      deadline: this.startedAt + this.budget.timeoutMs,
    };
  }

  remainingMs(): number {
    return Math.max(0, this.startedAt + this.budget.timeoutMs - this.now());
  }

  /** The budget that is spent, or `undefined` while there is room to continue. */
  exceeded(): BudgetExceeded | undefined {
    if (this.steps >= this.budget.maxSteps) return "budget-steps";
    if (this.tokensIn + this.tokensOut >= this.budget.maxTokens) return "budget-tokens";
    if (this.remainingMs() <= 0) return "budget-time";
    return undefined;
  }
}

export interface RunSignalOptions {
  /** The caller's cancellation, e.g. an HTTP request abort or a cancel endpoint. */
  readonly callerSignal?: AbortSignal;
  readonly timeoutMs: number;
}

/**
 * One signal for the whole run (D-5).
 *
 * The caller's signal, the wall-clock timeout and an internal controller are
 * composed into a single `AbortSignal` handed to the provider -- which Phase 3
 * already threads down to the transport -- and to every tool handler. One signal
 * rather than three means no tool has to know which reason it is being stopped for.
 */
export interface RunSignal {
  readonly signal: AbortSignal;
  /** Cancel the run. What a `POST /sessions/:id/cancel` handler calls. */
  cancel(): void;
  /**
   * Release the listeners this run attached to the caller's signal. Called in a
   * `finally`, including after a successful run. It is the same abort as
   * `cancel` on purpose: firing the composed signal is precisely what makes
   * `AbortSignal.any` detach from a caller signal that may outlive the run.
   * Safe to call more than once.
   */
  dispose(): void;
}

export function composeRunSignal(options: RunSignalOptions): RunSignal {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(options.timeoutMs);

  const sources = options.callerSignal
    ? [controller.signal, timeout, options.callerSignal]
    : [controller.signal, timeout];

  // `AbortSignal.any` handles the already-aborted case and detaches its own
  // listeners once it fires -- writing this by hand is how you leak listeners on
  // a long-lived caller signal.
  const signal = AbortSignal.any(sources);

  return {
    signal,
    cancel: () => controller.abort(),
    dispose: () => controller.abort(),
  };
}
