/**
 * The single retry policy (D-6).
 *
 * Adapters construct their SDK client with `maxRetries: 0`. Leaving the SDK's
 * own retries on would nest two loops: a 429 storm becomes 3 x 3 = 9 attempts,
 * and any timeout budget above becomes fiction. One loop, here, where the
 * numbers are visible.
 */
import { LLMProviderError } from "../types.js";
import { ProviderErrorCode } from "./errors.js";

export interface RetryPolicy {
  /** Total attempts, including the first. 1 disables retrying. */
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** 0..1 -- proportion of the delay randomised, to avoid synchronised retries. */
  readonly jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 20_000,
  jitter: 0.25,
};

export interface RetryHooks {
  /** Injected in tests so the suite does not actually sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onRetry?: (attempt: number, delayMs: number, error: LLMProviderError) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number,
): number {
  const exponential = policy.initialDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitterRange = capped * policy.jitter;
  return Math.round(capped - jitterRange + random() * jitterRange * 2);
}

/**
 * `Retry-After` wins over our backoff when the provider sent one -- it is the
 * only party that knows when the limit resets. Still capped, so a hostile or
 * confused header cannot park the agent for an hour.
 */
function delayFor(
  attempt: number,
  error: LLMProviderError,
  policy: RetryPolicy,
  random: () => number,
): number {
  if (error.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, policy.maxDelayMs);
  return backoffDelayMs(attempt, policy, random);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  hooks: RetryHooks = {},
): Promise<T> {
  const sleep = hooks.sleep ?? defaultSleep;
  const random = hooks.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const isRetryable = error instanceof LLMProviderError && error.retryable;
      // Cancellation is never retried: the caller asked us to stop, and a retry
      // would be us deciding otherwise.
      const isCancelled =
        error instanceof LLMProviderError && error.error.code === ProviderErrorCode.Cancelled;
      if (!isRetryable || isCancelled || attempt === policy.maxAttempts) throw error;

      const delay = delayFor(attempt, error, policy, random);
      hooks.onRetry?.(attempt, delay, error);
      await sleep(delay);
    }
  }
  throw lastError;
}
