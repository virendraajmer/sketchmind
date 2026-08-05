/**
 * Phase 6 acceptance: Diagram AST -> Constraint Graph -> Layout Model, run
 * through the real packages end to end.
 *
 * The per-package suites (`constraint-engine/tests`, `layout-engine/tests`)
 * check each stage in isolation. This one checks what the phase actually
 * claims: that the same movable-pulley AST every other phase's tests use
 * (Volume 03's canonical example, `tests/reasoning-pipeline.test.ts`) survives
 * validation, derives a valid Constraint Graph, and solves to a Layout Model
 * with every object placed, non-overlapping, and byte-identical run to run.
 */
import { describe, it, expect } from "vitest";
import { buildDiagramAST } from "@sketchmind/diagram-ast";
import { deriveConstraintGraph } from "@sketchmind/constraint-engine";
import { solveLayout } from "@sketchmind/layout-engine";
import type { DiagramObject } from "@sketchmind/shared-types";

function unwrap<T>(result: { ok: boolean; value?: T; errors?: readonly unknown[] }): T {
  if (!result.ok) throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors, null, 2)}`);
  return result.value as T;
}

function object(id: string, type: string, name: string, anchors: string[] = [], labels: string[] = []): DiagramObject {
  return {
    id,
    type,
    name,
    category: "mechanical",
    anchors: anchors.map((a) => ({ name: a })),
    behaviors: [],
    labels: labels.map((text, index) => ({ id: `${id}_label_${index}`, text })),
    children: [],
  };
}

/** Same fixture as `tests/reasoning-pipeline.test.ts`'s PULLEY_AST. */
const PULLEY_AST = {
  id: "movable_pulley",
  subject: "movable pulley system",
  title: "Movable Pulley",
  category: "schematic" as const,
  objects: [
    object("ceiling", "surface", "Ceiling", ["mount"]),
    object("fixed_pulley", "pulley", "Fixed Pulley", ["axle", "rim"], ["Fixed pulley"]),
    object("movable_pulley", "pulley", "Movable Pulley", ["axle", "rim"], ["Movable pulley"]),
    object("rope", "rope", "Rope", ["free_end", "dead_end"]),
    object("load", "mass", "Load", ["hook"], ["Load"]),
  ],
  relationships: [
    { id: "r1", type: "attachedTo" as const, from: "fixed_pulley", to: "ceiling", fromAnchor: "axle", toAnchor: "mount" },
    { id: "r2", type: "wraps" as const, from: "rope", to: "fixed_pulley", toAnchor: "rim" },
    { id: "r3", type: "wraps" as const, from: "rope", to: "movable_pulley", toAnchor: "rim" },
    { id: "r4", type: "connectedTo" as const, from: "movable_pulley", to: "load", toAnchor: "hook" },
  ],
  groups: [],
  annotations: [],
};

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe("Phase 6: Diagram AST -> Constraint Graph -> Layout Model", () => {
  it("solves the movable pulley into a fully placed, non-overlapping layout", () => {
    const ast = unwrap(buildDiagramAST(PULLEY_AST));
    const graph = unwrap(deriveConstraintGraph(ast));
    const layout = unwrap(solveLayout(ast, graph));

    expect(layout.nodes.map((n) => n.objectId).sort()).toEqual(
      PULLEY_AST.objects.map((o) => o.id).sort(),
    );

    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        expect(overlaps(layout.nodes[i]!.bounds, layout.nodes[j]!.bounds)).toBe(false);
      }
    }

    // "Fixed pulley" and "Movable pulley" labels, placed clear of every node.
    expect(layout.labels).toHaveLength(3);
    for (const label of layout.labels) {
      for (const node of layout.nodes) {
        if (node.objectId === label.targetId) continue;
        expect(overlaps(label.bounds, node.bounds)).toBe(false);
      }
    }

    // `attachedTo`, `wraps`, and `connectedTo` are all joins; every one is routed.
    expect(layout.connectors.map((c) => c.relationshipId).sort()).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("is deterministic: the same AST solved twice yields byte-identical output (AD-6)", () => {
    const ast1 = unwrap(buildDiagramAST(PULLEY_AST));
    const graph1 = unwrap(deriveConstraintGraph(ast1));
    const layout1 = unwrap(solveLayout(ast1, graph1));

    const ast2 = unwrap(buildDiagramAST(structuredClone(PULLEY_AST)));
    const graph2 = unwrap(deriveConstraintGraph(ast2));
    const layout2 = unwrap(solveLayout(ast2, graph2));

    expect(JSON.stringify(layout1)).toBe(JSON.stringify(layout2));
  });

  it("selects a layout strategy from the AST's own category, not a hardcoded default", () => {
    const schematic = unwrap(buildDiagramAST(PULLEY_AST));
    const schematicGraph = unwrap(deriveConstraintGraph(schematic));
    expect(unwrap(solveLayout(schematic, schematicGraph)).strategy).toBe("hierarchical");

    const asComparison = unwrap(buildDiagramAST({ ...PULLEY_AST, category: "comparison" }));
    const comparisonGraph = unwrap(deriveConstraintGraph(asComparison));
    expect(unwrap(solveLayout(asComparison, comparisonGraph)).strategy).toBe("grid");
  });

  it("keeps geometry out of the Constraint Graph -- only the Layout Model carries coordinates", () => {
    const ast = unwrap(buildDiagramAST(PULLEY_AST));
    const graph = unwrap(deriveConstraintGraph(ast));
    expect(JSON.stringify(graph)).not.toMatch(/"x":|"y":|"width":|"height":/);
  });
});
