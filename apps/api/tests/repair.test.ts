import { describe, expect, it } from "vitest";
import { defineTool, ToolRegistry } from "@sketchmind/agent-core";
import { FakeProvider } from "@sketchmind/llm-provider";
import { z } from "zod";
import { findingsAsGoal, runRepair } from "../src/session/repair.js";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session/manager.js";
import { ok, type CritiqueFinding, type StrokeAST } from "@sketchmind/shared-types";

const finding: CritiqueFinding = {
  id: "f1",
  tier: "geometric",
  check: "overlap",
  severity: "error",
  message: "a and b overlap.",
  objectIds: ["a", "b"],
};

const otherFinding: CritiqueFinding = {
  id: "f2",
  tier: "geometric",
  check: "off-board",
  severity: "error",
  message: "load is off the edge of the board.",
  objectIds: ["load"],
};

/** Neither test double touches the AST or the stroke plan. */
const noAst = () => undefined;
const noStrokes = () => undefined;

function setup() {
  const sessions = new SessionManager();
  const record = sessions.create("s1", "draw two boxes");
  const emitted: string[] = [];
  sessions.subscribe("s1", (event) => emitted.push(event.type));
  return { sessions, record, emitted };
}

describe("runRepair", () => {
  it("runs an agent turn and emits a VisionCritique event", async () => {
    const { sessions, record, emitted } = setup();
    await runRepair({
      sessionId: "s1",
      findings: [finding],
      provider: new FakeProvider({ responses: ["fixed"] }),
      registry: new ToolRegistry([]),
      config: loadConfig({}),
      record,
      getAst: noAst,
      getStrokes: noStrokes,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(emitted).toContain("VisionCritique");
    expect(record.repairRounds).toBe(1);
  });

  it("refuses once the repair round cap is reached", async () => {
    const { sessions, record } = setup();
    record.repairRounds = 2;
    const provider = new FakeProvider({ responses: ["fixed"] });

    await runRepair({
      sessionId: "s1",
      findings: [finding],
      provider,
      registry: new ToolRegistry([]),
      config: loadConfig({}),
      record,
      getAst: noAst,
      getStrokes: noStrokes,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(provider.calls).toHaveLength(0);
    expect(record.repairRounds).toBe(2);
  });

  it("refuses when the findings repeat the previous round", async () => {
    const { sessions, record } = setup();
    record.lastFindings = [finding];
    const provider = new FakeProvider({ responses: ["fixed"] });

    await runRepair({
      sessionId: "s1",
      findings: [finding],
      provider,
      registry: new ToolRegistry([]),
      config: loadConfig({}),
      record,
      getAst: noAst,
      getStrokes: noStrokes,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(provider.calls).toHaveLength(0);
  });

  it("does nothing for an empty findings list", async () => {
    const { sessions, record } = setup();
    const provider = new FakeProvider({ responses: ["fixed"] });

    await runRepair({
      sessionId: "s1",
      findings: [],
      provider,
      registry: new ToolRegistry([]),
      config: loadConfig({}),
      record,
      getAst: noAst,
      getStrokes: noStrokes,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(provider.calls).toHaveLength(0);
    expect(record.repairRounds).toBe(0);
  });

  it("terminates after exactly one round against findings that never change", async () => {
    const { sessions, record } = setup();
    const provider = new FakeProvider({ responses: ["still broken"] });
    const emit = (event: Parameters<typeof sessions.emit>[1]) => sessions.emit("s1", event);

    for (let round = 0; round < 10; round += 1) {
      await runRepair({
        sessionId: "s1",
        findings: [finding],
        provider,
        registry: new ToolRegistry([]),
        config: loadConfig({}),
        record,
        getAst: noAst,
        getStrokes: noStrokes,
        emit,
      });
    }

    // The repeat guard, not the cap, is what should have stopped this: the
    // very first repeat already matches last round's findings. Deleting
    // `findingsEqual` entirely would leave this at 2 (the cap) and still pass
    // a `<= 2` assertion, which is why this checks the exact value.
    expect(record.repairRounds).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  it("stops at the cap when findings keep alternating and never repeat", async () => {
    const { sessions, record } = setup();
    const provider = new FakeProvider({ responses: ["still broken"] });
    const emit = (event: Parameters<typeof sessions.emit>[1]) => sessions.emit("s1", event);
    const sequence = [finding, otherFinding, finding, otherFinding];

    for (const current of sequence) {
      await runRepair({
        sessionId: "s1",
        findings: [current],
        provider,
        registry: new ToolRegistry([]),
        config: loadConfig({}),
        record,
        getAst: noAst,
        getStrokes: noStrokes,
        emit,
      });
    }

    // A/B/A/B never repeats the immediately preceding round, so the repeat
    // guard never fires; only the round cap (2) stops it.
    expect(record.repairRounds).toBe(2);
    expect(provider.calls).toHaveLength(2);
  });

  it("reports a repair that re-solves but never reaches plan_strokes", async () => {
    const { sessions, record, emitted } = setup();

    // A stand-in for `solve_layout`: it runs, but nothing it does ever
    // reassigns the stroke plan, exactly like a repair agent that stops one
    // tool call short of `plan_strokes`.
    let layoutCalls = 0;
    const fakeSolveLayout = defineTool({
      name: "solve_layout",
      description: "test double for the geometry stage that runs without a re-plan following it",
      locus: "server",
      argsSchema: z.object({}),
      handler: () => {
        layoutCalls += 1;
        return ok({});
      },
    });

    const provider = new FakeProvider({
      toolCalls: [[{ id: "c1", name: "solve_layout", arguments: {} }], []],
      responses: ["done"],
    });

    // A stroke plan that never changes reference, whatever tools ran --
    // standing in for `geometry.strokeAST` never being reassigned because
    // `plan_strokes` never executed.
    const strokes = { plan: "unchanged" } as unknown as StrokeAST;

    await runRepair({
      sessionId: "s1",
      findings: [finding],
      provider,
      registry: new ToolRegistry([fakeSolveLayout]),
      config: loadConfig({}),
      record,
      getAst: noAst,
      getStrokes: () => strokes,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(layoutCalls).toBe(1);

    const critiques = emitted.filter((type) => type === "VisionCritique");
    // One for the accepted round, one for the incomplete repair.
    expect(critiques).toHaveLength(2);
  });

  it("emits AgentStep events, so a repair turn is visible in the trace panel", async () => {
    const { sessions, record, emitted } = setup();
    await runRepair({
      sessionId: "s1",
      findings: [finding],
      provider: new FakeProvider({ responses: ["fixed"] }),
      registry: new ToolRegistry([]),
      config: loadConfig({}),
      record,
      getAst: noAst,
      getStrokes: noStrokes,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(emitted).toContain("AgentStep");
  });
});

describe("findingsAsGoal", () => {
  it("names plan_strokes as the step nothing reaches the whiteboard without", () => {
    const goal = findingsAsGoal([finding]);
    expect(goal).toContain("plan_strokes");
  });

  it("carries the original request, so the repair turn is not a stranger to it", () => {
    const goal = findingsAsGoal([finding], "draw two boxes");
    expect(goal).toContain("draw two boxes");
  });
});
