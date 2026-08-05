/**
 * Phase 5 acceptance, driven through the real agent loop.
 *
 * The per-package tests check each stage in isolation. This one checks the
 * property the phase actually claims: that the stages are *tools*, that the
 * agent decides how many to use, and that a validation failure is something the
 * run survives rather than something it dies of.
 *
 * Two providers throughout, and the split is load-bearing. The loop's provider
 * decides which tools to call; each tool's provider produces that stage's JSON.
 * A single fake would interleave the two queues and make every assertion about
 * "how many model calls did this cost" meaningless.
 *
 * No network. The whole file runs against `FakeProvider`.
 */
import { describe, it, expect } from "vitest";
import { ToolRegistry, runAgent } from "@sketchmind/agent-core";
import { FakeProvider, type ToolCall } from "@sketchmind/llm-provider";
import { InMemoryPrimitiveCatalog } from "@sketchmind/shape-intelligence";
import { SCHEMA_VERSION, type AgentTraceStep } from "@sketchmind/shared-types";
import { ReasoningWorkspace, createReasoningTools } from "@sketchmind/agent-tools-reasoning";

const INTENT = {
  intent: "explain",
  subject: "movable pulley system",
  domain: "physics",
  category: "schematic",
  complexity: "moderate",
  teachingObjective: "Understand how a movable pulley halves the effort needed to lift a load.",
};

const PLAN = {
  detailLevel: "standard",
  objects: [
    { id: "ceiling", name: "Ceiling", importance: "supporting" },
    { id: "fixed_pulley", name: "Fixed Pulley", importance: "primary" },
    { id: "movable_pulley", name: "Movable Pulley", importance: "primary" },
    { id: "rope", name: "Rope", importance: "primary" },
    { id: "load", name: "Load", importance: "primary" },
  ],
  labels: [{ target: "load", text: "Load" }],
  highlights: [],
  animations: [],
  focusOrder: ["ceiling", "fixed_pulley", "movable_pulley", "rope", "load"],
};

const GRAPH = {
  id: "pulley_system",
  root: "pulley_system",
  nodes: [
    { id: "pulley_system", kind: "object", type: "pulley_system", category: "mechanical", role: "assembly", anchors: [], behaviors: [] },
    { id: "ceiling", kind: "component", type: "surface", category: "mechanical", role: "support", anchors: [{ name: "mount" }], behaviors: [] },
    { id: "fixed_pulley", kind: "component", type: "pulley", category: "mechanical", role: "redirect", anchors: [{ name: "rim" }], behaviors: ["rotate"] },
    { id: "movable_pulley", kind: "component", type: "pulley", category: "mechanical", role: "advantage", anchors: [{ name: "rim" }], behaviors: ["rotate", "lift"] },
    { id: "rope", kind: "connector", type: "rope", category: "mechanical", role: "tension", anchors: [{ name: "free_end" }], behaviors: [] },
    { id: "load", kind: "component", type: "mass", category: "mechanical", role: "load", anchors: [{ name: "hook" }], behaviors: ["lift"] },
  ],
  edges: [
    { id: "e1", type: "contains", from: "pulley_system", to: "ceiling" },
    { id: "e2", type: "attachedTo", from: "fixed_pulley", to: "ceiling" },
    { id: "e3", type: "wraps", from: "rope", to: "fixed_pulley" },
    { id: "e4", type: "wraps", from: "rope", to: "movable_pulley" },
    { id: "e5", type: "connectedTo", from: "movable_pulley", to: "load" },
  ],
};

function object(id: string, type: string, name: string, anchors: string[], labels: string[] = []) {
  return {
    id,
    type,
    name,
    category: "mechanical",
    anchors: anchors.map((anchor) => ({ name: anchor })),
    behaviors: [],
    labels: labels.map((text, index) => ({ id: `${id}_label_${index}`, text })),
    children: [],
  };
}

