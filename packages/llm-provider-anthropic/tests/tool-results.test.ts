/**
 * Tool round trips on the wire (Phase 4, D-1).
 *
 * Anthropic is the reason this feature is an interface change rather than a
 * convenience: it *rejects* a `tool_result` whose matching `tool_use` is missing
 * from the history, and it wants every result from one parallel batch inside a
 * single user turn. Text-encoding the history would fail here and nowhere else.
 */
import { describe, expect, it } from "vitest";
import type { AnthropicConfig } from "../src/internal/config.js";
import { AnthropicProvider } from "../src/provider.js";
import { stubClient, stubMessage, type CreateHandler } from "./stub.js";

const CONFIG: AnthropicConfig = {
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

function makeProvider(handler: CreateHandler = () => stubMessage({ text: "ok" })) {
  const stub = stubClient(handler);
  const provider = new AnthropicProvider({ config: CONFIG, client: stub.client });
  return { provider, stub };
}

type Block = Record<string, unknown>;

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

describe("Anthropic tool-result translation", () => {
  it("nests tool_use blocks inside the assistant turn that made them", async () => {
    const { provider, stub } = makeProvider();

    await provider.complete({
      messages: [
        { role: "user", content: "Draw a circle." },
        {
          role: "assistant",
          content: "Drawing it now.",
          toolCalls: [{ id: "toolu_1", name: "draw_shape", arguments: { shape: "circle" } }],
        },
      ],
    });

    const assistant = stub.calls[0]!.messages[1]!;
    expect(assistant.role).toBe("assistant");
    const blocks = blocksOf(assistant.content);
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use"]);
    // Anthropic takes the input already parsed -- the mirror image of Azure,
    // which wants a JSON string. Neither fact escapes its adapter.
    expect(blocks[1]).toMatchObject({
      type: "tool_use",
      id: "toolu_1",
      name: "draw_shape",
      input: { shape: "circle" },
    });
  });

  it("drops the empty text block when the turn was nothing but tool calls", async () => {
    const { provider, stub } = makeProvider();

    await provider.complete({
      messages: [
        { role: "user", content: "Draw a circle." },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "toolu_1", name: "draw_shape", arguments: {} }],
        },
      ],
    });

    // An empty text block is a 400 from this API, not a harmless no-op.
    expect(blocksOf(stub.calls[0]!.messages[1]!.content).map((b) => b.type)).toEqual(["tool_use"]);
  });

  it("sends a tool result as a tool_result block in a user turn", async () => {
    const { provider, stub } = makeProvider();

    await provider.complete({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "toolu_1", name: "draw_shape", arguments: {} }],
        },
        { role: "tool", toolCallId: "toolu_1", toolName: "draw_shape", content: '{"ok":true}' },
      ],
    });

    const result = stub.calls[0]!.messages[1]!;
    expect(result.role).toBe("user");
    expect(blocksOf(result.content)[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: '{"ok":true}',
    });
  });

  it("flags a failed tool result with is_error rather than hiding it in prose", async () => {
    const { provider, stub } = makeProvider();

    await provider.complete({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "toolu_1", name: "draw_shape", arguments: {} }],
        },
        {
          role: "tool",
          toolCallId: "toolu_1",
          toolName: "draw_shape",
          content: "Unknown shape.",
          isError: true,
        },
      ],
    });

    expect(blocksOf(stub.calls[0]!.messages[1]!.content)[0]).toMatchObject({
      type: "tool_result",
      is_error: true,
    });
  });

  it("merges a parallel batch of results into one user turn", async () => {
    const { provider, stub } = makeProvider();

    await provider.complete({
      messages: [
        { role: "user", content: "Draw two shapes." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "toolu_1", name: "draw_shape", arguments: { shape: "circle" } },
            { id: "toolu_2", name: "draw_shape", arguments: { shape: "square" } },
          ],
        },
        { role: "tool", toolCallId: "toolu_1", toolName: "draw_shape", content: "ok" },
        { role: "tool", toolCallId: "toolu_2", toolName: "draw_shape", content: "ok" },
        { role: "user", content: "Now label them." },
      ],
    });

    const messages = stub.calls[0]!.messages;
    // Four turns, not five: both results belong to the same user turn, which is
    // what this API requires after a parallel tool_use turn.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    const results = blocksOf(messages[2]!.content);
    expect(results).toHaveLength(2);
    expect(results.map((b) => b.tool_use_id)).toEqual(["toolu_1", "toolu_2"]);
  });
});
