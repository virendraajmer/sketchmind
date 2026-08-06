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
    const env = {
      SKETCHMIND_TEXT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "k",
      SKETCHMIND_VISION_PROVIDER: "anthropic",
      ANTHROPIC_VISION: "true",
    };
    expect(resolveRoleProvider("text", env)?.id).toBe("anthropic");
    expect(resolveRoleProvider("vision", env)?.id).toBe("anthropic");
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
});
