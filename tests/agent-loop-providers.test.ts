/**
 * The agent loop is provider-independent (Phase 4 acceptance).
 *
 * There is one copy of the loop body's expectations, parameterised by a provider
 * factory -- the same construction Phase 3 used for `describeProviderContract`
 * (D-8), for the same reason: "it works against a real provider too" is a claim
 * that decays the moment the two suites are allowed to drift.
 *
 * The real adapters run over stubbed transports, so this makes no network call
 * and needs no key. What it proves is that the loop's *translation* survives a
 * real adapter -- which is exactly what the tool-result round trip (D-1) put at
 * risk, since Anthropic rejects an unmatched `tool_result` outright.
 *
 * This is also the one place in the repo where an agent package and a concrete
 * provider package meet. It is a test, not source: the Global Constraint that no
 * provider type reaches an agent package still holds in `packages/`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeProvider, type LLMProvider } from "@sketchmind/llm-provider";
import { ToolRegistry, defineTool, runAgent } from "@sketchmind/agent-core";
import { AzureOpenAIProvider } from "@sketchmind/llm-provider-azure-openai";
import { AnthropicProvider } from "@sketchmind/llm-provider-anthropic";

// This file proves the loop against real adapters over a *stand-in* transport
// -- the same stubbing Phase 3's own adapter suites use -- so it deliberately
// stops short of importing `openai` or `@anthropic-ai/sdk`. Naming either SDK
// type here, even for a stub, is exactly the leak the lint rule (Global
// Constraints: LLM independence) exists to catch outside `llm-provider-*`;
// `never` satisfies the adapters' optional `client` parameter without it.

/**
 * The script every provider plays out: look something up, then draw it, then
 * answer. Written once so no adapter can be held to a weaker standard.
 */
const SCRIPT = [
  { text: "Let me look up the parts.", call: { name: "look_up", args: { machine: "lever" } } },
  { text: "Now the beam.", call: { name: "draw", args: { part: "beam" } } },
  { text: "The lever is drawn.", call: undefined },
] as const;

function makeRegistry(log: string[]): ToolRegistry {
  return new ToolRegistry([
    defineTool({
      name: "look_up",
      description: "Look up the parts of a machine.",
      locus: "server",
      readOnly: true,
      argsSchema: z.object({ machine: z.string() }),
      handler: async (args) => {
        log.push(`look_up:${args.machine}`);
        return { parts: ["beam", "fulcrum"] };
      },
    }),
    defineTool({
      name: "draw",
      description: "Draw a named part.",
      locus: "server",
      argsSchema: z.object({ part: z.string() }),
      handler: async (args) => {
        log.push(`draw:${args.part}`);
        return { drawn: args.part };
      },
    }),
  ]);
}

/** Advances through SCRIPT once per call, whatever the provider's wire format. */
function scriptCursor() {
  let index = 0;
  return () => SCRIPT[Math.min(index++, SCRIPT.length - 1)]!;
}

function makeFake(sent: unknown[]): LLMProvider {
  // The fake consumes its queues in order, so both are laid out up front. The
  // responder is a function purely so it records the request, keeping the
  // "history was accepted three times" assertion identical across providers.
  return new FakeProvider({
    responses: SCRIPT.map((entry) => (req) => {
      sent.push(req);
      return entry.text;
    }),
    toolCalls: SCRIPT.map((entry, i) =>
      entry.call ? [{ id: `c${i}`, name: entry.call.name, arguments: entry.call.args }] : [],
    ),
  });
}

function makeAzure(sent: unknown[]): LLMProvider {
  const next = scriptCursor();
  const client = {
    responses: {
      create: async (params: unknown) => {
        sent.push(params);
        const entry = next();
        return {
          id: "resp_stub",
          model: "stub-deployment",
          status: "completed",
          // The SDK exposes the flattened text here; the adapter reads it.
          output_text: entry.text,
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: entry.text }] },
            ...(entry.call
              ? [
                  {
                    type: "function_call",
                    call_id: `c${SCRIPT.indexOf(entry)}`,
                    name: entry.call.name,
                    arguments: JSON.stringify(entry.call.args),
                  },
                ]
              : []),
          ],
          usage: { input_tokens: 20, output_tokens: 8 },
        };
      },
    },
  } as never;

  return new AzureOpenAIProvider({
    config: {
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
    },
    client,
  });
}

function makeAnthropic(sent: unknown[]): LLMProvider {
  const next = scriptCursor();
  const client = {
    messages: {
      create: async (params: unknown) => {
        sent.push(params);
        const entry = next();
        return {
          id: "msg_stub",
          type: "message",
          role: "assistant",
          model: "stub-model",
          content: [
            { type: "text", text: entry.text, citations: null },
            ...(entry.call
              ? [
                  {
                    type: "tool_use",
                    id: `c${SCRIPT.indexOf(entry)}`,
                    name: entry.call.name,
                    input: entry.call.args,
                  },
                ]
              : []),
          ],
          stop_reason: entry.call ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 8 },
        };
      },
    },
  } as never;

  return new AnthropicProvider({
    config: {
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
    },
    client,
  });
}

const PROVIDERS: Array<{ name: string; make: (sent: unknown[]) => LLMProvider }> = [
  { name: "fake", make: makeFake },
  { name: "azure-openai (stubbed transport)", make: makeAzure },
  { name: "anthropic (stubbed transport)", make: makeAnthropic },
];

describe.each(PROVIDERS)("runAgent against $name", ({ make }) => {
  it("completes the same multi-step goal with the same trace shape", async () => {
    const log: string[] = [];
    const sent: unknown[] = [];

    const result = await runAgent({
      sessionId: "session-1",
      goal: "Draw a lever.",
      provider: make(sent),
      registry: makeRegistry(log),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("The lever is drawn.");
    // Same tools, same order, regardless of what the wire looked like.
    expect(log).toEqual(["look_up:lever", "draw:beam"]);
    expect(result.trace.steps.map((s) => s.toolName)).toEqual(["look_up", "draw", undefined]);
    expect(result.trace.totalTokensIn).toBeGreaterThan(0);
  });

  it("survives replaying its own tool history on every step (D-1)", async () => {
    const sent: unknown[] = [];

    const result = await runAgent({
      sessionId: "session-1",
      goal: "Draw a lever.",
      provider: make(sent),
      registry: makeRegistry([]),
    });

    expect(result.status).toBe("completed");
    // Three model calls: the history grew each time and was accepted each time.
    // Anthropic would have rejected an unmatched tool_result outright, which is
    // precisely the failure this test exists to catch.
    expect(sent).toHaveLength(3);
    expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });
});
