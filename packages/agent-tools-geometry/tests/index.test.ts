import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "@sketchmind/agent-core";
import { buildDiagramAST } from "@sketchmind/diagram-ast";
import type { DiagramAST, ValidationResult } from "@sketchmind/shared-types";
import {
  GeometryWorkspace,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  createGeometryTools,
} from "../src/index.js";

const PULLEY = {
  id: "pulley_system",
  subject: "movable pulley",
  title: "Movable Pulley",
  category: "schematic",
  objects: [
    {
      id: "pulley",
      type: "pulley",
      name: "Pulley",
      category: "mechanical",
      anchors: [{ name: "rim" }],
      behaviors: ["rotate"],
      labels: [{ id: "l1", text: "Pulley" }],
      children: [],
    },
    {
      id: "load",
      type: "mass",
      name: "Load",
      category: "mechanical",
      anchors: [{ name: "top" }],
      behaviors: [],
      labels: [],
      children: [],
    },
  ],
  relationships: [{ id: "r1", type: "attachedTo", from: "load", to: "pulley" }],
  groups: [],
  annotations: [],
};

function ast(): DiagramAST {
  const result = buildDiagramAST(PULLEY);
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.value;
}

function toolsFor(getAst: () => DiagramAST | undefined = ast) {
  const workspace = new GeometryWorkspace();
  const list = createGeometryTools({ workspace, getAst });
  const byName = new Map(list.map((tool) => [tool.name, tool]));
  return { list, workspace, get: (name: string) => byName.get(name)! };
}

async function call(
  tool: ToolDefinition,
  args: Record<string, unknown> = {},
): Promise<ValidationResult<Record<string, unknown>>> {
  const parsed = tool.argsSchema.parse(args);
  return (await tool.handler(parsed, {
    sessionId: "s-1",
    signal: new AbortController().signal,
    locus: "server",
    toolCallId: "c-1",
  })) as ValidationResult<Record<string, unknown>>;
}

function expectOk(result: ValidationResult<Record<string, unknown>>): Record<string, unknown> {
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.value;
}

describe("agent-tools-geometry package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/agent-tools-geometry");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});

describe("the tool catalogue", () => {
  const { list } = toolsFor();

  it("exposes the three geometry stages", () => {
    expect(list.map((tool) => tool.name)).toEqual([
      "derive_constraints",
      "solve_layout",
      "plan_strokes",
    ]);
  });

  it("runs every geometry tool on the server", () => {
    expect(list.every((tool) => tool.locus === "server")).toBe(true);
  });

  it("describes each tool for the model, not for a developer", () => {
    for (const tool of list) {
      expect(tool.description.length).toBeGreaterThan(80);
      expect(tool.parameters.additionalProperties).toBe(false);
    }
  });

  it("names the available layout strategies, so the model does not guess one", () => {
    expect(list[1]?.description).toMatch(/Strategies available: \w+/);
  });
});

describe("the pipeline through the workspace", () => {
  it("runs constraints -> layout -> strokes, each reading the last from the workspace", async () => {
    const { get, workspace } = toolsFor();

    const constraints = expectOk(await call(get("derive_constraints")));
    expect(constraints.nodes).toBeGreaterThan(0);
    expect(workspace.constraintGraph).toBeDefined();

    const layout = expectOk(await call(get("solve_layout")));
    expect(layout.nodes).toBeGreaterThan(0);
    expect(workspace.layout).toBeDefined();

    const strokes = expectOk(await call(get("plan_strokes")));
    expect(strokes.strokes).toBeGreaterThan(0);
    expect(workspace.strokeAST?.strokes.length).toBe(strokes.strokes);
  });

  it("keeps coordinates out of what the model is shown", async () => {
    const { get } = toolsFor();
    await call(get("derive_constraints"));
    const layout = expectOk(await call(get("solve_layout")));
    const strokes = expectOk(await call(get("plan_strokes")));

    // The summaries are counts and names. A `nodes` array of positions, or a
    // `points` array, would be the model reading geometry it must never author.
    for (const summary of [layout, strokes]) {
      expect(JSON.stringify(summary)).not.toMatch(/"points"|"[xy]":/);
    }
    expect(typeof layout.nodes).toBe("number");
  });

  it("names which objects got strokes, so a forgotten one is visible", async () => {
    const { get } = toolsFor();
    await call(get("derive_constraints"));
    await call(get("solve_layout"));
    const strokes = expectOk(await call(get("plan_strokes")));
    expect(strokes.targets).toEqual(expect.arrayContaining(["pulley", "load"]));
  });

  it("stores the real artifacts, which is where the geometry actually goes", async () => {
    const { get, workspace } = toolsFor();
    await call(get("derive_constraints"));
    await call(get("solve_layout"));
    expect(workspace.layout?.nodes[0]?.size.width).toBeGreaterThan(0);
  });
});

describe("missing prerequisites", () => {
  it("tells the model which tool to call when the diagram is not composed yet", async () => {
    const { get } = toolsFor(() => undefined);
    const result = await call(get("derive_constraints"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("GEOMETRY_MISSING_INPUT");
    expect(result.errors[0]?.message).toContain("compose_diagram_ast");
    expect(result.errors[0]?.recoverable).toBe(true);
  });

  it("points solve_layout at derive_constraints, not at the diagram", async () => {
    const { get } = toolsFor();
    const result = await call(get("solve_layout"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain("derive_constraints");
  });

  it("points plan_strokes at solve_layout", async () => {
    const { get } = toolsFor();
    await call(get("derive_constraints"));
    const result = await call(get("plan_strokes"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain("solve_layout");
  });

  it("returns an unknown strategy as errors the model can read, not a throw", async () => {
    const { get } = toolsFor();
    await call(get("derive_constraints"));
    const result = await call(get("solve_layout"), { strategy: "spiral-of-doom" });
    expect(result.ok).toBe(false);
  });
});

describe("GeometryWorkspace", () => {
  it("snapshots what exists without serializing any of it", async () => {
    const { get, workspace } = toolsFor();
    expect(workspace.snapshot()).toEqual({
      hasConstraintGraph: false,
      hasLayout: false,
      hasStrokeAST: false,
      strokeCount: 0,
    });

    await call(get("derive_constraints"));
    await call(get("solve_layout"));
    await call(get("plan_strokes"));

    const snapshot = workspace.snapshot();
    expect(snapshot.hasStrokeAST).toBe(true);
    expect(snapshot.strokeCount).toBeGreaterThan(0);
  });
});
