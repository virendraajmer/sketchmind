/**
 * The agent loop (AD-1, AD-2, AD-4, AD-8).
 *
 * Every Phase 4 acceptance criterion is asserted here. The provider is the fake
 * from `llm-provider`, scripted with the tool calls a real model would make, so
 * the whole suite runs with no network and no key.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeProvider, type ToolCall } from "@sketchmind/llm-provider";
import { runAgent } from "../src/loop.js";
import { ToolRegistry, defineTool } from "../src/tools.js";

/** Two fake tools, per the acceptance criterion. */
function makeTools(calls: string[] = []) {
  const lookUp = defineTool({
    name: "look_up",
    description: "Look up the parts of a machine.",
    locus: "server",
    readOnly: true,
    argsSchema: z.object({ machine: z.string() }),
    handler: async (args) => {
      calls.push(`look_up:${args.machine}`);
      return { parts: ["beam", "fulcrum"] };
    },
  });

  const draw = defineTool({
    name: "draw",
    description: "Draw a named part.",
    locus: "server",
    argsSchema: z.object({ part: z.string() }),
    handler: async (args) => {
      calls.push(`draw:${args.part}`);
      return { drawn: args.part };
    },
  });

  return { lookUp, draw, registry: new ToolRegistry([lookUp, draw]) };
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

const GOAL = "Draw a lever.";

describe("runAgent: the multi-step goal", () => {
  it("completes a multi-step goal and emits a full trace", async () => {
    const calls: string[] = [];
    const { registry } = makeTools(calls);

    const provider = new FakeProvider({
      responses: ["Let me look up the parts.", "Now I will draw the beam.", "The lever is drawn."],
      toolCalls: [
        [call("c1", "look_up", { machine: "lever" })],
        [call("c2", "draw", { part: "beam" })],
        [], // No tool calls: the model is answering, so the run is done.
      ],
    });

    const onStep = vi.fn();
    const result = await runAgent({
      sessionId: "session-1",
      goal: GOAL,
      provider,
      registry,
      onStep,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("The lever is drawn.");
    expect(calls).toEqual(["look_up:lever", "draw:beam"]);

    // Two tool steps plus the final answer.
    expect(result.trace.steps).toHaveLength(3);
    expect(onStep).toHaveBeenCalledTimes(3);

    // Every field populated: a trace with holes in it is how an autonomous
    // agent becomes unauditable (AD-8).
    const [first] = result.trace.steps;
    expect(first).toMatchObject({
      locus: "server",
      toolName: "look_up",
      toolArgs: { machine: "lever" },
    });
    expect(first!.stepId).toBeTruthy();
    expect(first!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first!.durationMs).toBeGreaterThanOrEqual(0);
    expect(first!.thought).toBe("Let me look up the parts.");
    expect(first!.toolResult).toEqual({ parts: ["beam", "fulcrum"] });

    // Totals are the sum of the steps, not a separate guess.
    expect(result.trace.totalTokensIn).toBe(
      result.trace.steps.reduce((sum, s) => sum + s.tokensIn, 0),
    );
    expect(result.trace.totalTokensOut).toBeGreaterThan(0);
  });

  it("streams each step as it happens rather than only at the end (D-6)", async () => {
    const { registry } = makeTools();
    const seen: string[] = [];

    const provider = new FakeProvider({
      responses: ["Looking.", "Done."],
      toolCalls: [[call("c1", "look_up", { machine: "lever" })], []],
    });

    await runAgent({
      sessionId: "session-1",
      goal: GOAL,
      provider,
      registry,
      // This callback is the entire integration surface Phase 9's SSE needs.
      onStep: (step) => seen.push(step.toolName ?? "<answer>"),
    });

    expect(seen).toEqual(["look_up", "<answer>"]);
  });

  it("replays its own tool calls and results back to the model (D-1)", async () => {
    const { registry } = makeTools();
    const provider = new FakeProvider({
      responses: ["Looking.", "Done."],
      toolCalls: [[call("c1", "look_up", { machine: "lever" })], []],
    });

    await runAgent({ sessionId: "session-1", goal: GOAL, provider, registry });

    // The second request must carry the history natively, or a real Anthropic
    // provider would reject it outright.
    const second = provider.calls[1]!;
    const assistant = second.messages.find((m) => m.role === "assistant");
    const toolResult = second.messages.find((m) => m.role === "tool");
    expect(assistant).toMatchObject({ toolCalls: [{ id: "c1", name: "look_up" }] });
    expect(toolResult).toMatchObject({ toolCallId: "c1", toolName: "look_up", isError: false });
  });
});

describe("runAgent: failure as observation (AD-2)", () => {
  it("recovers from a tool that throws, and the run does not fail", async () => {
    const explodes = defineTool({
      name: "explodes",
      description: "Throws once.",
      locus: "server",
      argsSchema: z.object({}),
      handler: async () => {
        throw new Error("the renderer is on fire");
      },
    });
    const { draw } = makeTools();
    const registry = new ToolRegistry([explodes, draw]);

    const provider = new FakeProvider({
      responses: ["Trying the risky one.", "I will draw instead.", "Recovered."],
      toolCalls: [[call("c1", "explodes", {})], [call("c2", "draw", { part: "beam" })], []],
    });

    const result = await runAgent({ sessionId: "session-1", goal: GOAL, provider, registry });

    expect(result.status).toBe("completed");
    // The error step, then a successful step: recovery visible in the trace.
    expect(result.trace.steps[0]!.error?.code).toBe("TOOL_THREW");
    expect(result.trace.steps[1]!.toolName).toBe("draw");
    expect(result.trace.steps[1]!.error).toBeUndefined();

    // And the model was actually told, in a form it can act on.
    const secondRequest = provider.calls[1]!;
    const observation = secondRequest.messages.find((m) => m.role === "tool");
    expect(observation).toMatchObject({ isError: true });
    expect((observation as { content: string }).content).toContain("the renderer is on fire");
  });

  it("treats a call to a nonexistent tool as an observation, not a crash", async () => {
    const { registry } = makeTools();
    const provider = new FakeProvider({
      responses: ["Guessing.", "Corrected."],
      toolCalls: [[call("c1", "look_upp", { machine: "lever" })], []],
    });

    const result = await runAgent({ sessionId: "session-1", goal: GOAL, provider, registry });

    expect(result.status).toBe("completed");
    expect(result.trace.steps[0]!.error?.code).toBe("TOOL_NOT_FOUND");
    const observation = provider.calls[1]!.messages.find((m) => m.role === "tool");
    // Naming the real tools is what makes this fixable in one step.
    expect((observation as { content: string }).content).toContain("look_up");
  });

  it("treats schema-invalid arguments as an observation", async () => {
    const { registry } = makeTools();
    const provider = new FakeProvider({
      responses: ["Guessing.", "Corrected."],
      toolCalls: [[call("c1", "look_up", { machin: "lever" })], []],
    });

    const result = await runAgent({ sessionId: "session-1", goal: GOAL, provider, registry });

    expect(result.status).toBe("completed");
    expect(result.trace.steps[0]!.error?.code).toBe("SCHEMA_INVALID");
  });
});

describe("runAgent: budgets (AD-8)", () => {
  /** A model that never stops calling tools -- the runaway case budgets exist for. */
  function runawayProvider() {
    return new FakeProvider({
      responses: ["Still going."],
      toolCalls: [[call("c1", "look_up", { machine: "lever" })]],
    });
  }

  it("stops on the step budget with a partial result", async () => {
    const { registry } = makeTools();
    const result = await runAgent({
      sessionId: "session-1",
      goal: GOAL,
      provider: runawayProvider(),
      registry,
      budget: { maxSteps: 4 },
    });

    expect(result.status).toBe("budget-exhausted");
    expect(result.stopReason).toBe("budget-steps");
    expect(result.trace.steps).toHaveLength(4);
    // Partial, not discarded: bounding cost by destroying value is not a bound.
    expect(result.trace.steps[0]!.toolResult).toBeDefined();
  });

  it("stops on the token budget", async () => {
    const { registry } = makeTools();
    const result = await runAgent({
      sessionId: "session-1",
      goal: GOAL,
      provider: runawayProvider(),
      registry,
      budget: { maxSteps: 100, maxTokens: 60 },
    });

    expect(result.status).toBe("budget-exhausted");
    expect(result.stopReason).toBe("budget-tokens");
    expect(result.trace.steps.length).toBeGreaterThan(0);
    expect(result.trace.steps.length).toBeLessThan(100);
  });

  it("stops on the wall-clock budget", async () => {
    const { registry } = makeTools();
    let now = 0;
    const result = await runAgent({
      sessionId: "session-1",
      goal: GOAL,
      provider: runawayProvider(),
      registry,
      budget: { maxSteps: 100, maxTokens: 1_000_000, timeoutMs: 50 },
      // Injected so the assertion is exact instead of a race with a real clock.
      now: () => {
        now += 20;
        return now;
      },
    });

    expect(result.status).toBe("budget-exhausted");
    expect(result.stopReason).toBe("budget-time");
  });

  it("never hangs: every budget path resolves", async () => {
    const { registry } = makeTools();
    const result = await Promise.race([
      runAgent({
        sessionId: "session-1",
        goal: GOAL,
        provider: runawayProvider(),
        registry,
        budget: { maxSteps: 3 },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("hung")), 2_000)),
    ]);
    expect(result).toMatchObject({ status: "budget-exhausted" });
  });
});

describe("runAgent: cancellation (AD-8, D-5)", () => {
  it("stops within one step boundary and returns the partial trace", async () => {
    const controller = new AbortController();
    const { lookUp } = makeTools();
    const cancelling = defineTool({
      name: "cancelling",
      description: "Cancels the run from inside a tool, like a user clicking stop.",
      locus: "server",
      argsSchema: z.object({}),
      handler: async () => {
        controller.abort();
        return { stopped: true };
      },
    });

    const provider = new FakeProvider({
      responses: ["Working."],
      toolCalls: [[call("c1", "cancelling", {})]],
    });

    const result = await runAgent({
      sessionId: "session-1",
      goal: GOAL,
      provider,
      registry: new ToolRegistry([cancelling, lookUp]),
      signal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(result.stopReason).toBe("cancelled");
    // The work already done is kept; only the next step is not taken.
    expect(result.trace.steps).toHaveLength(1);
    expect(result.trace.steps[0]!.toolResult).toEqual({ stopped: true });
  });

  it("propagates cancellation into a handler that is still running", async () => {
    const controller = new AbortController();
    const observed: boolean[] = [];
    const tool = defineTool({
      name: "observe_signal",
      description: "…",
      locus: "server",
      argsSchema: z.object({}),
      handler: async (_args, ctx) => {
        observed.push(ctx.signal.aborted);
        controller.abort();
        // The assertion has to happen *inside* the handler: once the run ends,
        // its composed signal is disposed and would read aborted either way.
        // A long-running tool learns it should stop rather than being abandoned
        // mid-write, which is how you leak a file handle.
        observed.push(ctx.signal.aborted);
        return { ok: true };
      },
    });

    const provider = new FakeProvider({
      responses: ["Working.", "Done."],
      toolCalls: [[call("c1", "observe_signal", {})], []],
    });

    const result = await runAgent({
      sessionId: "session-1",
      goal: GOAL,
      provider,
      registry: new ToolRegistry([tool]),
      signal: controller.signal,
    });

    expect(observed).toEqual([false, true]);
    expect(result.status).toBe("cancelled");
  });

  it("returns immediately when the caller's signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { registry } = makeTools();

    const result = await runAgent({
      sessionId: "session-1",
      goal: GOAL,
      provider: new FakeProvider({ responses: ["never"] }),
      registry,
      signal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(result.trace.steps).toHaveLength(0);
  });
});

describe("runAgent: parallel tool calls (D-7)", () => {
  it("runs a batch in parallel when the provider supports it", async () => {
    const active: number[] = [];
    let concurrent = 0;
    const slow = defineTool({
      name: "slow",
      description: "…",
      locus: "server",
      readOnly: true,
      argsSchema: z.object({ n: z.number() }),
      handler: async (args) => {
        concurrent += 1;
        active.push(concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
        return args.n;
      },
    });

    const provider = new FakeProvider({
      capabilities: { parallelToolCalls: true },
      responses: ["Both at once.", "Done."],
      toolCalls: [[call("c1", "slow", { n: 1 }), call("c2", "slow", { n: 2 })], []],
    });

    const result = await runAgent({
      sessionId: "session-1",
      goal: GOAL,
      provider,
      registry: new ToolRegistry([slow]),
    });

    expect(Math.max(...active)).toBe(2);
    // One trace step per call, even though they ran together.
    expect(result.trace.steps.filter((s) => s.toolName === "slow")).toHaveLength(2);
  });

  it("runs sequentially and asks for no parallel batch when the provider cannot", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const slow = defineTool({
      name: "slow",
      description: "…",
      locus: "server",
      argsSchema: z.object({ n: z.number() }),
      handler: async (args) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
        return args.n;
      },
    });

    const provider = new FakeProvider({
      capabilities: { parallelToolCalls: false },
      responses: ["One at a time.", "Done."],
      toolCalls: [[call("c1", "slow", { n: 1 }), call("c2", "slow", { n: 2 })], []],
    });

    const result = await runAgent({
      sessionId: "session-1",
      goal: GOAL,
      provider,
      registry: new ToolRegistry([slow]),
    });

    expect(maxConcurrent).toBe(1);
    expect(result.status).toBe("completed");
  });

  it("branches on the capability flag, never on the provider id", async () => {
    const { registry } = makeTools();
    const provider = new FakeProvider({
      id: "definitely-not-a-known-provider",
      capabilities: { parallelToolCalls: false },
      responses: ["Done."],
      toolCalls: [[]],
    });

    await runAgent({ sessionId: "session-1", goal: GOAL, provider, registry });

    // The flag is what reaches the request; the id never enters the decision.
    expect(provider.calls[0]).toMatchObject({ allowParallelCalls: false });
  });
});

describe("runAgent: provider failure", () => {
  it("ends the run with a provider-error status rather than throwing", async () => {
    const { registry } = makeTools();
    const provider = new FakeProvider({ failWith: new Error("deployment not found") });

    const result = await runAgent({ sessionId: "session-1", goal: GOAL, provider, registry });

    // A provider that cannot answer at all is not an observation the agent can
    // act on -- unlike a tool failure, which is (AD-2).
    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("provider-error");
    expect(result.error?.message).toContain("deployment not found");
  });
});

describe("runAgent: prompt assembly", () => {
  it("sends the goal, the system prompt and the tool catalogue for this locus", async () => {
    const highlight = defineTool({
      name: "highlight",
      description: "Client-only.",
      locus: "client",
      argsSchema: z.object({}),
      handler: async () => null,
    });
    const { lookUp } = makeTools();
    const provider = new FakeProvider({ responses: ["Done."], toolCalls: [[]] });

    await runAgent({
      sessionId: "session-1",
      goal: GOAL,
      provider,
      registry: new ToolRegistry([lookUp, highlight]),
      locus: "server",
      systemPrompt: "You are a teacher at a whiteboard.",
    });

    const request = provider.calls[0]!;
    expect(request.system).toContain("You are a teacher at a whiteboard.");
    expect(request.messages[0]).toEqual({ role: "user", content: GOAL });
    // A locus must never advertise tools it cannot run (AD-4).
    expect(
      (request as unknown as { tools: Array<{ name: string }> }).tools.map((t) => t.name),
    ).toEqual(["look_up"]);
  });
});
