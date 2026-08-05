/**
 * Error classification (D-6).
 *
 * Adapters *classify*; this module decides what a classification means. The
 * split matters because retry policy is identical across providers while error
 * shapes are not -- an adapter that owned its own backoff would give us three
 * subtly different policies and no single place to reason about cost.
 *
 * Nothing here imports a provider SDK. Adapters flatten their SDK error into a
 * `TransportFailure` first.
 */
import { makeError, type SketchMindError } from "@sketchmind/shared-types";
import { LLMProviderError } from "../types.js";

export const ProviderErrorCode = {
  RateLimited: "PROVIDER_RATE_LIMITED",
  Unavailable: "PROVIDER_UNAVAILABLE",
  Timeout: "PROVIDER_TIMEOUT",
  Cancelled: "PROVIDER_CANCELLED",
  /** The prompt tripped a safety filter. Retrying sends the same prompt. */
  ContentFiltered: "PROVIDER_CONTENT_FILTERED",
  AuthFailed: "PROVIDER_AUTH_FAILED",
  /** Wrong deployment name or wrong resource. Configuration, not weather. */
  DeploymentNotFound: "PROVIDER_DEPLOYMENT_NOT_FOUND",
  BadRequest: "PROVIDER_BAD_REQUEST",
  /** Output never satisfied the schema, even after repair attempts. */
  InvalidOutput: "PROVIDER_INVALID_OUTPUT",
  /** Asked for something this provider declares it cannot do. */
  CapabilityUnavailable: "PROVIDER_CAPABILITY_UNAVAILABLE",
  Misconfigured: "PROVIDER_MISCONFIGURED",
  Unknown: "PROVIDER_UNKNOWN",
} as const;

export type ProviderErrorCode = (typeof ProviderErrorCode)[keyof typeof ProviderErrorCode];

/** A provider failure, flattened to the fields policy actually needs. */
export interface TransportFailure {
  readonly status?: number;
  /** The provider's own error code string, when it has one. */
  readonly providerCode?: string;
  readonly message: string;
  /** Seconds or an HTTP-date, verbatim from the `Retry-After` header. */
  readonly retryAfter?: string | null;
  readonly kind?: "connection" | "timeout" | "abort" | "content_filter";
}

interface Verdict {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  /** Whether the AGENT can do something about it (AD-2), not whether we retry. */
  readonly recoverable: boolean;
}

/**
 * `retryable` and `recoverable` are deliberately independent. A content filter
 * is not retryable (the same prompt fails identically) yet is recoverable: the
 * agent can rewrite the prompt. A 500 is the reverse.
 */
function verdictFor(failure: TransportFailure): Verdict {
  if (failure.kind === "abort")
    return { code: ProviderErrorCode.Cancelled, retryable: false, recoverable: false };
  if (failure.kind === "timeout")
    return { code: ProviderErrorCode.Timeout, retryable: true, recoverable: false };
  if (failure.kind === "connection")
    return { code: ProviderErrorCode.Unavailable, retryable: true, recoverable: false };
  if (failure.kind === "content_filter" || isContentFilter(failure))
    return { code: ProviderErrorCode.ContentFiltered, retryable: false, recoverable: true };

  const status = failure.status;
  if (status === 429)
    return { code: ProviderErrorCode.RateLimited, retryable: true, recoverable: false };
  if (status === 401 || status === 403)
    return { code: ProviderErrorCode.AuthFailed, retryable: false, recoverable: false };
  if (status === 404)
    return { code: ProviderErrorCode.DeploymentNotFound, retryable: false, recoverable: false };
  if (status === 400 || status === 422)
    return { code: ProviderErrorCode.BadRequest, retryable: false, recoverable: true };
  if (status !== undefined && status >= 500)
    return { code: ProviderErrorCode.Unavailable, retryable: true, recoverable: false };

  return { code: ProviderErrorCode.Unknown, retryable: false, recoverable: false };
}

function isContentFilter(failure: TransportFailure): boolean {
  return (
    failure.providerCode === "content_filter" ||
    failure.providerCode === "ResponsibleAIPolicyViolation" ||
    failure.providerCode === "content_policy_violation"
  );
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110). Honour both
 * -- Azure sends seconds, but a proxy in front of it may not.
 */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

export function classifyFailure(
  failure: TransportFailure,
  providerPackage: string,
): LLMProviderError {
  const verdict = verdictFor(failure);
  const error = makeError({
    code: verdict.code,
    message: failure.message,
    package: providerPackage,
    stage: "agent",
    recoverable: verdict.recoverable,
    details: {
      ...(failure.status !== undefined ? { status: failure.status } : {}),
      ...(failure.providerCode !== undefined ? { providerCode: failure.providerCode } : {}),
    },
  });
  return new LLMProviderError(error, verdict.retryable, parseRetryAfterMs(failure.retryAfter));
}

/** For failures we raise ourselves rather than receive from a transport. */
export function providerError(
  code: ProviderErrorCode,
  message: string,
  providerPackage: string,
  options: { recoverable?: boolean; details?: Record<string, unknown> } = {},
): LLMProviderError {
  const error: SketchMindError = makeError({
    code,
    message,
    package: providerPackage,
    stage: "agent",
    recoverable: options.recoverable ?? false,
    ...(options.details ? { details: options.details } : {}),
  });
  return new LLMProviderError(error, false);
}