const PULLEY_AST = {
  id: "movable_pulley",
  subject: "movable pulley system",
  title: "Movable Pulley",
  category: "schematic",
  objects: [
    object("ceiling", "surface", "Ceiling", ["mount"]),
    object("fixed_pulley", "pulley", "Fixed Pulley", ["axle", "rim"], ["Fixed pulley"]),
    object("movable_pulley", "pulley", "Movable Pulley", ["axle", "rim"], ["Movable pulley"]),
    object("rope", "rope", "Rope", ["free_end", "dead_end"]),
    object("load", "mass", "Load", ["hook"], ["Load"]),
  ],
  relationships: [
    { id: "r1", type: "attachedTo", from: "fixed_pulley", to: "ceiling", fromAnchor: "axle", toAnchor: "mount" },
    { id: "r2", type: "wraps", from: "rope", to: "fixed_pulley", toAnchor: "rim" },
    { id: "r3", type: "wraps", from: "rope", to: "movable_pulley", toAnchor: "rim" },
    { id: "r4", type: "connectedTo", from: "movable_pulley", to: "load", toAnchor: "hook" },
  ],
  groups: [],
  annotations: [],
};

const CIRCLE_AST = {
  id: "circle_diagram",
  subject: "circle",
  title: "Circle",
  category: "structural",
  objects: [
    { id: "circle", type: "circle", name: "Circle", category: "geometry", anchors: [{ name: "centre" }], behaviors: [], labels: [], children: [] },
  ],
  relationships: [],
  groups: [],
  annotations: [],
};

let counter = 0;
function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  counter += 1;
  return { id: `call-${counter}`, name, arguments: args };
}

interface Harness {
  readonly loopProvider: FakeProvider;
  readonly stageProvider: FakeProvider;
  readonly workspace: ReasoningWorkspace;
  readonly registry: ToolRegistry;
}

function harness(
  script: readonly (readonly ToolCall[])[],
  stageResponses: readonly unknown[],
  catalog?: InMemoryPrimitiveCatalog,
): Harness {
  const loopProvider = new FakeProvider({
    responses: ["Working on it."],
    // The last entry repeats once the queue runs out, so ending on an empty
    // batch is what lets the loop finish rather than call tools forever.
    toolCalls: [...script, []],
  });
  const stageProvider = new FakeProvider({
    responses: stageResponses.map((value) => JSON.stringify(value)),
  });
  const workspace = new ReasoningWorkspace();
  const registry = new ToolRegistry(
    createReasoningTools({
      provider: stageProvider,
      workspace,
      ...(catalog ? { catalog } : {}),
      maxRepairAttempts: 0,
    }),
  );

  return { loopProvider, stageProvider, workspace, registry };
}

function run(h: Harness, goal: string) {
  return runAgent({
    sessionId: "phase-5",
    goal,
    provider: h.loopProvider,
    registry: h.registry,
  });
}

function toolSteps(steps: readonly AgentTraceStep[]): AgentTraceStep[] {
  return steps.filter((step) => step.toolName !== undefined);
}

describe("the pulley: full depth", () => {
  it("produces a valid DiagramAST with ceiling, both pulleys, rope, and load", async () => {
    const h = harness(
      [
        [toolCall("analyze_intent", { request: "Draw a movable pulley" })],
        [toolCall("plan_visual")],
        [toolCall("build_shape_graph")],
        [toolCall("compose_diagram_ast", { request: "Draw a movable pulley" })],
      ],
      [INTENT, PLAN, GRAPH, PULLEY_AST],
    );

    const result = await run(h, "Draw a movable pulley");

    expect(result.status).toBe("completed");
    expect(h.workspace.ast).toBeDefined();
    expect(h.workspace.ast?.version).toBe(SCHEMA_VERSION);
    expect(h.workspace.ast?.objects.map((object) => object.id).sort()).toEqual([
      "ceiling",
      "fixed_pulley",
      "load",
      "movable_pulley",
      "rope",
    ]);
  });

  it("records every tool call in the trace, with no failures", async () => {
    const h = harness(
      [
        [toolCall("analyze_intent", { request: "Draw a movable pulley" })],
        [toolCall("plan_visual")],
        [toolCall("build_shape_graph")],
        [toolCall("compose_diagram_ast", { request: "Draw a movable pulley" })],
      ],
      [INTENT, PLAN, GRAPH, PULLEY_AST],
    );

    const result = await run(h, "Draw a movable pulley");

    expect(toolSteps(result.trace.steps).map((step) => step.toolName)).toEqual([
      "analyze_intent",
      "plan_visual",
      "build_shape_graph",
      "compose_diagram_ast",
    ]);
    expect(result.trace.steps.every((step) => step.error === undefined)).toBe(true);
  });
});

