import { describe, expect, it, vi } from "vitest";
import { classifyFailure, providerError, ProviderErrorCode } from "../src/internal/errors.js";
import { DEFAULT_RETRY_POLICY, backoffDelayMs, withRetry } from "../src/internal/retry.js";

const PKG = "@sketchmind/llm-provider-test";

/** No real sleeping: the suite records the delays instead of serving them. */
function recorder() {
  const slept: number[] = [];
  return {
    slept,
    hooks: {
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      // Midpoint of the jitter range, so delays are deterministic.
      random: () => 0.5,
    },
  };
}

describe("withRetry", () => {
  it("returns the first successful result without sleeping", async () => {
    const { slept, hooks } = recorder();
    const operation = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(operation, DEFAULT_RETRY_POLICY, hooks)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it("retries a 429 and honours Retry-After over its own backoff", async () => {
    const { slept, hooks } = recorder();
    const rateLimited = classifyFailure(
      { status: 429, message: "slow down", retryAfter: "7" },
      PKG,
    );
    const operation = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValue("ok");

    await expect(withRetry(operation, DEFAULT_RETRY_POLICY, hooks)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
    // The provider is the only party that knows when its limit resets, so its
    // number wins over ours.
    expect(slept).toEqual([7000]);
  });

  it("caps Retry-After so a hostile header cannot park the agent", async () => {
    const { slept, hooks } = recorder();
    const policy = { ...DEFAULT_RETRY_POLICY, maxDelayMs: 5000 };
    const rateLimited = classifyFailure(
      { status: 429, message: "later", retryAfter: "3600" },
      PKG,
    );
    const operation = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValue("ok");

    await withRetry(operation, policy, hooks);
    expect(slept).toEqual([5000]);
  });

  it("backs off exponentially when there is no Retry-After", async () => {
    const { slept, hooks } = recorder();
    const unavailable = classifyFailure({ status: 503, message: "down" }, PKG);
    const operation = vi
      .fn()
      .mockRejectedValueOnce(unavailable)
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValue("ok");

    await withRetry(operation, { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 }, hooks);
    expect(slept).toEqual([500, 1000]);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const { hooks } = recorder();
    const unavailable = classifyFailure({ status: 500, message: "still down" }, PKG);
    const operation = vi.fn().mockRejectedValue(unavailable);

    await expect(
      withRetry(operation, { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 }, hooks),
    ).rejects.toBe(unavailable);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["content filter", { status: 400, providerCode: "content_filter", message: "blocked" }],
    ["auth failure", { status: 401, message: "nope" }],
    ["missing deployment", { status: 404, message: "no such deployment" }],
    ["bad request", { status: 400, message: "malformed" }],
  ])("fails fast on %s", async (_label, failure) => {
    const { hooks, slept } = recorder();
    const operation = vi.fn().mockRejectedValue(classifyFailure({ ...failure }, PKG));

    await expect(withRetry(operation, DEFAULT_RETRY_POLICY, hooks)).rejects.toBeDefined();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it("never retries a cancellation -- the caller asked us to stop", async () => {
    const { hooks } = recorder();
    const cancelled = classifyFailure({ kind: "abort", message: "aborted" }, PKG);
    const operation = vi.fn().mockRejectedValue(cancelled);

    await expect(withRetry(operation, DEFAULT_RETRY_POLICY, hooks)).rejects.toBe(cancelled);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not retry errors it did not classify", async () => {
    const { hooks } = recorder();
    const operation = vi.fn().mockRejectedValue(new TypeError("bug in our own code"));
    await expect(withRetry(operation, DEFAULT_RETRY_POLICY, hooks)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not retry an error we raised ourselves", async () => {
    const { hooks } = recorder();
    const error = providerError(ProviderErrorCode.Misconfigured, "bad base url", PKG);
    const operation = vi.fn().mockRejectedValue(error);
    await expect(withRetry(operation, DEFAULT_RETRY_POLICY, hooks)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("reports each retry so callers can trace cost", async () => {
    const { hooks } = recorder();
    const onRetry = vi.fn();
    const unavailable = classifyFailure({ status: 500, message: "down" }, PKG);
    const operation = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValue("ok");

    await withRetry(operation, DEFAULT_RETRY_POLICY, { ...hooks, onRetry });
    expect(onRetry).toHaveBeenCalledWith(1, 500, unavailable);
  });

  it("maxAttempts of 1 disables retrying entirely", async () => {
    const { hooks } = recorder();
    const unavailable = classifyFailure({ status: 500, message: "down" }, PKG);
    const operation = vi.fn().mockRejectedValue(unavailable);
    await expect(
      withRetry(operation, { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 }, hooks),
    ).rejects.toBe(unavailable);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe("backoffDelayMs", () => {
  it("doubles per attempt and caps at maxDelayMs", () => {
    const policy = { maxAttempts: 10, initialDelayMs: 100, maxDelayMs: 800, jitter: 0 };
    expect(backoffDelayMs(1, policy, () => 0.5)).toBe(100);
    expect(backoffDelayMs(2, policy, () => 0.5)).toBe(200);
    expect(backoffDelayMs(3, policy, () => 0.5)).toBe(400);
    expect(backoffDelayMs(4, policy, () => 0.5)).toBe(800);
    expect(backoffDelayMs(9, policy, () => 0.5)).toBe(800);
  });

  it("spreads delays across the jitter band so clients do not resynchronise", () => {
    const policy = { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 10_000, jitter: 0.25 };
    expect(backoffDelayMs(1, policy, () => 0)).toBe(750);
    expect(backoffDelayMs(1, policy, () => 1)).toBe(1250);
  });
});
