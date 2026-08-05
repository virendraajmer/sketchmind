import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  LLMProviderError,
  ProviderErrorCode,
  ProviderRegistry,
  type LLMCapabilities,
  type LogFields,
  type ProviderLogger,
} from "@sketchmind/llm-provider";
import { describeProviderContract } from "@sketchmind/llm-provider/testing";
import { AnthropicProvider } from "../src/provider.js";
import { ANTHROPIC_PROVIDER_ID, registerAnthropic } from "../src/index.js";
import type { AnthropicConfig } from "../src/internal/config.js";
import {
  apiError,
  scripted,
  stubClient,
  stubMessage,
  textDeltas,
  toolUse,
  type CreateHandler,
} from "./stub.js";

const BASE_CONFIG: AnthropicConfig = {
  apiKey: "sk-ant-secret",
  model: "stub-model",
  capabilities: {
    structuredOutput: false,
    toolCalling: true,
    parallelToolCalls: true,
    streaming: true,
    vision: false,
    maxContextTokens: 200_000,
  },
  timeoutMs: 30_000,
  defaultMaxOutputTokens: 4_096,
};

const FAST_RETRY = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, jitter: 0 };

function makeProvider(
  handler: CreateHandler,
  overrides: { capabilities?: Partial<LLMCapabilities>; logger?: ProviderLogger } = {},
) {
  const stub = stubClient(handler);
  const provider = new AnthropicProvider({
    config: {
      ...BASE_CONFIG,
      capabilities: { ...BASE_CONFIG.capabilities, ...overrides.capabilities },
    },
    client: stub.client,
    retryPolicy: FAST_RETRY,
    ...(overrides.logger ? { logger: overrides.logger } : {}),
  });
  return { provider, stub };
}

/**
 * The acceptance criterion, made literal: this is the same suite that runs
 * against the fake and against Azure, driving a provider whose structured
 * output works by a completely different mechanism. Not one line of the test
 * body knows that (D-8).
 */
const CONTRACT_ANSWER = {
  title: "Lever",
  category: "schematic",
  parts: [{ name: "beam", important: true }],
};

describeProviderContract("anthropic (stubbed transport)", {
  make: () => {
    const handler: CreateHandler = (params) => {
      if (params.stream === true) return textDeltas("Count", " to", " three");
      const tools = params.tools ?? [];
      if (tools.length > 0) {
        const tool = tools[0]!;
        const answer = tool.name === "draw_shape" ? { shape: "circle", label: "wheel" } : CONTRACT_ANSWER;
        return stubMessage({
          content: [toolUse(tool.name, answer)],
          stopReason: "tool_use",
        });
      }
      return stubMessage({ text: "A lever." });
    };
    return makeProvider(handler).provider;
  },
});

describe("complete", () => {
  it("sends `system` at the top level and always supplies max_tokens", async () => {
    const { provider, stub } = makeProvider(scripted(stubMessage({ text: "hi" })));
    await provider.complete({
      system: "Be brief.",
      messages: [{ role: "user", content: "Hello." }],
      temperature: 0.2,
      stop: ["END"],
    });

    const params = stub.calls[0]!;
    expect(params.model).toBe("stub-model");
    expect(params.system).toBe("Be brief.");
    expect(params.messages).toEqual([{ role: "user", content: "Hello." }]);
    expect(params.temperature).toBe(0.2);
    expect(params.stop_sequences).toEqual(["END"]);
    // The request named no budget; the API requires one regardless.
    expect(params.max_tokens).toBe(BASE_CONFIG.defaultMaxOutputTokens);
  });

  it("prefers the request's own output budget", async () => {
    const { provider, stub } = makeProvider(scripted(stubMessage()));
    await provider.complete({ messages: [], maxOutputTokens: 64 });
    expect(stub.calls[0]!.max_tokens).toBe(64);
  });

  it("concatenates text blocks and ignores everything else", async () => {
    const { provider } = makeProvider(
      scripted(
        stubMessage({
          content: [
            { type: "text", text: "Hello ", citations: null },
            toolUse("ignored", {}),
            { type: "text", text: "world", citations: null },
          ] as never,
        }),
      ),
    );
    expect((await provider.complete({ messages: [] })).text).toBe("Hello world");
  });

  it("recomputes total tokens -- Anthropic reports no total at all", async () => {
    const { provider } = makeProvider(scripted(stubMessage({ inputTokens: 100, outputTokens: 25 })));
    expect((await provider.complete({ messages: [] })).usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    });
  });

  it.each([
    ["end_turn" as const, "stop"],
    ["stop_sequence" as const, "stop"],
    ["max_tokens" as const, "length"],
    ["model_context_window_exceeded" as const, "length"],
    ["tool_use" as const, "tool_calls"],
    ["refusal" as const, "content_filter"],
  ])("maps stop_reason %s to finishReason %s", async (stopReason, expected) => {
    const { provider } = makeProvider(scripted(stubMessage({ stopReason })));
    expect((await provider.complete({ messages: [] })).finishReason).toBe(expected);
  });

  it("maps an absent stop_reason to unknown rather than guessing", async () => {
    const { provider } = makeProvider(scripted(stubMessage({ stopReason: null })));
    expect((await provider.complete({ messages: [] })).finishReason).toBe("unknown");
  });
});

