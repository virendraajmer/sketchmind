import { describe, expect, it } from "vitest";
import {
  ProviderErrorCode,
  classifyFailure,
  parseRetryAfterMs,
  providerError,
  type TransportFailure,
} from "../src/internal/errors.js";

const PKG = "@sketchmind/llm-provider-test";

function classify(failure: Partial<TransportFailure>) {
  return classifyFailure({ message: "boom", ...failure }, PKG);
}

describe("classifyFailure", () => {
  it.each([
    [{ status: 429 }, ProviderErrorCode.RateLimited, true],
    [{ status: 500 }, ProviderErrorCode.Unavailable, true],
    [{ status: 503 }, ProviderErrorCode.Unavailable, true],
    [{ kind: "timeout" as const }, ProviderErrorCode.Timeout, true],
    [{ kind: "connection" as const }, ProviderErrorCode.Unavailable, true],
    [{ status: 401 }, ProviderErrorCode.AuthFailed, false],
    [{ status: 403 }, ProviderErrorCode.AuthFailed, false],
    [{ status: 404 }, ProviderErrorCode.DeploymentNotFound, false],
    [{ status: 400 }, ProviderErrorCode.BadRequest, false],
    [{ status: 422 }, ProviderErrorCode.BadRequest, false],
    [{ kind: "abort" as const }, ProviderErrorCode.Cancelled, false],
  ])("maps %o to %s (retryable=%s)", (failure, code, retryable) => {
    const error = classify(failure);
    expect(error.error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
  });

  it("treats a content filter as not retryable but recoverable", () => {
    // Independent axes: retrying sends the identical prompt and fails
    // identically, yet the AGENT can rewrite the prompt (AD-2).
    const error = classify({ status: 400, providerCode: "content_filter" });
    expect(error.error.code).toBe(ProviderErrorCode.ContentFiltered);
    expect(error.retryable).toBe(false);
    expect(error.error.recoverable).toBe(true);
  });

  it("recognises Azure's own content-filter code", () => {
    expect(classify({ status: 400, providerCode: "ResponsibleAIPolicyViolation" }).error.code).toBe(
      ProviderErrorCode.ContentFiltered,
    );
  });

  it("marks a bad request recoverable so the agent can revise its input", () => {
    expect(classify({ status: 400 }).error.recoverable).toBe(true);
  });

  it("does not mark auth or deployment errors recoverable -- the agent cannot fix config", () => {
    expect(classify({ status: 401 }).error.recoverable).toBe(false);
    expect(classify({ status: 404 }).error.recoverable).toBe(false);
  });

  it("carries status and provider code into details for diagnosis", () => {
    const error = classify({ status: 429, providerCode: "rate_limit_exceeded" });
    expect(error.error.details).toMatchObject({ status: 429, providerCode: "rate_limit_exceeded" });
  });

  it("attributes the failure to the reporting package and the agent stage", () => {
    const error = classify({ status: 500 });
    expect(error.error.package).toBe(PKG);
    expect(error.error.stage).toBe("agent");
  });
});

describe("parseRetryAfterMs", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
    expect(parseRetryAfterMs(" 2 ")).toBe(2000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("reads an HTTP-date, relative to now", () => {
    const now = Date.parse("2026-08-05T12:00:00Z");
    expect(parseRetryAfterMs("Wed, 05 Aug 2026 12:00:10 GMT", now)).toBe(10_000);
  });

  it("clamps a date already in the past to zero rather than going negative", () => {
    const now = Date.parse("2026-08-05T12:00:00Z");
    expect(parseRetryAfterMs("Wed, 05 Aug 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("returns undefined for absent or unparseable values", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
    expect(parseRetryAfterMs("-5")).toBeUndefined();
  });
});

describe("providerError", () => {
  it("produces a non-retryable structured error", () => {
    const error = providerError(
      ProviderErrorCode.CapabilityUnavailable,
      "no vision here",
      PKG,
    );
    expect(error.retryable).toBe(false);
    expect(error.error.code).toBe(ProviderErrorCode.CapabilityUnavailable);
    expect(error.message).toContain("no vision here");
  });

  it("survives JSON round-tripping, because these travel over SSE (D-3)", () => {
    const error = providerError(ProviderErrorCode.Misconfigured, "bad config", PKG, {
      details: { key: "AZURE_OPENAI_BASE_URL" },
    });
    const revived = JSON.parse(JSON.stringify(error.error));
    expect(revived).toEqual(error.error);
    expect(revived.details.key).toBe("AZURE_OPENAI_BASE_URL");
  });
});