describe("adaptive depth (AD-1)", () => {
  /**
   * The acceptance criterion, and the whole justification for AD-1: the same
   * loop, the same tools, and a simple request costs a fraction of a complex
   * one. Nothing in the code decides this -- the agent does.
   */
  it("draws a circle with fewer tool calls and fewer model calls than the pulley", async () => {
    const pulley = harness(
      [
        [toolCall("analyze_intent", { request: "Draw a movable pulley" })],
        [toolCall("plan_visual")],
        [toolCall("build_shape_graph")],
        [toolCall("compose_diagram_ast", { request: "Draw a movable pulley" })],
      ],
      [INTENT, PLAN, GRAPH, PULLEY_AST],
    );
    const circle = harness(
      [[toolCall("compose_diagram_ast", { request: "Draw a circle" })]],
      [CIRCLE_AST],
    );

    const pulleyRun = await run(pulley, "Draw a movable pulley");
    const circleRun = await run(circle, "Draw a circle");

    expect(pulleyRun.status).toBe("completed");
    expect(circleRun.status).toBe("completed");

    expect(toolSteps(circleRun.trace.steps).length).toBeLessThan(
      toolSteps(pulleyRun.trace.steps).length,
    );
    // The cost that actually matters: reasoning round trips.
    expect(circle.stageProvider.calls.length).toBeLessThan(pulley.stageProvider.calls.length);
    expect(circle.stageProvider.calls).toHaveLength(1);
  });

  it("still reaches a valid AST at the shallow depth", async () => {
    const circle = harness(
      [[toolCall("compose_diagram_ast", { request: "Draw a circle" })]],
      [CIRCLE_AST],
    );

    await run(circle, "Draw a circle");
    expect(circle.workspace.ast?.objects).toHaveLength(1);
    expect(circle.workspace.snapshot()).toMatchObject({ hasIntent: false, hasPlan: false, hasAST: true });
  });
});

describe("validation failure as observation (AD-2)", () => {
  /**
   * The docs say an invalid model must stop the pipeline. Here it is a step the
   * agent reads and recovers from, and the recovery is visible in the trace
   * rather than inferred from the fact that nothing crashed.
   */
  it("returns structured errors the agent fixes on a later step, all within one run", async () => {
    const broken = {
      ...PULLEY_AST,
      version: SCHEMA_VERSION,
      objects: [...PULLEY_AST.objects, object("rope_2", "rope", "Second Rope", [])],
    };

    const h = harness(
      [
        [toolCall("validate_diagram", { ast: broken })],
        [toolCall("compose_diagram_ast", { request: "Draw a movable pulley" })],
        [toolCall("validate_diagram")],
      ],
      [PULLEY_AST],
    );

    const result = await run(h, "Draw a movable pulley");

    const steps = toolSteps(result.trace.steps);
    const failed = steps[0]!;
    expect(failed.toolName).toBe("validate_diagram");
    expect(failed.error?.code).toBe("AST_ORPHAN_OBJECT");
    expect(failed.error?.message).toContain("rope_2");
    expect(failed.error?.recoverable).toBe(true);

    // The run kept going, the agent recomposed, and the second check passed.
    expect(result.status).toBe("completed");
    expect(steps[2]?.error).toBeUndefined();
    expect(steps[2]?.toolResult).toMatchObject({ valid: true });
  });

  it("hands the failed attempt back to the composer so the next try is a repair", async () => {
    const broken = { ...PULLEY_AST, version: SCHEMA_VERSION, objects: [] };
    const h = harness(
      [
        [toolCall("validate_diagram", { ast: broken })],
        [toolCall("compose_diagram_ast", { request: "Draw a movable pulley" })],
      ],
      [PULLEY_AST],
    );

    await run(h, "Draw a movable pulley");

    const sent = JSON.parse(h.stageProvider.calls[0]?.messages[0]?.content ?? "{}");
    expect(sent.previousErrors.length).toBeGreaterThan(0);
    expect(sent.previousAttempt).toBeDefined();
  });

  it("a tool that does not exist is also just an observation", async () => {
    const h = harness(
      [[toolCall("draw_it_yourself")], [toolCall("compose_diagram_ast", { request: "Draw a circle" })]],
      [CIRCLE_AST],
    );

    const result = await run(h, "Draw a circle");

    expect(result.status).toBe("completed");
    expect(toolSteps(result.trace.steps)[0]?.error?.code).toBe("TOOL_NOT_FOUND");
    expect(h.workspace.ast).toBeDefined();
  });
});

