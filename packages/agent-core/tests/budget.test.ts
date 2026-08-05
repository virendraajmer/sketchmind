/**
 * Budgets and cancellation (AD-8, Phase 4 D-4 and D-5).
 *
 * These bound cost and liveness and nothing else. An agent that cannot be
 * stopped is unowned, and will eventually cost money at 3am -- but a budget that
 * threw away the work done so far would bound cost by destroying value, so
 * exhaustion is a *reason*, never an exception.
 *
 * The clock is injected. Tests that assert on time by sleeping are slow and
 * flaky, and the deadline is too important to test either way.
 */
import { describe, expect, it } from "vitest";
import { BudgetTracker, composeRunSignal, resolveBudget } from "../src/internal/budget.js";

function trackerAt(now: () => number, overrides = {}) {
  return new BudgetTracker(
    resolveBudget({ maxSteps: 3, maxTokens: 100, timeoutMs: 1_000, ...overrides }),
    now,
  );
}

describe("resolveBudget", () => {
  it("fills in the AD-8 defaults", () => {
    expect(resolveBudget()).toEqual({ maxSteps: 40, maxTokens: 200_000, timeoutMs: 180_000 });
  });

  it("accepts partial overrides without losing the rest", () => {
    expect(resolveBudget({ maxSteps: 5 })).toMatchObject({ maxSteps: 5, maxTokens: 200_000 });
  });

  it("rejects a nonsensical budget at construction rather than mid-run", () => {
    expect(() => resolveBudget({ maxSteps: 0 })).toThrow();
    expect(() => resolveBudget({ timeoutMs: -1 })).toThrow();
  });
});

describe("BudgetTracker", () => {
  it("permits work while every budget has room", () => {
    const tracker = trackerAt(() => 0);
    expect(tracker.exceeded()).toBeUndefined();
  });

  it("stops after the step budget, reporting which budget it was", () => {
    const tracker = trackerAt(() => 0);
    for (let i = 0; i < 3; i += 1) {
      expect(tracker.exceeded()).toBeUndefined();
      tracker.recordStep();
    }
    expect(tracker.exceeded()).toBe("budget-steps");
  });

  it("counts input and output tokens together against the token budget", () => {
    const tracker = trackerAt(() => 0);
    tracker.recordTokens({ inputTokens: 60, outputTokens: 30, totalTokens: 90 });
    expect(tracker.exceeded()).toBeUndefined();
    tracker.recordTokens({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(tracker.exceeded()).toBe("budget-tokens");
  });

  it("stops at an absolute deadline computed once, not a timer", () => {
    let now = 0;
    const tracker = trackerAt(() => now);
    now = 999;
    expect(tracker.exceeded()).toBeUndefined();
    now = 1_000;
    // A `setTimeout` could not stop an in-flight await, leaks a handle, and needs
    // fake timers to test. A compared deadline is none of those.
    expect(tracker.exceeded()).toBe("budget-time");
  });

  it("reports the remaining time, so the provider call can be given a deadline", () => {
    let now = 0;
    const tracker = trackerAt(() => now);
    now = 250;
    expect(tracker.remainingMs()).toBe(750);
    now = 5_000;
    expect(tracker.remainingMs()).toBe(0);
  });

  it("exposes running totals for the trace", () => {
    const tracker = trackerAt(() => 0);
    tracker.recordStep();
    tracker.recordTokens({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    expect(tracker.state).toMatchObject({ steps: 1, tokensIn: 7, tokensOut: 3 });
  });
});

describe("composeRunSignal", () => {
  it("aborts when the caller's signal aborts", () => {
    const caller = new AbortController();
    const run = composeRunSignal({ callerSignal: caller.signal, timeoutMs: 60_000 });

    expect(run.signal.aborted).toBe(false);
    caller.abort();
    expect(run.signal.aborted).toBe(true);
    run.dispose();
  });

  it("aborts when cancelled directly, which is what a cancel endpoint calls", () => {
    const run = composeRunSignal({ timeoutMs: 60_000 });
    run.cancel();
    expect(run.signal.aborted).toBe(true);
    run.dispose();
  });

  it("is already aborted when the caller's signal was aborted before the run began", () => {
    const caller = new AbortController();
    caller.abort();
    const run = composeRunSignal({ callerSignal: caller.signal, timeoutMs: 60_000 });
    expect(run.signal.aborted).toBe(true);
    run.dispose();
  });

  it("aborts on its own timeout", async () => {
    const run = composeRunSignal({ timeoutMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(run.signal.aborted).toBe(true);
    run.dispose();
  });

  it("works with no caller signal at all", () => {
    const run = composeRunSignal({ timeoutMs: 60_000 });
    expect(run.signal.aborted).toBe(false);
    run.dispose();
  });
});
