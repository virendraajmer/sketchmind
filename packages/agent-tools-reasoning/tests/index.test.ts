import { describe, it, expect } from "vitest";
import { FakeProvider, fakeReturning, type LLMProvider } from "@sketchmind/llm-provider";
import { InMemoryPrimitiveCatalog } from "@sketchmind/shape-intelligence";
import { SCHEMA_VERSION, type ValidationResult } from "@sketchmind/shared-types";
import type { ToolDefinition } from "@sketchmind/agent-core";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  ReasoningWorkspace,
  createReasoningTools,
} from "../src/index.js";

const INTENT = {
  intent: "explain",
  subject: "movable pulley system",
  domain: "physics",
  category: "schematic",
  complexity: "moderate",
  teachingObjective: "Understand how a movable pulley halves the effort.",
};

const PLAN = {
  detailLevel: "standard",
  objects: [
    { id: "fixed_pulley", name: "Fixed Pulley", importance: "primary" },
    { id: "load", name: "Load", importance: "secondary" },
  ],
  labels: [],
  highlights: [],
  animations: [],
  focusOrder: ["fixed_pulley", "load"],
};

const GRAPH = {
  id: "pulley_system",
  root: "pulley_system",
  nodes: [
    { id: "pulley_system", kind: "object", type: "pulley_system", category: "mechanical", role: "assembly", anchors: [], behaviors: [] },
    { id: "fixed_pulley", kind: "component", type: "pulley", category: "mechanical", role: "redirect", anchors: [{ name: "rim" }], behaviors: ["rotate"] },
  ],
  edges: [{ id: "e1", type: "contains", from: "pulley_system", to: "fixed_pulley" }],
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

const BOLT = {
  id: "lightning_bolt",
  name: "lightning-bolt",
  parts: [{ id: "outline", kind: "polyline", closed: false, order: 0, points: [{ u: 0.2, v: 0 }, { u: 0.5, v: 1 }] }],
  anchors: [],
  aspectRatio: 0.5,
};

function toolsFor(provider: LLMProvider, workspace = new ReasoningWorkspace(), catalog?: InMemoryPrimitiveCatalog) {
  const list = createReasoningTools({
    provider,
    workspace,
    ...(catalog ? { catalog } : {}),
    maxRepairAttempts: 0,
  });
  const byName = new Map(list.map((tool) => [tool.name, tool]));
  return { list, workspace, get: (name: string) => byName.get(name)! };
}

async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<ValidationResult<unknown>> {
  const parsed = tool.argsSchema.parse(args);
  return (await tool.handler(parsed, {
    sessionId: "s-1",
    signal: new AbortController().signal,
    locus: "server",
    toolCallId: "c-1",
  })) as ValidationResult<unknown>;
}

describe("agent-tools-reasoning package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/agent-tools-reasoning");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});

describe("the tool catalogue", () => {
  const { list } = toolsFor(fakeReturning(INTENT));

  it("exposes the eight Phase 5 tools", () => {
    expect(list.map((tool) => tool.name)).toEqual([
      "analyze_intent",
      "plan_visual",
      "build_shape_graph",
      "compose_diagram_ast",
      "validate_diagram",
      "search_primitives",
      "generate_primitive",
      "compose_freeform",
    ]);
  });

  it("runs every reasoning tool on the server -- none of this belongs in a browser", () => {
    expect(list.every((tool) => tool.locus === "server")).toBe(true);
  });

  it("marks the tools that change nothing as read-only, and the composers as not", () => {
    const readOnly = list.filter((tool) => tool.readOnly).map((tool) => tool.name);
    expect(readOnly).toContain("search_primitives");
    expect(readOnly).toContain("validate_diagram");
    expect(readOnly).not.toContain("compose_diagram_ast");
  });

  it("describes each tool for the model, not for a developer", () => {
    for (const tool of list) {
      expect(tool.description.length).toBeGreaterThan(80);
      expect(tool.parameters.additionalProperties).toBe(false);
    }
  });
});

