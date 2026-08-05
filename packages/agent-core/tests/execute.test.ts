/**
 * Failure as observation (AD-2, Phase 4 D-3).
 *
 * This is the file that decides whether SketchMind's agent is robust. Every
 * assertion here is a variant of the same claim: the thing that went wrong came
 * back as something the model can read and fix, and nothing threw.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeToolCall } from "../src/internal/execute.js";
import { ToolRegistry, defineTool, type ToolContext } from "../src/tools.js";

const drawShape = defineTool({
  name: "draw_shape",
  description: "Draw a labelled shape.",
  locus: "server",
  argsSchema: z.object({
    shape: z.enum(["circle", "square", "triangle"]),
    label: z.string().min(1),
  }),
  handler: async (args) => ({ drawn: args.shape, label: args.label }),
});

const explodes = defineTool({
  name: "explodes",
  description: "Always throws.",
  locus: "server",
  argsSchema: z.object({}),
  handler: async () => {
    throw new Error("the renderer is on fire");
  },
});

const validates = defineTool({
  name: "validates",
  description: "Returns a ValidationResult.",
  locus: "server",
  argsSchema: z.object({ good: z.boolean() }),
  handler: async (args) =>
    args.good
      ? { ok: true as const, value: { fine: true } }
      : {
          ok: false as const,
          errors: [
            {
              code: "AST_ORPHAN_OBJECT",
              message: "Object 'rope_2' is referenced by no relationship.",
              package: "@sketchmind/diagram-ast",
              stage: "diagram-ast" as const,
              recoverable: true,
              path: "objects[2].id",
            },
          ],
        },
});

const registry = new ToolRegistry([drawShape, explodes, validates]);

function context(overrides: Partial<ToolContext> = {}): Omit<ToolContext, "toolCallId"> {
  return {
    sessionId: "session-1",
    signal: new AbortController().signal,
    locus: "server",
    ...overrides,
  };
}

describe("executeToolCall", () => {
  it("runs a valid call and returns the parsed result", async () => {
    const outcome = await executeToolCall(
      registry,
      { id: "call_1", name: "draw_shape", arguments: { shape: "circle", label: "wheel" } },
      context(),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({ drawn: "circle", label: "wheel" });
    expect(JSON.parse(outcome.content)).toEqual({ drawn: "circle", label: "wheel" });
    expect(outcome.errors).toBeUndefined();
  });

  it("hands the handler parsed arguments, with Zod defaults applied", async () => {
    const withDefault = defineTool({
      name: "with_default",
      description: "…",
      locus: "server",
      argsSchema: z.object({ detail: z.enum(["low", "high"]).default("low") }),
      handler: async (args) => args,
    });

    const outcome = await executeToolCall(
      new ToolRegistry([withDefault]),
      { id: "call_1", name: "with_default", arguments: {} },
      context(),
    );

    expect(outcome.result).toEqual({ detail: "low" });
  });

  it("turns an unknown tool into an observation naming the real ones", async () => {
    const outcome = await executeToolCall(
      registry,
      { id: "call_1", name: "draw_shapes", arguments: {} },
      context(),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.errors?.[0]?.code).toBe("TOOL_NOT_FOUND");
    expect(outcome.errors?.[0]?.recoverable).toBe(true);
    // Listing the alternatives is what makes this fixable in one step rather
    // than guessable over several.
    expect(outcome.content).toContain("draw_shape");
  });

  it("turns invalid arguments into every Zod error at once, with paths", async () => {
    const outcome = await executeToolCall(
      registry,
      { id: "call_1", name: "draw_shape", arguments: { shape: "dodecahedron", label: "" } },
      context(),
    );

    expect(outcome.ok).toBe(false);
    // Both problems, not just the first: an agent that fixes one error per round
    // trip burns the step budget on bookkeeping.
    expect(outcome.errors).toHaveLength(2);
    expect(outcome.errors?.map((e) => e.path).sort()).toEqual(["label", "shape"]);
    expect(outcome.errors?.every((e) => e.recoverable)).toBe(true);
  });

  it("turns a thrown handler into an observation instead of a crash", async () => {
    const outcome = await executeToolCall(
      registry,
      { id: "call_1", name: "explodes", arguments: {} },
      context(),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.errors?.[0]?.code).toBe("TOOL_THREW");
    expect(outcome.errors?.[0]?.recoverable).toBe(true);
    expect(outcome.content).toContain("the renderer is on fire");
  });

  it("passes a handler's own ValidationResult errors through verbatim", async () => {
    const outcome = await executeToolCall(
      registry,
      { id: "call_1", name: "validates", arguments: { good: false } },
      context(),
    );

    expect(outcome.ok).toBe(false);
    // The pipeline's structured errors are already exactly what the agent needs.
    // Rewrapping them would lose the code and the path (AD-2).
    expect(outcome.errors?.[0]).toMatchObject({
      code: "AST_ORPHAN_OBJECT",
      path: "objects[2].id",
    });
  });

  it("unwraps a successful ValidationResult to its value", async () => {
    const outcome = await executeToolCall(
      registry,
      { id: "call_1", name: "validates", arguments: { good: true } },
      context(),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({ fine: true });
  });

  it("gives the handler the cancellation signal and its own call id", async () => {
    const seen: Array<Partial<ToolContext>> = [];
    const spy = defineTool({
      name: "spy",
      description: "…",
      locus: "server",
      argsSchema: z.object({}),
      handler: async (_args, ctx) => {
        seen.push({ toolCallId: ctx.toolCallId, sessionId: ctx.sessionId, locus: ctx.locus });
        return ctx.signal.aborted;
      },
    });

    const outcome = await executeToolCall(
      new ToolRegistry([spy]),
      { id: "call_7", name: "spy", arguments: {} },
      context(),
    );

    expect(seen[0]).toEqual({ toolCallId: "call_7", sessionId: "session-1", locus: "server" });
    expect(outcome.result).toBe(false);
  });

  it("reports an already-cancelled run without invoking the handler", async () => {
    const handler = vi.fn(async () => "should not run");
    const tool = defineTool({
      name: "never",
      description: "…",
      locus: "server",
      argsSchema: z.object({}),
      handler,
    });
    const controller = new AbortController();
    controller.abort();

    const outcome = await executeToolCall(
      new ToolRegistry([tool]),
      { id: "call_1", name: "never", arguments: {} },
      context({ signal: controller.signal }),
    );

    expect(handler).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    // Cancellation is the one failure that is NOT recoverable: retrying it is
    // exactly what the caller asked us to stop doing.
    expect(outcome.errors?.[0]?.code).toBe("TOOL_CANCELLED");
    expect(outcome.errors?.[0]?.recoverable).toBe(false);
  });

  it("truncates a runaway result rather than letting it eat the context window", async () => {
    const tool = defineTool({
      name: "verbose",
      description: "…",
      locus: "server",
      argsSchema: z.object({}),
      handler: async () => "x".repeat(50_000),
    });

    const outcome = await executeToolCall(
      new ToolRegistry([tool]),
      { id: "call_1", name: "verbose", arguments: {} },
      context(),
      { maxResultChars: 1_000 },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.content.length).toBeLessThan(1_200);
    // Silent truncation would have the model reason about data it cannot see.
    expect(outcome.content).toContain("truncated");
  });

  it("serializes a result that JSON cannot express, instead of throwing", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const tool = defineTool({
      name: "circular",
      description: "…",
      locus: "server",
      argsSchema: z.object({}),
      handler: async () => circular,
    });

    const outcome = await executeToolCall(
      new ToolRegistry([tool]),
      { id: "call_1", name: "circular", arguments: {} },
      context(),
    );

    // A tool returning something unserializable is a bug in that tool, but it
    // must not take the run down with it.
    expect(outcome.ok).toBe(false);
    expect(outcome.errors?.[0]?.code).toBe("TOOL_RESULT_UNSERIALIZABLE");
  });
});
