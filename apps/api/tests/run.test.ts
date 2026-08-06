/**
 * The orchestration, driven directly.
 *
 * These go at `runSession` rather than at a route because the interesting
 * behaviour is timing -- what is emitted, in what order, and what stops when the
 * signal aborts. Injected `sleep` makes that assertable instead of racy.
 *
 * There is deliberately no separate `signal` passed to `runSession` any more --
 * `record.controller.signal` is the one cancellation signal, so a cancellation
 * test creates the `SessionRecord` first and aborts *that* controller, rather
 * than maintaining a second one that could disagree with it.
 */
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@sketchmind/agent-memory";
import type { RuntimeEvent } from "@sketchmind/session-protocol";
import { runSession } from "../src/session/run.js";
import { SessionManager, type SessionRecord } from "../src/session/manager.js";
import { DRAWS_A_PULLEY, DRAWS_NOTHING, pulleyProvider, testConfig } from "./support.js";

interface Recorded {
  readonly events: RuntimeEvent[];
  readonly types: string[];
}

function createSession(request = "Draw a movable pulley"): SessionRecord {
  return new SessionManager().create("s1", request);
}

async function run(
  record: SessionRecord,
  options: {
    toolCalls?: readonly (readonly (typeof DRAWS_A_PULLEY)[number][number][])[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Recorded> {
  const events: RuntimeEvent[] = [];
  await runSession({
    sessionId: record.sessionId,
    userInput: record.request,
    provider: pulleyProvider(options.toolCalls ?? DRAWS_A_PULLEY),
    store: new InMemoryStore(),
    config: testConfig(),
    emit: (event) => events.push(event),
    sleep: options.sleep ?? (async () => {}),
    record,
  });
  return { events, types: events.map((event) => event.type) };
}

describe("a session that draws", () => {
  it("starts, reasons, draws, and completes", async () => {
    const { types } = await run(createSession());
    expect(types[0]).toBe("SessionStarted");
    expect(types.at(-1)).toBe("SessionCompleted");
    expect(types).toContain("AgentStep");
    expect(types).toContain("FrameUpdate");
  });

  it("announces the diagram before any geometry has been solved", async () => {
    const { types } = await run(createSession());
    const ast = types.indexOf("DiagramASTReady");
    const firstFrame = types.indexOf("FrameUpdate");
    expect(ast).toBeGreaterThan(-1);
    expect(ast).toBeLessThan(firstFrame);
  });

  it("announces the diagram exactly once, however many steps follow", async () => {
    const { types } = await run(createSession());
    expect(types.filter((type) => type === "DiagramASTReady")).toHaveLength(1);
  });

  it("carries a valid AST, which is what the inspector renders", async () => {
    const { events } = await run(createSession());
    const ready = events.find((event) => event.type === "DiagramASTReady");
    expect(ready).toBeDefined();
    if (ready?.type !== "DiagramASTReady") throw new Error("wrong variant");
    expect(ready.ast.objects.map((object) => object.id)).toEqual(["pulley", "load"]);
  });

  it("reports each tool call with its cost, which is the trace panel", async () => {
    const { events } = await run(createSession());
    const steps = events.filter((event) => event.type === "AgentStep");
    const named = steps.filter((step) => step.type === "AgentStep" && step.toolName);
    expect(named.length).toBeGreaterThanOrEqual(4);

    const first = named[0];
    if (first?.type !== "AgentStep") throw new Error("wrong variant");
    expect(first.toolName).toBe("compose_diagram_ast");
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    expect(first.tokensIn).toBeGreaterThan(0);
  });

  it("forwards the runtime's own stroke events untouched", async () => {
    const { types } = await run(createSession());
    expect(types).toContain("StrokeStarted");
    expect(types).toContain("StrokeCompleted");
  });

  it("draws every stroke the planner produced", async () => {
    const { events } = await run(createSession());
    const frames = events.filter((event) => event.type === "FrameUpdate");
    const last = frames[frames.length - 1];
    if (last?.type !== "FrameUpdate") throw new Error("wrong variant");
    expect(last.frame.pending).toBe(0);
    expect(last.frame.completed.length).toBeGreaterThan(0);
  });

  it("leaves the record's registry and accessors set for a later repair turn", async () => {
    const record = createSession();
    await run(record);
    expect(record.registry).toBeDefined();
    expect(record.getAst?.()).toBeDefined();
    expect(record.getStrokes?.()).toBeDefined();
  });

  it("builds a layout summary of ids and counts, never coordinates", async () => {
    const record = createSession();
    await run(record);
    expect(record.layoutSummary).toContain("objects");
    expect(record.layoutSummary).not.toMatch(/-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?/);
  });

  it("still builds the layout summary when the geometric critique tier is off", async () => {
    const record = createSession();
    const events: RuntimeEvent[] = [];
    await runSession({
      sessionId: record.sessionId,
      userInput: record.request,
      provider: pulleyProvider(DRAWS_A_PULLEY),
      store: new InMemoryStore(),
      config: testConfig({ vision: { ...testConfig().vision, geometric: false } }),
      emit: (event) => events.push(event),
      sleep: async () => {},
      record,
    });
    expect(record.layoutSummary).toContain("objects");
  });
});

describe("a session that cannot draw", () => {
  it("says why rather than leaving the board blank", async () => {
    const { events, types } = await run(createSession(), { toolCalls: DRAWS_NOTHING });
    expect(types).toContain("SessionFailed");
    expect(types).not.toContain("FrameUpdate");

    const failed = events.find((event) => event.type === "SessionFailed");
    if (failed?.type !== "SessionFailed") throw new Error("wrong variant");
    expect(failed.error.code).toBe("SESSION_NO_STROKES");
    expect(failed.error.recoverable).toBe(true);
  });
});

describe("cancellation", () => {
  it("stops mid-drawing and ends the session as cancelled", async () => {
    const record = createSession();
    let ticks = 0;
    const { types } = await run(record, {
      sleep: async () => {
        ticks += 1;
        if (ticks === 2) record.controller.abort();
      },
    });

    expect(types).toContain("FrameUpdate");
    expect(types.at(-1)).toBe("SessionCancelled");
    expect(types).not.toContain("SessionCompleted");
  });

  it("stops before drawing begins when cancelled during reasoning", async () => {
    const record = createSession();
    record.controller.abort();
    const { types } = await run(record);

    expect(types.at(-1)).toBe("SessionCancelled");
    expect(types).not.toContain("FrameUpdate");
  });

  it("emits exactly one terminal event", async () => {
    const record = createSession();
    let ticks = 0;
    const { types } = await run(record, {
      sleep: async () => {
        ticks += 1;
        if (ticks === 2) record.controller.abort();
      },
    });

    const terminal = types.filter((type) =>
      ["SessionCompleted", "SessionFailed", "SessionCancelled"].includes(type),
    );
    expect(terminal).toHaveLength(1);
  });
});
