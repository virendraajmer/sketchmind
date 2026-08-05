import { describe, expect, it } from "vitest";
import { LLMProviderError, ProviderErrorCode } from "@sketchmind/llm-provider";
import { capabilitiesFromEnv, configFromEnv, normalizeBaseUrl } from "../src/internal/config.js";

const VALID = {
  AZURE_OPENAI_BASE_URL: "https://reviewmind-resource.services.ai.azure.com/openai/v1",
  AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-luna",
  AZURE_OPENAI_API_KEY: "secret",
};

function expectMisconfigured(env: Record<string, string | undefined>): LLMProviderError {
  try {
    configFromEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(LLMProviderError);
    return error as LLMProviderError;
  }
  throw new Error("expected configuration to be rejected");
}

describe("normalizeBaseUrl", () => {
  it.each([
    ["https://r.services.ai.azure.com/openai/v1", "https://r.services.ai.azure.com/openai/v1"],
    ["https://r.services.ai.azure.com/openai/v1/", "https://r.services.ai.azure.com/openai/v1"],
    // The bare resource endpoint is what the portal shows, so accept it rather
    // than documenting a suffix people will forget.
    ["https://r.services.ai.azure.com", "https://r.services.ai.azure.com/openai/v1"],
    ["https://r.openai.azure.com/", "https://r.openai.azure.com/openai/v1"],
    ["https://r.openai.azure.com/openai", "https://r.openai.azure.com/openai/v1"],
    ["  https://r.openai.azure.com  ", "https://r.openai.azure.com/openai/v1"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });
});

describe("configFromEnv", () => {
  it("accepts a valid API-key configuration", () => {
    const config = configFromEnv(VALID);
    expect(config.deployment).toBe("gpt-5.6-luna");
    expect(config.auth).toEqual({ kind: "api-key", apiKey: "secret" });
    expect(config.baseURL).toMatch(/\/openai\/v1$/);
  });

  it("accepts Entra ID without a key", () => {
    const config = configFromEnv({
      ...VALID,
      AZURE_OPENAI_API_KEY: "",
      AZURE_OPENAI_USE_ENTRA_ID: "true",
    });
    expect(config.auth).toEqual({ kind: "entra" });
  });

  it("never carries an api-version -- the v1 surface has none (AD-9)", () => {
    expect(JSON.stringify(configFromEnv(VALID))).not.toMatch(/api.?version/i);
  });

  it("rejects both credentials at once, rather than silently picking one", () => {
    const error = expectMisconfigured({ ...VALID, AZURE_OPENAI_USE_ENTRA_ID: "true" });
    expect(error.error.code).toBe(ProviderErrorCode.Misconfigured);
    expect(error.message).toMatch(/not both/i);
  });

  it("rejects no credential at all", () => {
    expect(
      expectMisconfigured({ ...VALID, AZURE_OPENAI_API_KEY: "" }).message,
    ).toMatch(/AZURE_OPENAI_API_KEY/);
  });

  it("rejects a missing base URL, naming the variable and a valid example", () => {
    const error = expectMisconfigured({ ...VALID, AZURE_OPENAI_BASE_URL: "" });
    expect(error.message).toContain("AZURE_OPENAI_BASE_URL");
    expect(error.message).toContain("services.ai.azure.com");
  });

  it("rejects a base URL that is not a URL", () => {
    expect(expectMisconfigured({ ...VALID, AZURE_OPENAI_BASE_URL: "not a url" })).toBeDefined();
  });

  it("rejects a missing deployment", () => {
    expect(expectMisconfigured({ ...VALID, AZURE_OPENAI_DEPLOYMENT: "" })).toBeDefined();
  });

  it("never puts the API key in the error message", () => {
    const error = expectMisconfigured({ ...VALID, AZURE_OPENAI_USE_ENTRA_ID: "1" });
    expect(error.message).not.toContain("secret");
  });
});

describe("capabilitiesFromEnv", () => {
  it("assumes a current deployment when nothing is declared", () => {
    const capabilities = capabilitiesFromEnv({});
    expect(capabilities).toMatchObject({
      structuredOutput: true,
      toolCalling: true,
      streaming: true,
    });
  });

  it("keeps vision off unless a vision deployment is named", () => {
    // The standing directive: the agent works on JSON only. Phase 10b is opt-in
    // via one variable, with no code change.
    expect(capabilitiesFromEnv({}).vision).toBe(false);
    expect(capabilitiesFromEnv({ AZURE_OPENAI_VISION_DEPLOYMENT: "  " }).vision).toBe(false);
    expect(capabilitiesFromEnv({ AZURE_OPENAI_VISION_DEPLOYMENT: "gpt-vision" }).vision).toBe(true);
  });

  it("lets a probe result be written back as configuration", () => {
    expect(capabilitiesFromEnv({ AZURE_OPENAI_STRUCTURED_OUTPUT: "false" }).structuredOutput).toBe(
      false,
    );
    expect(capabilitiesFromEnv({ AZURE_OPENAI_TOOL_CALLING: "no" }).toolCalling).toBe(false);
  });

  it("reads a context window and ignores nonsense", () => {
    expect(capabilitiesFromEnv({ AZURE_OPENAI_MAX_CONTEXT_TOKENS: "400000" }).maxContextTokens).toBe(
      400_000,
    );
    expect(capabilitiesFromEnv({ AZURE_OPENAI_MAX_CONTEXT_TOKENS: "huge" }).maxContextTokens).toBe(
      128_000,
    );
  });
});
