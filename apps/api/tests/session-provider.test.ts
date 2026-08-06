/**
 * Which provider the *session* actually runs on.
 *
 * `resolveRoleProvider("text", …)` was fully built and unit-tested (see
 * `vision-config.test.ts`) while `buildServer` still resolved the session with
 * `resolveProvider()`, which reads only `SKETCHMIND_LLM_PROVIDER`. Every
 * documented `SKETCHMIND_TEXT_*` variable was therefore silently ignored, and a
 * deployment that set only those got the explanatory `FakeProvider` and drew
 * nothing. A unit test on the resolver could not see that: the gap was at the
 * composition root, so these assert at the composition root.
 */
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "@sketchmind/agent-memory";
import { buildServer } from "../src/server.js";
import { testConfig } from "./support.js";

const KEYS = [
  "SKETCHMIND_LLM_PROVIDER",
  "SKETCHMIND_TEXT_PROVIDER",
  "SKETCHMIND_TEXT_MODEL",
  "SKETCHMIND_VISION_PROVIDER",
  "SKETCHMIND_VISION_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_VISION",
  "ANTHROPIC_TOOL_CALLING",
] as const;

const saved = new Map<string, string | undefined>();

function setEnv(values: Record<string, string>): void {
  for (const key of KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

/** `buildServer` with nothing injected, so it resolves from the environment. */
async function built() {
  return buildServer({
    store: new InMemoryStore(),
    config: testConfig(),
    logger: false,
  });
}

describe("the session provider", () => {
  it("honours SKETCHMIND_TEXT_PROVIDER / SKETCHMIND_TEXT_MODEL on their own", async () => {
    setEnv({
      SKETCHMIND_TEXT_PROVIDER: "anthropic",
      SKETCHMIND_TEXT_MODEL: "claude-text-role",
      ANTHROPIC_API_KEY: "k",
    });

    const server = await built();
    expect(server.provider.id).toBe("anthropic");
    expect(server.provider.model).toBe("claude-text-role");
    await server.app.close();
  });

  it("applies SKETCHMIND_TEXT_MODEL over a provider named by SKETCHMIND_LLM_PROVIDER", async () => {
    // The sharp edge: `resolveProvider()` resolves this provider too, but on the
    // adapter's own default model -- so only a session resolved through the text
    // *role* ends up on `claude-text-role`. Reverting `server.ts` to
    // `resolveProvider()` fails exactly here.
    setEnv({
      SKETCHMIND_LLM_PROVIDER: "anthropic",
      SKETCHMIND_TEXT_MODEL: "claude-text-role",
      ANTHROPIC_API_KEY: "k",
    });

    const server = await built();
    expect(server.provider.model).toBe("claude-text-role");
    await server.app.close();
  });

  it("still falls back to the explanatory fake when nothing is configured", async () => {
    setEnv({});

    const server = await built();
    expect(server.provider.id).toBe("fake");
    await server.app.close();
  });

  it("falls back rather than running a session on a model that cannot call tools", async () => {
    // The text role's one requirement (design spec, "Provider independence").
    // An agent loop on a provider that throws `CapabilityUnavailable` on its
    // first turn is worse than one that says it is not configured.
    setEnv({
      SKETCHMIND_TEXT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_TOOL_CALLING: "false",
    });

    const server = await built();
    expect(server.provider.id).toBe("fake");
    await server.app.close();
  });

  it("leaves an explicitly injected provider alone", async () => {
    // What every other test in this directory depends on.
    setEnv({ SKETCHMIND_TEXT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" });
    const { pulleyProvider } = await import("./support.js");
    const injected = pulleyProvider();

    const server = await buildServer({
      provider: injected,
      store: new InMemoryStore(),
      config: testConfig(),
      logger: false,
    });
    expect(server.provider).toBe(injected);
    await server.app.close();
  });
});
