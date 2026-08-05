import { describe, expect, it } from "vitest";
import { LLMProviderError, ProviderErrorCode } from "@sketchmind/llm-provider";
import { DEFAULT_MODEL, capabilitiesFromEnv, configFromEnv } from "../src/internal/config.js";

const VALID = { ANTHROPIC_API_KEY: "sk-ant-secret" };

function expectMisconfigured(env: Record<string, string | undefined>): LLMProviderError {
  try {
    configFromEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(LLMProviderError);
    return error as LLMProviderError;
  }
  throw new Error("expected configuration to be rejected");
}

describe("configFromEnv", () => {
  it("needs only a key, and defaults the model", () => {
    const config = configFromEnv(VALID);
    expect(config.apiKey).toBe("sk-ant-secret");
    expect(config.model).toBe(DEFAULT_MODEL);
    expect(config.baseURL).toBeUndefined();
  });

  it("takes a named model and an optional gateway URL", () => {
    const config = configFromEnv({
      ...VALID,
      ANTHROPIC_MODEL: "claude-opus-4-1",
      ANTHROPIC_BASE_URL: "https://gateway.internal/anthropic",
    });
    expect(config.model).toBe("claude-opus-4-1");
    expect(config.baseURL).toBe("https://gateway.internal/anthropic");
  });

  it("rejects a missing key", () => {
    const error = expectMisconfigured({});
    expect(error.error.code).toBe(ProviderErrorCode.Misconfigured);
    expect(error.message).toContain("ANTHROPIC_API_KEY");
  });

  it("rejects a base URL that is not a URL", () => {
    expect(expectMisconfigured({ ...VALID, ANTHROPIC_BASE_URL: "not a url" })).toBeDefined();
  });

  it("never puts the key in an error message", () => {
    expect(
      expectMisconfigured({ ...VALID, ANTHROPIC_BASE_URL: "nope" }).message,
    ).not.toContain("sk-ant-secret");
  });

  it("carries a default output budget, because max_tokens is mandatory here", () => {
    // Azure has no equivalent: `CompletionRequest.maxOutputTokens` is optional,
    // and this is where that optionality is paid for.
    expect(configFromEnv(VALID).defaultMaxOutputTokens).toBeGreaterThan(0);
    expect(
      configFromEnv({ ...VALID, ANTHROPIC_MAX_OUTPUT_TOKENS: "1024" }).defaultMaxOutputTokens,
    ).toBe(1024);
  });
});

describe("capabilitiesFromEnv", () => {
  it("declares no native structured output -- this adapter forces a tool instead", () => {
    expect(capabilitiesFromEnv({}).structuredOutput).toBe(false);
    expect(capabilitiesFromEnv({}).toolCalling).toBe(true);
  });

  it("keeps vision off by default", () => {
    expect(capabilitiesFromEnv({}).vision).toBe(false);
    expect(capabilitiesFromEnv({ ANTHROPIC_VISION: "true" }).vision).toBe(true);
  });

  it("reads a context window and ignores nonsense", () => {
    expect(capabilitiesFromEnv({ ANTHROPIC_MAX_CONTEXT_TOKENS: "500000" }).maxContextTokens).toBe(
      500_000,
    );
    expect(capabilitiesFromEnv({ ANTHROPIC_MAX_CONTEXT_TOKENS: "lots" }).maxContextTokens).toBe(
      200_000,
    );
  });
});
