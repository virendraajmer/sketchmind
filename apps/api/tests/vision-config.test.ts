import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { resolveRoleProvider } from "../src/provider.js";

describe("vision config", () => {
  it("defaults to geometric on and visual off", () => {
    const config = loadConfig({});
    expect(config.vision.geometric).toBe(true);
    expect(config.vision.mode).toBe("off");
  });

  it("reads the mode", () => {
    expect(loadConfig({ SKETCHMIND_VISION_MODE: "auto" }).vision.mode).toBe("auto");
    expect(loadConfig({ SKETCHMIND_VISION_MODE: "on" }).vision.mode).toBe("on");
  });

  it("falls back to off for an unrecognised mode", () => {
    expect(loadConfig({ SKETCHMIND_VISION_MODE: "yes please" }).vision.mode).toBe("off");
  });

  it("caps rounds and image size with documented defaults", () => {
    const config = loadConfig({});
    expect(config.vision.maxRounds).toBe(2);
    expect(config.vision.maxImageBytes).toBe(4_000_000);
    expect(config.repair.maxRounds).toBe(2);
    expect(config.repair.maxSteps).toBe(12);
  });
});

describe("resolveRoleProvider", () => {
  it("returns undefined when nothing is configured", () => {
    expect(resolveRoleProvider("text", {})).toBeUndefined();
    expect(resolveRoleProvider("vision", {})).toBeUndefined();
  });

  it("returns undefined for the vision role when the provider cannot see", () => {
    const env = { SKETCHMIND_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_VISION: "false" };
    expect(resolveRoleProvider("vision", env)).toBeUndefined();
  });

  it("resolves the vision role when the provider declares vision", () => {
    const env = { SKETCHMIND_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_VISION: "true" };
    expect(resolveRoleProvider("vision", env)?.capabilities.vision).toBe(true);
  });

  it("lets the two roles name different providers", () => {
    // Same adapter for both roles, but different models -- so a prefix mixup
    // (vision reading SKETCHMIND_TEXT_* or vice versa) is observable: with
    // matching ids alone, a swapped role still resolves an "anthropic" id and
    // the test would pass either way.
    const env = {
      SKETCHMIND_TEXT_PROVIDER: "anthropic",
      SKETCHMIND_TEXT_MODEL: "claude-text-role",
      ANTHROPIC_API_KEY: "k",
      SKETCHMIND_VISION_PROVIDER: "anthropic",
      SKETCHMIND_VISION_MODEL: "claude-vision-role",
      ANTHROPIC_VISION: "true",
    };
    const text = resolveRoleProvider("text", env);
    const vision = resolveRoleProvider("vision", env);
    expect(text?.id).toBe("anthropic");
    expect(vision?.id).toBe("anthropic");
    expect(text?.model).toBe("claude-text-role");
    expect(vision?.model).toBe("claude-vision-role");
  });

  it("applies a per-role model override", () => {
    const env = {
      SKETCHMIND_LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_VISION: "true",
      SKETCHMIND_VISION_MODEL: "claude-sonnet-5",
    };
    expect(resolveRoleProvider("vision", env)?.model).toBe("claude-sonnet-5");
  });

  // Every other vision test above uses Anthropic, whose `vision` flag derives
  // straight from ANTHROPIC_VISION. Azure is the adapter Task 5 actually made
  // honest: it reports `vision: true` only when the instance was constructed
  // on the configured vision deployment, and SKETCHMIND_VISION_MODEL is the
  // only supported way to steer that construction. Exercise the real adapter.
  const azureBase = {
    SKETCHMIND_LLM_PROVIDER: "azure-openai",
    AZURE_OPENAI_BASE_URL: "https://example.services.ai.azure.com/openai/v1",
    AZURE_OPENAI_API_KEY: "k",
    AZURE_OPENAI_DEPLOYMENT: "text-deployment",
    AZURE_OPENAI_VISION_DEPLOYMENT: "vision-deployment",
  };

  it("resolves the vision role against Azure when steered onto the vision deployment", () => {
    const env = { ...azureBase, SKETCHMIND_VISION_MODEL: "vision-deployment" };
    expect(resolveRoleProvider("vision", env)?.capabilities.vision).toBe(true);
  });

  it("leaves the Azure vision role unresolved when nothing steers it off the text deployment", () => {
    // Without the override, the instance is built on AZURE_OPENAI_DEPLOYMENT
    // (the text deployment), which correctly reports vision: false -- this is
    // exactly why the override exists.
    expect(resolveRoleProvider("vision", azureBase)).toBeUndefined();
  });
});