describe("error handling", () => {
  it("retries a 429 and honours Retry-After", async () => {
    const { provider, stub } = makeProvider(
      scripted(apiError(429, { retryAfter: "0" }), stubMessage({ text: "recovered" })),
    );
    expect((await provider.complete({ messages: [] })).text).toBe("recovered");
    expect(stub.calls).toHaveLength(2);
  });

  it("does not retry an auth failure", async () => {
    const { provider, stub } = makeProvider(scripted(apiError(401)));
    await expect(provider.complete({ messages: [] })).rejects.toBeInstanceOf(LLMProviderError);
    expect(stub.calls).toHaveLength(1);
  });

  it("gives up after the retry budget on a persistent 500", async () => {
    const { provider, stub } = makeProvider(scripted(apiError(500)));
    await expect(provider.complete({ messages: [] })).rejects.toBeInstanceOf(LLMProviderError);
    expect(stub.calls).toHaveLength(FAST_RETRY.maxAttempts);
  });
});

describe("completeStructured by forced tool call (D-3)", () => {
  const Schema = z.object({ title: z.string().min(1), count: z.number().int() });

  it("names the schema as a tool and forces the model to call it", async () => {
    const { provider, stub } = makeProvider(
      scripted(
        stubMessage({ content: [toolUse("lever", { title: "Lever", count: 2 })], stopReason: "tool_use" }),
      ),
    );
    const result = await provider.completeStructured({
      messages: [{ role: "user", content: "Describe a lever." }],
      schema: Schema,
      name: "lever",
    });

    expect(result.value).toEqual({ title: "Lever", count: 2 });
    // The mechanism differs from Azure's; the return type does not.
    expect(result.mechanism).toBe("forced-tool");
    expect(result.repairAttempts).toBe(0);

    const params = stub.calls[0]!;
    expect(params.tool_choice).toEqual({ type: "tool", name: "lever" });
    const schema = (params.tools![0] as { input_schema: Record<string, unknown> }).input_schema;
    expect(schema["type"]).toBe("object");
    expect(schema["additionalProperties"]).toBe(false);
    expect(schema["required"]).toEqual(["title", "count"]);
  });

  it("validates the tool input rather than trusting the constraint", async () => {
    // A forced call is enforced by the provider; that is not the same as us
    // having checked it. A truncated argument object must still be caught.
    const { provider } = makeProvider(
      scripted(
        stubMessage({ content: [toolUse("lever", { title: "Lever" })], stopReason: "tool_use" }),
        stubMessage({ text: '{"title":"Lever","count":2}' }),
      ),
    );
    const result = await provider.completeStructured({ messages: [], schema: Schema, name: "lever" });
    expect(result.mechanism).toBe("prompt-repair");
    expect(result.value).toEqual({ title: "Lever", count: 2 });
  });

  it("repairs when the model answers in prose instead of calling the tool", async () => {
    const { provider } = makeProvider(
      scripted(stubMessage({ text: "I'd rather explain." }), stubMessage({ text: '{"title":"L","count":1}' })),
    );
    const result = await provider.completeStructured({ messages: [], schema: Schema, name: "lever" });
    expect(result.mechanism).toBe("prompt-repair");
  });

  it("goes straight to the prompt path when tool calling is unavailable", async () => {
    const { provider, stub } = makeProvider(
      scripted(stubMessage({ text: '{"title":"Lever","count":2}' })),
      { capabilities: { toolCalling: false } },
    );
    const result = await provider.completeStructured({ messages: [], schema: Schema, name: "lever" });
    expect(result.mechanism).toBe("prompt-repair");
    expect(stub.calls[0]!.tools).toBeUndefined();
    expect(String(stub.calls[0]!.system)).toContain("JSON Schema");
  });

  it("refuses an inexpressible schema before spending a call", async () => {
    const { provider, stub } = makeProvider(scripted(stubMessage()));
    const error = await provider
      .completeStructured({
        messages: [],
        schema: z.object({ bag: z.record(z.string(), z.unknown()) }),
        name: "bad",
      })
      .catch((e: unknown) => e);
    expect((error as LLMProviderError).error.code).toBe(ProviderErrorCode.Misconfigured);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("completeWithTools", () => {
  const TOOL = {
    name: "draw",
    description: "Draw a shape.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  };

  it("returns tool input as an object, matching the Azure adapter's contract", async () => {
    const { provider, stub } = makeProvider(
      scripted(stubMessage({ content: [toolUse("draw", { shape: "circle" })], stopReason: "tool_use" })),
    );
    const response = await provider.completeWithTools({
      messages: [{ role: "user", content: "Draw a circle." }],
      tools: [TOOL],
      toolChoice: "required",
    });

    expect(response.toolCalls).toEqual([
      { id: "toolu_draw", name: "draw", arguments: { shape: "circle" } },
    ]);
    expect(response.finishReason).toBe("tool_calls");
    // "required" is Anthropic's `any` -- some tool, not a named one.
    expect(stub.calls[0]!.tool_choice).toEqual({ type: "any" });
    expect(stub.calls[0]!.tools![0]).toMatchObject({ name: "draw", description: "Draw a shape." });
  });

  it.each([
    ["auto" as const, { type: "auto" }],
    ["none" as const, { type: "none" }],
  ])("translates toolChoice %s", async (choice, expected) => {
    const { provider, stub } = makeProvider(scripted(stubMessage()));
    await provider.completeWithTools({ messages: [], tools: [TOOL], toolChoice: choice });
    expect(stub.calls[0]!.tool_choice).toEqual(expected);
  });

  it("disables parallel tool use when the caller asks it to", async () => {
    const { provider, stub } = makeProvider(scripted(stubMessage()));
    await provider.completeWithTools({
      messages: [],
      tools: [TOOL],
      toolChoice: "auto",
      allowParallelCalls: false,
    });
    expect(stub.calls[0]!.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("refuses when tool calling is declared unavailable", async () => {
    const { provider, stub } = makeProvider(scripted(stubMessage()), {
      capabilities: { toolCalling: false },
    });
    await expect(provider.completeWithTools({ messages: [], tools: [] })).rejects.toBeInstanceOf(
      LLMProviderError,
    );
    expect(stub.calls).toHaveLength(0);
  });
});

describe("stream", () => {
  it("yields text deltas then a done marker", async () => {
    const { provider } = makeProvider(scripted(textDeltas("Hello", " world")));
    const deltas: string[] = [];
    let done = false;
    for await (const chunk of provider.stream({ messages: [] })) {
      if (chunk.done) done = true;
      else deltas.push(chunk.delta);
    }
    expect(deltas).toEqual(["Hello", " world"]);
    expect(done).toBe(true);
  });

  it("does not retry a stream", async () => {
    const { provider, stub } = makeProvider(scripted(apiError(500)));
    const iterate = async () => {
      for await (const _chunk of provider.stream({ messages: [] })) break;
    };
    await expect(iterate()).rejects.toBeInstanceOf(LLMProviderError);
    expect(stub.calls).toHaveLength(1);
  });
});

describe("image input (AD-3 / D-10)", () => {
  it("refuses before reading the images, and sends nothing", async () => {
    const { provider, stub } = makeProvider(scripted(stubMessage()));
    let imagesRead = false;
    const request = {
      messages: [{ role: "user" as const, content: "Critique this." }],
      get images() {
        imagesRead = true;
        return [{ mimeType: "image/png", base64: "iVBORw0KGgo=" }];
      },
    };

    const error = await provider.completeWithImages(request).catch((e: unknown) => e);
    expect((error as LLMProviderError).error.code).toBe(ProviderErrorCode.CapabilityUnavailable);
    expect((error as LLMProviderError).message).toContain("ANTHROPIC_VISION");
    expect(imagesRead).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it("sends a base64 source block once vision is enabled, with no code change", async () => {
    const { provider, stub } = makeProvider(scripted(stubMessage({ text: "Looks wrong." })), {
      capabilities: { vision: true },
    });
    await provider.completeWithImages({
      messages: [{ role: "user", content: "Critique this." }],
      images: [{ mimeType: "image/png", base64: "iVBORw0KGgo=" }],
    });

    const content = stub.calls[0]!.messages[0]!.content as unknown as Array<Record<string, unknown>>;
    expect(content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });
});

describe("logging (D-7)", () => {
  it("logs shape and latency, never prompt or output text", async () => {
    const entries: Array<{ message: string; fields?: LogFields }> = [];
    const record = (message: string, fields?: LogFields) => entries.push({ message, fields });
    const logger: ProviderLogger = { debug: record, info: record, warn: record, error: record };

    const canary = "PULLEY_SECRET_CANARY";
    const { provider } = makeProvider(scripted(stubMessage({ text: `answer ${canary}` })), { logger });
    await provider.complete({
      system: `You draw. ${canary}`,
      messages: [{ role: "user", content: `Draw a ${canary}` }],
    });

    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain(canary);
    expect(entries.some((e) => e.fields?.["latencyMs"] !== undefined)).toBe(true);
  });

  it("logs no prompt text when the call fails either", async () => {
    const error = vi.fn();
    const logger: ProviderLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error };
    const canary = "FAILURE_CANARY";
    const { provider } = makeProvider(scripted(apiError(401)), { logger });

    await provider.complete({ messages: [{ role: "user", content: canary }] }).catch(() => undefined);

    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain(canary);
  });
});

describe("registration", () => {
  it("registers under the id the env var selects", () => {
    const registry = registerAnthropic(new ProviderRegistry());
    expect(registry.ids()).toContain(ANTHROPIC_PROVIDER_ID);
  });

  it("surfaces misconfiguration when the registry constructs it", () => {
    const registry = registerAnthropic(new ProviderRegistry());
    expect(() => registry.create(ANTHROPIC_PROVIDER_ID, {})).toThrow(LLMProviderError);
  });
});
