import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeProvider, fakeReturning } from "../src/fake.js";
import {
  DEFAULT_PROVIDER_ID,
  PROVIDER_ENV_VAR,
  ProviderRegistry,
  createProviderFromEnv,
} from "../src/registry.js";
import { describeProviderContract } from "../src/testing/contract.js";
import { describeRequest, noopLogger } from "../src/logging.js";
import { LLMProviderError } from "../src/types.js";
import { ProviderErrorCode } from "../src/internal/errors.js";

/**
 * The contract suite, run twice against the same implementation with different
 * capabilities. The second run is what keeps the repair fallback alive: without
 * it, `structuredOutput: false` is untested code that only a future local model
 * would ever discover was broken.
 */
const contractAnswer = JSON.stringify({
  title: "Lever",
  category: "schematic",
  parts: [
    { name: "beam", important: true },
    { name: "fulcrum", important: true },
  ],
});

describeProviderContract("fake (native structured output)", {
  make: () =>
    new FakeProvider({
      responses: [contractAnswer, "circle"],
      toolCalls: [[{ id: "call_1", name: "draw_shape", arguments: { shape: "circle", label: "wheel" } }]],
    }),
});

describeProviderContract("fake (no native structured output -- repair path)", {
  make: () =>
    new FakeProvider({
      capabilities: { structuredOutput: false },
      responses: [contractAnswer, "circle"],
      toolCalls: [[{ id: "call_1", name: "draw_shape", arguments: { shape: "circle", label: "wheel" } }]],
    }),
});

describe("FakeProvider", () => {
  it("reports which mechanism produced the value", async () => {
    const native = new FakeProvider({ responses: ['{"a":1}'] });
    const weak = new FakeProvider({
      capabilities: { structuredOutput: false },
      responses: ['{"a":1}'],
    });
    const schema = z.object({ a: z.number() });

    expect((await native.completeStructured({ messages: [], schema, name: "a" })).mechanism).toBe(
      "native",
    );
    expect((await weak.completeStructured({ messages: [], schema, name: "a" })).mechanism).toBe(
      "prompt-repair",
    );
  });

  it("records every request, so callers can assert what was sent", async () => {
    const provider = new FakeProvider({ responses: ["hi"] });
    await provider.complete({ messages: [{ role: "user", content: "hello" }] });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.messages[0]!.content).toBe("hello");
  });

  it("repeats its last scripted response once the queue runs out", async () => {
    const provider = new FakeProvider({ responses: ["one", "two"] });
    const texts = [];
    for (let i = 0; i < 4; i += 1) {
      texts.push((await provider.complete({ messages: [] })).text);
    }
    expect(texts).toEqual(["one", "two", "two", "two"]);
  });

  it("refuses capabilities it does not declare", async () => {
    const provider = new FakeProvider({
      capabilities: { toolCalling: false, streaming: false },
    });
    await expect(
      provider.completeWithTools({ messages: [], tools: [] }),
    ).rejects.toBeInstanceOf(LLMProviderError);

    const iterate = async () => {
      for await (const _chunk of provider.stream({ messages: [] })) break;
    };
    await expect(iterate()).rejects.toBeInstanceOf(LLMProviderError);
  });

  it("rejects a schema Azure would reject, rather than passing where Azure fails", async () => {
    // A fake that accepted everything would let a broken schema reach
    // production having passed the whole suite.
    const provider = new FakeProvider({ responses: ["{}"] });
    const error = await provider
      .completeStructured({
        messages: [],
        schema: z.object({ bag: z.record(z.string(), z.unknown()) }),
        name: "bad",
      })
      .catch((e: unknown) => e);
    expect((error as LLMProviderError).error.code).toBe(ProviderErrorCode.Misconfigured);
  });

  it("fakeReturning answers with the value you gave it", async () => {
    const schema = z.object({ n: z.number() });
    const provider = fakeReturning({ n: 42 });
    const result = await provider.completeStructured({ messages: [], schema, name: "n" });
    expect(result.value).toEqual({ n: 42 });
  });
});

describe("ProviderRegistry", () => {
  const makeRegistry = () =>
    new ProviderRegistry()
      .register("azure-openai", () => new FakeProvider({ id: "azure-openai" }))
      .register("anthropic", () => new FakeProvider({ id: "anthropic" }));

  it("selects the provider named by the env var", () => {
    const provider = createProviderFromEnv(makeRegistry(), {
      [PROVIDER_ENV_VAR]: "anthropic",
    });
    expect(provider.id).toBe("anthropic");
  });

  it("switching providers is exactly one env var, no code change", () => {
    const registry = makeRegistry();
    const before = createProviderFromEnv(registry, { [PROVIDER_ENV_VAR]: "azure-openai" });
    const after = createProviderFromEnv(registry, { [PROVIDER_ENV_VAR]: "anthropic" });
    expect(before.id).not.toBe(after.id);
  });

  it("falls back to the default when the var is absent or blank", () => {
    const registry = makeRegistry();
    expect(createProviderFromEnv(registry, {}).id).toBe(DEFAULT_PROVIDER_ID);
    expect(createProviderFromEnv(registry, { [PROVIDER_ENV_VAR]: "  " }).id).toBe(
      DEFAULT_PROVIDER_ID,
    );
  });

  it("names the registered options when asked for one that is not there", () => {
    const registry = makeRegistry();
    const error = (() => {
      try {
        registry.create("ollama", {});
      } catch (e) {
        return e as LLMProviderError;
      }
      return undefined;
    })();

    expect(error?.error.code).toBe(ProviderErrorCode.Misconfigured);
    expect(error?.message).toContain("anthropic");
    expect(error?.message).toContain("azure-openai");
  });

  it("hands the adapter the environment rather than letting it read process.env", () => {
    const factory = vi.fn(() => new FakeProvider());
    const registry = new ProviderRegistry().register("x", factory);
    registry.create("x", { SOME_KEY: "value" });
    expect(factory).toHaveBeenCalledWith({ SOME_KEY: "value" });
  });
});

describe("logging (D-7)", () => {
  it("describes shape and never content", () => {
    const canary = "PULLEY_SECRET_CANARY";
    const fields = describeRequest({
      system: `You draw diagrams. ${canary}`,
      messages: [{ content: `Draw a ${canary}` }],
      maxOutputTokens: 100,
    });

    expect(JSON.stringify(fields)).not.toContain(canary);
    expect(fields).toMatchObject({ messageCount: 1, hasSystemPrompt: true });
    expect(fields["promptChars"]).toBeGreaterThan(0);
  });

  it("noopLogger accepts every level without throwing", () => {
    expect(() => {
      noopLogger.debug("a");
      noopLogger.info("b");
      noopLogger.warn("c");
      noopLogger.error("d");
    }).not.toThrow();
  });
});
