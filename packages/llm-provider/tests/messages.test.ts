/**
 * The tool round trip (Phase 4, D-1).
 *
 * Phase 3 could ask a model to call a tool but had no way to tell it what came
 * back, which is fine until something actually runs a loop. These tests pin the
 * shape of the message union; the adapter suites prove each provider puts it on
 * the wire correctly.
 */
import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/fake.js";
import type { AssistantMessage, Message, ToolResultMessage } from "../src/types.js";

describe("Message union", () => {
  it("still accepts the plain two-arm shape Phase 3 used", () => {
    const messages: Message[] = [
      { role: "user", content: "Draw a lever." },
      { role: "assistant", content: "Certainly." },
    ];
    expect(messages).toHaveLength(2);
  });

  it("carries the tool calls an assistant turn made", () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "draw_shape", arguments: { shape: "circle" } }],
    };
    expect(message.toolCalls?.[0]?.name).toBe("draw_shape");
  });

  it("carries a tool result keyed to the call that produced it", () => {
    const message: ToolResultMessage = {
      role: "tool",
      toolCallId: "call_1",
      toolName: "draw_shape",
      content: JSON.stringify({ drawn: true }),
      isError: false,
    };
    expect(message.toolCallId).toBe("call_1");
  });

  it("marks a failed tool result, because AD-2 makes failure the interesting case", () => {
    const message: ToolResultMessage = {
      role: "tool",
      toolCallId: "call_1",
      toolName: "draw_shape",
      content: "Unknown shape 'dodecahedron'.",
      isError: true,
    };
    expect(message.isError).toBe(true);
  });
});

describe("FakeProvider with a tool round trip", () => {
  it("accepts a full call-and-result history and accounts for its tokens", async () => {
    const provider = new FakeProvider({ responses: ["Done."] });

    const response = await provider.complete({
      messages: [
        { role: "user", content: "Draw a circle." },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "draw_shape", arguments: { shape: "circle" } }],
        },
        { role: "tool", toolCallId: "call_1", toolName: "draw_shape", content: '{"ok":true}' },
      ],
    });

    expect(response.text).toBe("Done.");
    // Tool results are prompt tokens like anything else. A loop whose budget
    // ignored them would undercount every step after the first.
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.totalTokens).toBe(
      response.usage.inputTokens + response.usage.outputTokens,
    );
  });
});
