/**
 * Tool round trips on the wire (Phase 4, D-1).
 *
 * The assertions are about what the adapter *sends*, not what it returns. A loop
 * that replays its history as prose would still pass a return-value test and
 * still confuse the model on step three.
 */
import { describe, expect, it } from "vitest";
import type { AzureOpenAIConfig } from "../src/internal/config.js";
import { AzureOpenAIProvider } from "../src/provider.js";
import { stubClient, stubResponse, type CreateHandler } from "./stub.js";

const CONFIG: AzureOpenAIConfig = {
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

function makeProvider(handler: CreateHandler = () => stubResponse({ text: "ok" })) {
  const stub = stubClient(handler);
  const provider = new AzureOpenAIProvider({ config: CONFIG, client: stub.client });
  return { provider, stub };
}

describe("Azure tool-result translation", () => {
  it("emits a function_call item per assistant tool call, carrying JSON arguments", async () => {
    const { provider, stub } = makeProvider();

    await provider.complete({
      messages: [
        { role: "user", content: "Draw a circle." },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "draw_shape", arguments: { shape: "circle" } }],
        },
      ],
    });

    const input = stub.calls[0]!.input as unknown as Array<Record<string, unknown>>;
    const call = input.find((item) => item.type === "function_call");
    expect(call).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "draw_shape",
    });
    // Azure wants a JSON *string*; the adapter serializes so no caller has to.
    expect(JSON.parse(call!.arguments as string)).toEqual({ shape: "circle" });
  });

  it("omits the assistant text item when the turn was nothing but tool calls", async () => {
    const { provider, stub } = makeProvider();

    await provider.complete({
      messages: [
        { role: "user", content: "Draw a circle." },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "draw_shape", arguments: {} }],
        },
      ],
    });

    const input = stub.calls[0]!.input as unknown as Array<Record<string, unknown>>;
    // An empty assistant message is not a thing Azure wants to be told about.
    expect(input.filter((item) => item.role === "assistant")).toHaveLength(0);
    expect(input.filter((item) => item.type === "function_call")).toHaveLength(1);
  });

  it("keeps the assistant text alongside its tool calls when both are present", async () => {
    const { provider, stub } = makeProvider();

    await provider.complete({
      messages: [
        { role: "user", content: "Draw a circle." },
        {
          role: "assistant",
          content: "Drawing it now.",
          toolCalls: [{ id: "call_1", name: "draw_shape", arguments: {} }],
        },
      ],
    });

    const input = stub.calls[0]!.input as unknown as Array<Record<string, unknown>>;
    expect(input.filter((item) => item.role === "assistant")).toHaveLength(1);
    expect(input.filter((item) => item.type === "function_call")).toHaveLength(1);
  });

  it("emits a function_call_output keyed to the call id", async () => {
    const { provider, stub } = makeProvider();

    await provider.complete({
      messages: [
        { role: "user", content: "Draw a circle." },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "draw_shape", arguments: {} }],
        },
        { role: "tool", toolCallId: "call_1", toolName: "draw_shape", content: '{"ok":true}' },
      ],
    });

    const input = stub.calls[0]!.input as unknown as Array<Record<string, unknown>>;
    expect(input.find((item) => item.type === "function_call_output")).toMatchObject({
      type: "function_call_output",
      call_id: "call_1",
      output: '{"ok":true}',
    });
  });

  it("sends a failed tool result as an output too, not as an exception", async () => {
    const { provider, stub } = makeProvider();

    await provider.complete({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "draw_shape", arguments: {} }],
        },
        {
          role: "tool",
          toolCallId: "call_1",
          toolName: "draw_shape",
          content: "Unknown shape.",
          isError: true,
        },
      ],
    });

    const input = stub.calls[0]!.input as unknown as Array<Record<string, unknown>>;
    const output = input.find((item) => item.type === "function_call_output");
    // AD-2: the model has to see the failure to fix it. Azure has no error flag
    // on this item, so the text carries it -- and the text is what the model reads.
    expect(String(output!.output)).toContain("Unknown shape.");
  });

  it("returns empty text, never undefined, when a response carries no text output", async () => {
    // `CompletionResponse.text` is typed `string`, and a turn that was nothing
    // but tool calls can arrive with no text at all. Handing `undefined` upward
    // put a crash one step later in the agent loop, where the history is
    // replayed and its content read -- found exactly that way.
    const { provider } = makeProvider(
      () =>
        ({
          id: "resp_stub",
          model: "stub-deployment",
          status: "completed",
          output: [{ type: "function_call", call_id: "c1", name: "draw_shape", arguments: "{}" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }) as never,
    );

    const response = await provider.completeWithTools({
      messages: [{ role: "user", content: "Draw a circle." }],
      tools: [{ name: "draw_shape", description: "…", parameters: { type: "object" } }],
    });

    expect(response.text).toBe("");
    expect(response.toolCalls).toHaveLength(1);
  });

  it("preserves the order of a full call-and-result history", async () => {
    const { provider, stub } = makeProvider();

    await provider.complete({
      messages: [
        { role: "user", content: "Draw two shapes." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "draw_shape", arguments: { shape: "circle" } },
            { id: "call_2", name: "draw_shape", arguments: { shape: "square" } },
          ],
        },
        { role: "tool", toolCallId: "call_1", toolName: "draw_shape", content: "ok" },
        { role: "tool", toolCallId: "call_2", toolName: "draw_shape", content: "ok" },
        { role: "user", content: "Now label them." },
      ],
    });

    const input = stub.calls[0]!.input as unknown as Array<Record<string, unknown>>;
    expect(input.map((item) => item.type ?? item.role)).toEqual([
      "user",
      "function_call",
      "function_call",
      "function_call_output",
      "function_call_output",
      "user",
    ]);
  });
});