describe("search before generate (V10)", () => {
  it("consults the catalogue before generating, and reuses what it finds", async () => {
    const catalog = new InMemoryPrimitiveCatalog([
      {
        id: "p1",
        name: "pulley",
        description: "A grooved wheel on an axle that redirects a rope.",
        shapeGraph: { ...GRAPH, version: SCHEMA_VERSION } as never,
      },
    ]);

    const h = harness(
      [
        [toolCall("search_primitives", { query: "pulley", limit: 5 })],
        [toolCall("generate_primitive", { name: "pulley", description: "A grooved wheel on an axle that redirects a rope." })],
      ],
      [GRAPH],
      catalog,
    );

    const result = await run(h, "Draw a movable pulley");
    const steps = toolSteps(result.trace.steps);

    expect(steps.map((step) => step.toolName)).toEqual(["search_primitives", "generate_primitive"]);
    expect(steps[1]?.toolResult).toMatchObject({ reused: true });
    // Reuse means the model was never asked. That is the whole point of V10.
    expect(h.stageProvider.calls).toHaveLength(0);
  });

  it("records a search even when the agent calls generate_primitive directly", async () => {
    const h = harness(
      [[toolCall("generate_primitive", { name: "nephron", description: "The filtering unit of the kidney." })]],
      [{ ...GRAPH, id: "nephron", root: "pulley_system" }],
      new InMemoryPrimitiveCatalog(),
    );

    await run(h, "Draw a nephron");
    expect(h.workspace.searches).toContain("nephron");
  });
});

describe("the AI boundary holds", () => {
  /**
   * Global Constraints: no AI component outputs coordinates, SVG, or canvas
   * commands. Asserted against what the tools actually returned in a real run,
   * not against the schemas -- every semantic model has an open metadata bag
   * that the schemas cannot police.
   */
  it("no tool result in a full run contains x, y, svg, or canvasCommand", async () => {
    const h = harness(
      [
        [toolCall("analyze_intent", { request: "Draw a movable pulley" })],
        [toolCall("plan_visual")],
        [toolCall("build_shape_graph")],
        [toolCall("compose_diagram_ast", { request: "Draw a movable pulley" })],
        [toolCall("validate_diagram")],
      ],
      [INTENT, PLAN, GRAPH, PULLEY_AST],
    );

    const result = await run(h, "Draw a movable pulley");
    const banned = ["x", "y", "svg", "canvasCommand"];
    const offenders: string[] = [];

    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (node === null || typeof node !== "object") return;
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const childPath = path === "" ? key : `${path}.${key}`;
        if (banned.includes(key)) offenders.push(childPath);
        walk(child, childPath);
      }
    };

    for (const step of result.trace.steps) walk(step.toolResult, step.toolName ?? "");

    expect(offenders).toEqual([]);
    expect(toolSteps(result.trace.steps)).toHaveLength(5);
  });

  it("rejects an AST that smuggles coordinates through an open properties bag", async () => {
    const h = harness(
      [[toolCall("compose_diagram_ast", { request: "Draw a circle" })]],
      [{ ...CIRCLE_AST, objects: [{ ...CIRCLE_AST.objects[0], properties: { x: 40, y: 120 } }] }],
    );

    const result = await run(h, "Draw a circle");
    expect(toolSteps(result.trace.steps)[0]?.error?.code).toBe("AI_EMITTED_GEOMETRY");
  });
});