describe("stage tools and the workspace", () => {
  it("analyze_intent stores its result so later stages need no arguments", async () => {
    const { get, workspace } = toolsFor(fakeReturning(INTENT));
    const result = await call(get("analyze_intent"), { request: "Draw a movable pulley" });

    expect(result.ok).toBe(true);
    expect(workspace.intent?.subject).toBe("movable pulley system");
    expect(workspace.snapshot().hasIntent).toBe(true);
  });

  /**
   * AD-2, not AD-8: the missing input is reported as something the agent can
   * fix, and the message names the tool that fixes it. Nothing here refuses.
   */
  it("plan_visual reports a missing intent as a fixable observation", async () => {
    const { get } = toolsFor(fakeReturning(PLAN));
    const result = await call(get("plan_visual"), {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("REASONING_MISSING_INPUT");
    expect(result.errors[0]?.recoverable).toBe(true);
    expect(result.errors[0]?.message).toContain("analyze_intent");
  });

  it("runs the full chain, each stage reading the last from the workspace", async () => {
    const provider = new FakeProvider({
      responses: [JSON.stringify(INTENT), JSON.stringify(PLAN), JSON.stringify(GRAPH)],
    });
    const { get, workspace } = toolsFor(provider);

    expect((await call(get("analyze_intent"), { request: "Draw a movable pulley" })).ok).toBe(true);
    expect((await call(get("plan_visual"), {})).ok).toBe(true);
    expect((await call(get("build_shape_graph"), {})).ok).toBe(true);

    expect(workspace.shapeGraph?.root).toBe("pulley_system");
    expect(workspace.snapshot()).toMatchObject({ hasIntent: true, hasPlan: true, hasShapeGraph: true });
  });

  /**
   * The AD-1 acceptance in miniature: a trivial request reaches a valid AST
   * through one tool, without intent, plan, or shape graph.
   */
  it("compose_diagram_ast works with nothing else having run", async () => {
    const provider = fakeReturning(CIRCLE_AST);
    const { get, workspace } = toolsFor(provider);

    const result = await call(get("compose_diagram_ast"), { request: "Draw a circle" });

    expect(result.ok).toBe(true);
    expect(workspace.ast?.id).toBe("circle_diagram");
    expect(provider.calls).toHaveLength(1);
  });
});

describe("validate_diagram", () => {
  it("returns the structured problems in a malformed AST", async () => {
    const { get } = toolsFor(fakeReturning(CIRCLE_AST));
    const result = await call(get("validate_diagram"), {
      ast: { ...CIRCLE_AST, version: SCHEMA_VERSION, relationships: [{ id: "r1", type: "connectedTo", from: "circle", to: "ghost" }] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("AST_UNKNOWN_REFERENCE");
    expect(result.errors[0]?.path).toBe("relationships[0].to");
  });

  /** The repair loop's memory: the next compose is a fix, not a fresh guess. */
  it("remembers the failed attempt so the next composition repairs it", async () => {
    const provider = new FakeProvider({ responses: [JSON.stringify(CIRCLE_AST)] });
    const { get, workspace } = toolsFor(provider);
    const broken = { ...CIRCLE_AST, version: SCHEMA_VERSION, objects: [] };

    await call(get("validate_diagram"), { ast: broken });
    expect(workspace.lastFailure?.errors.length).toBeGreaterThan(0);

    await call(get("compose_diagram_ast"), { request: "Draw a circle" });

    const sent = JSON.parse(provider.calls[0]?.messages[0]?.content ?? "{}");
    expect(sent.previousAttempt).toBeDefined();
    expect(sent.previousErrors.length).toBeGreaterThan(0);
    // A successful composition clears it -- otherwise every later call would
    // keep apologising for a mistake that has been fixed.
    expect(workspace.lastFailure).toBeUndefined();
  });

  it("checks the session's own AST when none is passed", async () => {
    const { get } = toolsFor(fakeReturning(CIRCLE_AST));
    await call(get("compose_diagram_ast"), { request: "Draw a circle" });

    const result = await call(get("validate_diagram"), {});
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toMatchObject({ valid: true, id: "circle_diagram" });
  });

  it("reports having nothing to check as a fixable observation", async () => {
    const { get } = toolsFor(fakeReturning(CIRCLE_AST));
    const result = await call(get("validate_diagram"), {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("REASONING_MISSING_INPUT");
  });
});

describe("the geometry guard on live output", () => {
  /**
   * Global Constraints: no AI component outputs coordinates. The schemas cannot
   * enforce that through an open metadata bag, so the tool surface does.
   */
  it("rejects an AST carrying coordinates in its metadata", async () => {
    const { get } = toolsFor(
      fakeReturning({
        ...CIRCLE_AST,
        objects: [{ ...CIRCLE_AST.objects[0], properties: { x: 40, y: 120 } }],
      }),
    );

    const result = await call(get("compose_diagram_ast"), { request: "Draw a circle" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("AI_EMITTED_GEOMETRY");
  });

  it("allows a freeform shape's unit-space points", async () => {
    const { get, workspace } = toolsFor(fakeReturning(BOLT));
    const result = await call(get("compose_freeform"), {
      name: "lightning-bolt",
      description: "A jagged downward bolt.",
    });

    expect(result.ok).toBe(true);
    expect(workspace.freeforms.get("lightning_bolt")).toBeDefined();
  });
});

describe("search before generate (V10)", () => {
  const catalog = new InMemoryPrimitiveCatalog([
    {
      id: "p1",
      name: "pulley",
      description: "A grooved wheel on an axle that redirects a rope.",
      shapeGraph: { ...GRAPH, version: SCHEMA_VERSION } as never,
    },
  ]);

  it("search_primitives costs no model call and records the query", async () => {
    const provider = fakeReturning(GRAPH);
    const { get, workspace } = toolsFor(provider, new ReasoningWorkspace(), catalog);

    const result = await call(get("search_primitives"), { query: "pulley", limit: 5 });

    expect(result.ok).toBe(true);
    expect(provider.calls).toHaveLength(0);
    expect(workspace.searches).toEqual(["pulley"]);
    expect(result.ok && (result.value as Array<{ name: string }>)[0]?.name).toBe("pulley");
  });

  /**
   * The acceptance criterion, made structural: `generate_primitive` searches
   * inside itself, so the guarantee does not depend on the agent choosing to
   * search first.
   */
  it("generate_primitive searches first and reuses rather than reinventing", async () => {
    const provider = fakeReturning(GRAPH);
    const { get, workspace } = toolsFor(provider, new ReasoningWorkspace(), catalog);

    const result = await call(get("generate_primitive"), {
      name: "pulley",
      description: "A grooved wheel on an axle that redirects a rope.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as { reused: boolean }).reused).toBe(true);
    expect(provider.calls).toHaveLength(0);
    expect(workspace.searches).toContain("pulley");
  });

  it("generate_primitive still records the search when it has to generate", async () => {
    const provider = fakeReturning(GRAPH);
    const { get, workspace } = toolsFor(provider, new ReasoningWorkspace(), catalog);

    const result = await call(get("generate_primitive"), {
      name: "nephron",
      description: "The filtering unit of the kidney.",
    });

    expect(result.ok && (result.value as { reused: boolean }).reused).toBe(false);
    expect(workspace.searches).toContain("nephron");
    expect(workspace.primitives.has("nephron")).toBe(true);
  });
});
