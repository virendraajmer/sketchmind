import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CompletionRequest, CompletionResponse, StructuredRequest } from "../src/types.js";
import {
  completeStructuredViaPrompt,
  extractJson,
} from "../src/internal/structured.js";
import { LLMProviderError } from "../src/types.js";
import { ProviderErrorCode } from "../src/internal/errors.js";

const PKG = "@sketchmind/llm-provider-test";

const Target = z.object({
  title: z.string().min(1),
  count: z.number().int().min(1),
  note: z.string().optional(),
});

function responder(...texts: string[]) {
  const seen: CompletionRequest[] = [];
  let index = 0;
  const complete = async (req: CompletionRequest): Promise<CompletionResponse> => {
    seen.push(req);
    const text = texts[Math.min(index, texts.length - 1)] ?? "";
    index += 1;
    return {
      text,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: "test",
      finishReason: "stop",
    };
  };
  return { complete, seen };
}

function request(overrides: Partial<StructuredRequest<typeof Target>> = {}) {
  return {
    messages: [{ role: "user" as const, content: "Describe something." }],
    schema: Target,
    name: "target",
    ...overrides,
  };
}

describe("extractJson", () => {
  it("takes a bare object", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it("unwraps a fenced block", () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```\nDone.')).toBe('{"a":1}');
  });

  it("finds an object buried in prose", () => {
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toBe('{"a":1}');
  });

  it("keeps nested objects whole", () => {
    expect(extractJson('{"a":{"b":{"c":1}}}')).toBe('{"a":{"b":{"c":1}}}');
  });

  it("is not fooled by braces inside strings", () => {
    // A label like "}" would otherwise close the object early and the caller
    // would parse a truncated fragment.
    const json = '{"label":"a } b","n":1}';
    expect(extractJson(json)).toBe(json);
  });

  it("is not fooled by escaped quotes", () => {
    const json = '{"label":"say \\"hi\\" }","n":1}';
    expect(extractJson(json)).toBe(json);
  });

  it("returns undefined when there is no object at all", () => {
    expect(extractJson("I would rather not.")).toBeUndefined();
    expect(extractJson("")).toBeUndefined();
  });

  it("returns undefined for an unterminated object", () => {
    expect(extractJson('{"a":1')).toBeUndefined();
  });
});

describe("completeStructuredViaPrompt", () => {
  it("returns a validated value on the first attempt", async () => {
    const { complete, seen } = responder('{"title":"Lever","count":2}');
    const result = await completeStructuredViaPrompt(request(), complete, PKG);

    expect(result.value).toEqual({ title: "Lever", count: 2 });
    expect(result.repairAttempts).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("injects the schema into the system prompt", async () => {
    const { complete, seen } = responder('{"title":"Lever","count":2}');
    await completeStructuredViaPrompt(
      request({ system: "You are a teacher.", description: "a diagram" }),
      complete,
      PKG,
    );

    const system = seen[0]!.system ?? "";
    expect(system).toContain("You are a teacher.");
    expect(system).toContain('"title"');
    expect(system).toContain("a diagram");
  });

  it("feeds validation errors back and succeeds on the retry", async () => {
    const { complete, seen } = responder(
      '{"title":"Lever"}', // missing `count`
      '{"title":"Lever","count":3}',
    );
    const result = await completeStructuredViaPrompt(request(), complete, PKG);

    expect(result.value).toEqual({ title: "Lever", count: 3 });
    expect(result.repairAttempts).toBe(1);

    // The repair turn must name the field. Retrying an identical prompt is
    // hoping; showing the model its own error is instruction.
    const repairTurn = seen[1]!.messages.at(-1)!.content;
    expect(repairTurn).toContain("count");
    expect(seen[1]!.messages.some((m) => m.role === "assistant")).toBe(true);
  });

  it("recovers from a response that is not JSON at all", async () => {
    const { complete } = responder("I'd rather explain in words.", '{"title":"A","count":1}');
    const result = await completeStructuredViaPrompt(request(), complete, PKG);
    expect(result.repairAttempts).toBe(1);
    expect(result.value.title).toBe("A");
  });

  it("recovers from malformed JSON", async () => {
    const { complete } = responder('{"title":"A", "count":}', '{"title":"A","count":1}');
    const result = await completeStructuredViaPrompt(request(), complete, PKG);
    expect(result.repairAttempts).toBe(1);
  });

  it("strips the nullable-for-optional encoding before validating", async () => {
    // Strict mode forces optional fields to be present-and-null. Zod's
    // `.optional()` accepts undefined, not null, so without decoding this fails.
    const { complete } = responder('{"title":"A","count":1,"note":null}');
    const result = await completeStructuredViaPrompt(request(), complete, PKG);
    expect(result.value).toEqual({ title: "A", count: 1 });
    expect("note" in result.value).toBe(false);
  });

  it("gives up after the configured attempts, as a recoverable observation", async () => {
    const complete = vi.fn(async () => ({
      text: "no.",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: "test",
      finishReason: "stop" as const,
    }));

    const error = await completeStructuredViaPrompt(
      request({ maxRepairAttempts: 1 }),
      complete,
      PKG,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LLMProviderError);
    const providerFailure = error as LLMProviderError;
    expect(providerFailure.error.code).toBe(ProviderErrorCode.InvalidOutput);
    // AD-2: the agent can rephrase or simplify, so this is an observation.
    expect(providerFailure.error.recoverable).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2); // 1 initial + 1 repair
  });

  it("refuses a schema no provider could constrain, before spending a call", async () => {
    const complete = vi.fn();
    const error = await completeStructuredViaPrompt(
      {
        messages: [{ role: "user", content: "go" }],
        schema: z.object({ bag: z.record(z.string(), z.unknown()) }),
        name: "bad",
      },
      complete,
      PKG,
    ).catch((e: unknown) => e);

    expect((error as LLMProviderError).error.code).toBe(ProviderErrorCode.Misconfigured);
    expect(complete).not.toHaveBeenCalled();
  });
});
