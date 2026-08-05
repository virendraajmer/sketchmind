import { describe, it, expect } from "vitest";
import { SCHEMA_VERSION, type DiagramAST, type DiagramObject } from "@sketchmind/shared-types";
import { deriveConstraintGraph } from "@sketchmind/constraint-engine";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  solveLayout,
  validateLayoutModel,
  registeredStrategyNames,
} from "../src/index.js";

function unwrap<T>(result: { ok: boolean; value?: T; errors?: readonly unknown[] }): T {
  if (!result.ok) throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors, null, 2)}`);
  return result.value as T;
}

function ast(partial: Partial<DiagramAST>): DiagramAST {
  return {
    version: SCHEMA_VERSION,
    id: "d1",
    subject: "test",
    title: "Test Diagram",
    category: "schematic",
    objects: [],
    relationships: [],
    groups: [],
    annotations: [],
    metadata: { tags: [] },
    ...partial,
  };
}

function obj(id: string, partial: Partial<DiagramObject> = {}): DiagramObject {
  return {
    id,
    type: "shape",
    name: id,
    category: "mechanical",
    anchors: [],
    behaviors: [],
    labels: [],
    children: [],
    ...partial,
  };
}

/** ceiling -attachedTo-> pulley -wraps-> rope -connectedTo-> load, rope below pulley, load below rope. */
function pulleyAst(): DiagramAST {
  return ast({
    id: "pulley-diagram",
    category: "schematic",
    objects: [
      obj("ceiling"),
      obj("pulley", { labels: [{ id: "lbl_pulley", text: "Fixed Pulley" }] }),
      obj("rope"),
      obj("load", { labels: [{ id: "lbl_load", text: "Load" }] }),
    ],
    relationships: [
      { id: "r_attach", type: "attachedTo", from: "pulley", to: "ceiling" },
      { id: "r_below1", type: "below", from: "pulley", to: "ceiling" },
      { id: "r_wraps", type: "wraps", from: "pulley", to: "rope" },
      { id: "r_below2", type: "below", from: "rope", to: "pulley" },
      { id: "r_connect", type: "connectedTo", from: "rope", to: "load" },
      { id: "r_below3", type: "below", from: "load", to: "rope" },
    ],
  });
}

function solvePulley() {
  const diagram = pulleyAst();
  const graph = unwrap(deriveConstraintGraph(diagram));
  return { diagram, graph, layout: unwrap(solveLayout(diagram, graph)) };
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe("layout-engine package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/layout-engine");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});

describe("solveLayout: pulley acceptance", () => {
  it("positions every referenced object with non-overlapping bounding boxes", () => {
    const { diagram, layout } = solvePulley();

    expect(layout.nodes).toHaveLength(diagram.objects.length);
    const ids = layout.nodes.map((n) => n.objectId).sort();
    expect(ids).toEqual(diagram.objects.map((o) => o.id).sort());

    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        expect(overlaps(layout.nodes[i]!.bounds, layout.nodes[j]!.bounds)).toBe(false);
      }
    }
  });

  it("places the ceiling above the pulley above the rope above the load", () => {
    const { layout } = solvePulley();
    const byId = new Map(layout.nodes.map((n) => [n.objectId, n]));
    const ceilingY = byId.get("ceiling")!.position.y;
    const pulleyY = byId.get("pulley")!.position.y;
    const ropeY = byId.get("rope")!.position.y;
    const loadY = byId.get("load")!.position.y;

    expect(ceilingY).toBeLessThan(pulleyY);
    expect(pulleyY).toBeLessThan(ropeY);
    expect(ropeY).toBeLessThan(loadY);
  });

  it("routes a straight connector for the connectedTo relationship", () => {
    const { layout } = solvePulley();
    const connector = layout.connectors.find((c) => c.relationshipId === "r_connect");
    expect(connector).toBeDefined();
    expect(connector?.routing).toBe("straight");
    expect(connector?.points.length).toBeGreaterThanOrEqual(2);
  });

  it("does not route a connector for a purely positional relationship", () => {
    const { layout } = solvePulley();
    expect(layout.connectors.find((c) => c.relationshipId === "r_below1")).toBeUndefined();
  });

  it("places labels without overlapping any node's bounding box", () => {
    const { layout } = solvePulley();
    expect(layout.labels).toHaveLength(2);
    for (const label of layout.labels) {
      for (const node of layout.nodes) {
        if (node.objectId === label.targetId) continue;
        expect(overlaps(label.bounds, node.bounds)).toBe(false);
      }
    }
  });

  it("keeps every node's bounds within the declared canvas", () => {
    const { layout } = solvePulley();
    for (const node of layout.nodes) {
      expect(node.bounds.x).toBeGreaterThanOrEqual(0);
      expect(node.bounds.y).toBeGreaterThanOrEqual(0);
      expect(node.bounds.x + node.bounds.width).toBeLessThanOrEqual(layout.canvas.width + 0.01);
      expect(node.bounds.y + node.bounds.height).toBeLessThanOrEqual(layout.canvas.height + 0.01);
    }
  });
});

describe("solveLayout: determinism (AD-6)", () => {
  it("produces byte-identical output for the same input, run twice", () => {
    const diagram = pulleyAst();
    const graph = unwrap(deriveConstraintGraph(diagram));
    const first = JSON.stringify(unwrap(solveLayout(diagram, graph)));
    const second = JSON.stringify(unwrap(solveLayout(structuredClone(diagram), structuredClone(graph))));
    expect(first).toBe(second);
  });
});

describe("solveLayout: containment", () => {
  it("keeps a child's bounds fully inside its parent's bounds", () => {
    const diagram = ast({
      category: "structural",
      objects: [obj("wall", { children: [obj("door"), obj("window")] })],
    });
    const graph = unwrap(deriveConstraintGraph(diagram));
    const layout = unwrap(solveLayout(diagram, graph));

    const wall = layout.nodes.find((n) => n.objectId === "wall")!;
    const door = layout.nodes.find((n) => n.objectId === "door")!;
    const window = layout.nodes.find((n) => n.objectId === "window")!;

    for (const child of [door, window]) {
      expect(child.bounds.x).toBeGreaterThanOrEqual(wall.bounds.x);
      expect(child.bounds.y).toBeGreaterThanOrEqual(wall.bounds.y);
      expect(child.bounds.x + child.bounds.width).toBeLessThanOrEqual(wall.bounds.x + wall.bounds.width);
      expect(child.bounds.y + child.bounds.height).toBeLessThanOrEqual(wall.bounds.y + wall.bounds.height);
    }
    expect(overlaps(door.bounds, window.bounds)).toBe(false);
  });
});

describe("solveLayout: strategy selection", () => {
  it("defaults to the hierarchical strategy for a schematic diagram", () => {
    const diagram = ast({ category: "schematic", objects: [obj("a"), obj("b")] });
    const graph = unwrap(deriveConstraintGraph(diagram));
    expect(unwrap(solveLayout(diagram, graph)).strategy).toBe("hierarchical");
  });

  it("defaults to the grid strategy for a comparison diagram", () => {
    const diagram = ast({ category: "comparison", objects: [obj("a"), obj("b"), obj("c")] });
    const graph = unwrap(deriveConstraintGraph(diagram));
    expect(unwrap(solveLayout(diagram, graph)).strategy).toBe("grid");
  });

  it("lets an explicit option override the category default", () => {
    const diagram = ast({ category: "schematic", objects: [obj("a"), obj("b")] });
    const graph = unwrap(deriveConstraintGraph(diagram));
    expect(unwrap(solveLayout(diagram, graph, { strategy: "grid" })).strategy).toBe("grid");
  });

  it("reports every implemented strategy as registered", () => {
    expect(registeredStrategyNames().sort()).toEqual(["grid", "hierarchical"]);
  });

  it("returns a recoverable error for a schema-valid but unimplemented strategy", () => {
    const diagram = ast({ objects: [obj("a")] });
    const graph = unwrap(deriveConstraintGraph(diagram));
    const result = solveLayout(diagram, graph, { strategy: "radial" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("LAYOUT_STRATEGY_NOT_IMPLEMENTED");
  });
});

describe("solveLayout: AST/graph mismatch", () => {
  it("rejects a graph missing a node the AST references", () => {
    const diagram = ast({ objects: [obj("a"), obj("b")] });
    const graph = { version: SCHEMA_VERSION, nodes: ["a"], constraints: [] };
    const result = solveLayout(diagram, graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("LAYOUT_UNKNOWN_OBJECT");
  });
});

describe("validateLayoutModel", () => {
  it("accepts a well-formed hand-composed model", () => {
    const result = validateLayoutModel({
      version: SCHEMA_VERSION,
      diagramId: "d1",
      strategy: "hierarchical",
      canvas: { width: 200, height: 200 },
      nodes: [
        {
          objectId: "a",
          position: { x: 10, y: 10 },
          size: { width: 50, height: 50 },
          rotation: 0,
          bounds: { x: 10, y: 10, width: 50, height: 50 },
          anchors: [],
          zIndex: 0,
        },
      ],
      connectors: [],
      labels: [],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a label targeting a node that does not exist", () => {
    const result = validateLayoutModel({
      version: SCHEMA_VERSION,
      diagramId: "d1",
      strategy: "hierarchical",
      canvas: { width: 200, height: 200 },
      nodes: [],
      connectors: [],
      labels: [{ labelId: "l1", targetId: "ghost", position: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 10, height: 10 }, text: "x" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("LAYOUT_UNKNOWN_LABEL_TARGET");
  });

  it("rejects a node whose bounds fall outside the declared canvas", () => {
    const result = validateLayoutModel({
      version: SCHEMA_VERSION,
      diagramId: "d1",
      strategy: "hierarchical",
      canvas: { width: 100, height: 100 },
      nodes: [
        {
          objectId: "a",
          position: { x: 90, y: 90 },
          size: { width: 50, height: 50 },
          rotation: 0,
          bounds: { x: 90, y: 90, width: 50, height: 50 },
          anchors: [],
          zIndex: 0,
        },
      ],
      connectors: [],
      labels: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("LAYOUT_OUT_OF_BOUNDS");
  });

  it("rejects duplicate node ids", () => {
    const node = {
      objectId: "a",
      position: { x: 0, y: 0 },
      size: { width: 10, height: 10 },
      rotation: 0,
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      anchors: [],
      zIndex: 0,
    };
    const result = validateLayoutModel({
      version: SCHEMA_VERSION,
      diagramId: "d1",
      strategy: "hierarchical",
      canvas: { width: 100, height: 100 },
      nodes: [node, node],
      connectors: [],
      labels: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("LAYOUT_DUPLICATE_NODE");
  });
});
