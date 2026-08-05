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
import { AzureOpenAIProvider } from "../src/provider.js";
import { registerAzureOpenAI, AZURE_OPENAI_PROVIDER_ID } from "../src/index.js";
import type { AzureOpenAIConfig } from "../src/internal/config.js";
import {
  apiError,
  functionCall,
  scripted,
  stubClient,
  stubResponse,
  textDeltas,
  type CreateHandler,
} from "./stub.js";

const BASE_CONFIG: AzureOpenAIConfig = {
  baseURL: "https://stub.services.ai.azure.com/openai/v1",
  deployment: "stub-deployment",
  auth: { kind: "api-key", apiKey: "secret" },
  capabilities: {
    structuredOutput: true,
    toolCalling: true,
    parallelToolCalls: true,
    streaming: true,
    vision: false,
    maxContextTokens: 128_000,
  },
  timeoutMs: 30_000,
};

/** Retries without waiting, so error-path tests stay fast. */
const FAST_RETRY = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, jitter: 0 };

function makeProvider(
  handler: CreateHandler,
  overrides: {
    capabilities?: Partial<LLMCapabilities>;
    logger?: ProviderLogger;
  } = {},
) {
  const stub = stubClient(handler);
  const provider = new AzureOpenAIProvider({
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
 * The same contract suite that runs against the fake, now driving the real
 * adapter code over a stubbed transport. Zero changes to the test body -- which
 * is the acceptance criterion, satisfied by construction (D-8).
 */
const CONTRACT_ANSWER = JSON.stringify({
  title: "Lever",
  category: "schematic",
  parts: [{ name: "beam", important: true }],
});

describeProviderContract("azure-openai (stubbed transport)", {
  make: () => {
    const handler: CreateHandler = (params) => {
      if (params.stream === true) return textDeltas("Count", " to", " three");
      if (params.tools && params.tools.length > 0) {
        return stubResponse({
          text: "",
          output: [functionCall("draw_shape", { shape: "circle", label: "wheel" })],
        });
      }
      if (params.text?.format?.type === "json_schema") {
        return stubResponse({ text: CONTRACT_ANSWER });
      }
      return stubResponse({ text: "A lever." });
    };
    return makeProvider(handler).provider;
  },
});

describe("complete", () => {
  it("sends the system prompt as `instructions` and messages as `input`", async () => {
    const { provider, stub } = makeProvider(scripted(stubResponse({ text: "hi" })));
    await provider.complete({
      system: "Be brief.",
      messages: [{ role: "user", content: "Hello." }],
      maxOutputTokens: 64,
      temperature: 0.2,
    });

    const params = stub.calls[0]!;
    expect(params.model).toBe("stub-deployment");
    expect(params.instructions).toBe("Be brief.");
    expect(params.input).toEqual([{ role: "user", content: "Hello." }]);
    expect(params.max_output_tokens).toBe(64);
    expect(params.temperature).toBe(0.2);
  });

  it("omits temperature when unset -- reasoning deployments reject an explicit one", async () => {
    const { provider, stub } = makeProvider(scripted(stubResponse()));
    await provider.complete({ messages: [{ role: "user", content: "Hi." }] });
    expect("temperature" in stub.calls[0]!).toBe(false);
  });

  it("never sends an api-version (AD-9)", async () => {
    const { provider, stub } = makeProvider(scripted(stubResponse()));
    await provider.complete({ messages: [{ role: "user", content: "Hi." }] });
    expect(JSON.stringify(stub.calls[0])).not.toMatch(/api.?version/i);
  });

  it("recomputes total tokens from its parts", async () => {
    const { provider } = makeProvider(
      scripted(stubResponse({ inputTokens: 100, outputTokens: 25 })),
    );
    const response = await provider.complete({ messages: [] });
    expect(response.usage).toEqual({ inputTokens: 100, outputTokens: 25, totalTokens: 125 });
  });

  it.each([
    ["max_output_tokens" as const, "length"],
    ["content_filter" as const, "content_filter"],
  ])("maps an incomplete response (%s) to finishReason %s", async (reason, expected) => {
    const { provider } = makeProvider(
      scripted(stubResponse({ status: "incomplete", incompleteReason: reason })),
    );
    expect((await provider.complete({ messages: [] })).finishReason).toBe(expected);
  });
});

describe("error handling", () => {
  it("retries a 429 and honours Retry-After", async () => {
    const { provider, stub } = makeProvider(
      scripted(apiError(429, { retryAfter: "0" }), stubResponse({ text: "recovered" })),
    );
    const response = await provider.complete({ messages: [] });
    expect(response.text).toBe("recovered");
    expect(stub.calls).toHaveLength(2);
  });

  it("fails fast on a content filter -- the same prompt fails the same way", async () => {
    const { provider, stub } = makeProvider(
      scripted(apiError(400, { code: "content_filter", message: "blocked" })),
    );
    const error = await provider.complete({ messages: [] }).catch((e: unknown) => e);
    expect((error as LLMProviderError).error.code).toBe(ProviderErrorCode.ContentFiltered);
    expect((error as LLMProviderError).error.recoverable).toBe(true);
    expect(stub.calls).toHaveLength(1);
  });

  it("treats a missing deployment as fatal configuration, not weather", async () => {
    const { provider, stub } = makeProvider(scripted(apiError(404, { message: "no deployment" })));
    const error = await provider.complete({ messages: [] }).catch((e: unknown) => e);
    expect((error as LLMProviderError).error.code).toBe(ProviderErrorCode.DeploymentNotFound);
    expect(stub.calls).toHaveLength(1);
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

describe("completeStructured", () => {
  const Schema = z.object({ title: z.string().min(1), count: z.number().int() });

  it("sends a strict json_schema with additionalProperties false", async () => {
    const { provider, stub } = makeProvider(
      scripted(stubResponse({ text: '{"title":"Lever","count":2}' })),
    );
    const result = await provider.completeStructured({
      messages: [{ role: "user", content: "Describe a lever." }],
      schema: Schema,
      name: "lever",
    });

    expect(result.value).toEqual({ title: "Lever", count: 2 });
    expect(result.mechanism).toBe("native");
    expect(result.repairAttempts).toBe(0);

    const format = stub.calls[0]!.text!.format as {
      type: string;
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
    expect(format.type).toBe("json_schema");
    expect(format.name).toBe("lever");
    expect(format.strict).toBe(true);
    expect(format.schema["additionalProperties"]).toBe(false);
    expect(format.schema["required"]).toEqual(["title", "count"]);
  });

  it("falls back to repair when a strict response still fails validation", async () => {
    // Strict mode is a constraint, not a guarantee: a truncated generation
    // arrives as valid-looking text. Failing the whole run over that would be
    // brittle.
    const { provider } = makeProvider(
      scripted(
        stubResponse({ text: '{"title":"Lever"}' }),
        stubResponse({ text: '{"title":"Lever","count":2}' }),
      ),
    );
    const result = await provider.completeStructured({
      messages: [],
      schema: Schema,
      name: "lever",
    });
    expect(result.mechanism).toBe("prompt-repair");
    expect(result.value).toEqual({ title: "Lever", count: 2 });
  });

  it("uses the prompt path outright when structured output is declared unavailable", async () => {
    const { provider, stub } = makeProvider(
      scripted(stubResponse({ text: '{"title":"Lever","count":2}' })),
      { capabilities: { structuredOutput: false } },
    );
    const result = await provider.completeStructured({
      messages: [],
      schema: Schema,
      name: "lever",
    });
    expect(result.mechanism).toBe("prompt-repair");
    expect(stub.calls[0]!.text).toBeUndefined();
    expect(String(stub.calls[0]!.instructions)).toContain("JSON Schema");
  });

  it("refuses an inexpressible schema before spending a call", async () => {
    const { provider, stub } = makeProvider(scripted(stubResponse()));
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
  it("parses tool arguments into an object", async () => {
    const { provider, stub } = makeProvider(
      scripted(
        stubResponse({ text: "", output: [functionCall("draw", { shape: "circle" })] }),
      ),
    );
    const response = await provider.completeWithTools({
      messages: [{ role: "user", content: "Draw a circle." }],
      tools: [
        {
          name: "draw",
          description: "Draw a shape.",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      ],
      toolChoice: "required",
    });

    expect(response.toolCalls).toEqual([
      { id: "call_draw", name: "draw", arguments: { shape: "circle" } },
    ]);
    expect(response.finishReason).toBe("tool_calls");
    expect(stub.calls[0]!.tool_choice).toBe("required");
    // Responses-API tools are flat, not nested under `function`.
    expect(stub.calls[0]!.tools![0]).toMatchObject({ type: "function", name: "draw" });
  });

  it("survives malformed tool arguments instead of throwing", async () => {
    const { provider } = makeProvider(
      scripted(stubResponse({ output: [functionCall("draw", "{not json")] })),
    );
    const response = await provider.completeWithTools({ messages: [], tools: [] });
    expect(response.toolCalls[0]!.arguments).toEqual({});
  });

  it("refuses when tool calling is declared unavailable", async () => {
    const { provider, stub } = makeProvider(scripted(stubResponse()), {
      capabilities: { toolCalling: false },
    });
    await expect(provider.completeWithTools({ messages: [], tools: [] })).rejects.toBeInstanceOf(
      LLMProviderError,
    );
    expect(stub.calls).toHaveLength(0);
  });
});

describe("stream", () => {
  it("yields deltas then a done marker", async () => {
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

  it("does not retry a stream -- partial output is already with the caller", async () => {
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
    const { provider, stub } = makeProvider(scripted(stubResponse()));
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
    expect((error as LLMProviderError).message).toContain("AZURE_OPENAI_VISION_DEPLOYMENT");
    // The guarantee is that no image is encoded or transmitted -- not merely
    // that an error is returned afterwards.
    expect(imagesRead).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it("sends a data URI once vision is enabled, with no code change", async () => {
    const { provider, stub } = makeProvider(scripted(stubResponse({ text: "Looks wrong." })), {
      capabilities: { vision: true },
    });
    await provider.completeWithImages({
      messages: [{ role: "user", content: "Critique this." }],
      images: [{ mimeType: "image/png", base64: "iVBORw0KGgo=" }],
    });

    const input = stub.calls[0]!.input as Array<{ content: Array<Record<string, unknown>> }>;
    expect(input[0]!.content).toContainEqual({
      type: "input_image",
      image_url: "data:image/png;base64,iVBORw0KGgo=",
      detail: "auto",
    });
  });
});

describe("logging (D-7)", () => {
  it("logs shape and latency, never prompt or output text", async () => {
    const entries: Array<{ message: string; fields?: LogFields }> = [];
    const record = (message: string, fields?: LogFields) => entries.push({ message, fields });
    const logger: ProviderLogger = {
      debug: record,
      info: record,
      warn: record,
      error: record,
    };

    const canary = "PULLEY_SECRET_CANARY";
    const { provider } = makeProvider(
      scripted(stubResponse({ text: `answer ${canary}` })),
      { logger },
    );
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

    await provider
      .complete({ messages: [{ role: "user", content: canary }] })
      .catch(() => undefined);

    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain(canary);
  });
});

describe("registration", () => {
  it("registers under the id the env var selects", () => {
    const registry = registerAzureOpenAI(new ProviderRegistry());
    expect(registry.ids()).toContain(AZURE_OPENAI_PROVIDER_ID);
  });

  it("surfaces misconfiguration when the registry constructs it", () => {
    const registry = registerAzureOpenAI(new ProviderRegistry());
    expect(() => registry.create(AZURE_OPENAI_PROVIDER_ID, {})).toThrow(LLMProviderError);
  });
});
