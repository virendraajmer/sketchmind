import { describe, it, expect } from "vitest";
import { SCHEMA_VERSION, type DiagramAST } from "@sketchmind/shared-types";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  deriveConstraintGraph,
  validateConstraintGraph,
  overlapExemptions,
} from "../src/index.js";

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

function unwrap<T>(result: { ok: boolean; value?: T; errors?: readonly unknown[] }): T {
  if (!result.ok) throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  return result.value as T;
}

describe("constraint-engine package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/constraint-engine");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});

describe("deriveConstraintGraph: nesting", () => {
  it("makes a child object 'inside' its parent", () => {
    const input = ast({
      objects: [
        {
          id: "wall",
          type: "wall",
          name: "Wall",
          category: "structural",
          anchors: [],
          behaviors: [],
          labels: [],
          children: [
            {
              id: "door",
              type: "door",
              name: "Door",
              category: "structural",
              anchors: [],
              behaviors: [],
              labels: [],
              children: [],
            },
          ],
        },
      ],
    });

    const graph = unwrap(deriveConstraintGraph(input));
    expect(graph.nodes).toEqual(["wall", "door"]);
    expect(graph.constraints).toContainEqual(
      expect.objectContaining({ type: "inside", from: "door", to: "wall", priority: "required" }),
    );
  });
});

const OBJ = (id: string) => ({
  id,
  type: "shape",
  name: id,
  category: "schematic",
  anchors: [],
  behaviors: [],
  labels: [],
  children: [],
});

describe("deriveConstraintGraph: relationship mapping", () => {
  const cases: Array<[string, string]> = [
    ["above", "above"],
    ["below", "below"],
    ["leftOf", "leftOf"],
    ["rightOf", "rightOf"],
    ["connectedTo", "connectedTo"],
    ["attachedTo", "attachedTo"],
    ["wraps", "wrapAround"],
    ["parallelTo", "parallelTo"],
    ["centeredOn", "centeredOn"],
    ["alignedWith", "alignedWith"],
  ];

  it.each(cases)("maps relationship '%s' to constraint '%s'", (relType, constraintType) => {
    const input = ast({
      objects: [OBJ("a"), OBJ("b")],
      relationships: [{ id: "r1", type: relType as never, from: "a", to: "b" }],
    });
    const graph = unwrap(deriveConstraintGraph(input));
    expect(graph.constraints).toContainEqual(
      expect.objectContaining({ type: constraintType, from: "a", to: "b" }),
    );
  });

  it("reverses 'contains' into 'inside'", () => {
    const input = ast({
      objects: [OBJ("cell"), OBJ("nucleus")],
      relationships: [{ id: "r1", type: "contains", from: "cell", to: "nucleus" }],
    });
    const graph = unwrap(deriveConstraintGraph(input));
    expect(graph.constraints).toContainEqual(
      expect.objectContaining({ type: "inside", from: "nucleus", to: "cell" }),
    );
  });

  it("maps 'pointsTo' to a directed 'connectedTo'", () => {
    const input = ast({
      objects: [OBJ("arrow"), OBJ("target")],
      relationships: [{ id: "r1", type: "pointsTo", from: "arrow", to: "target" }],
    });
    const graph = unwrap(deriveConstraintGraph(input));
    expect(graph.constraints).toContainEqual(
      expect.objectContaining({
        type: "connectedTo",
        from: "arrow",
        to: "target",
        parameters: { directed: true },
      }),
    );
  });

  it("records 'intersects' as an overlap exemption, not a constraint", () => {
    const input = ast({
      objects: [OBJ("circleA"), OBJ("circleB")],
      relationships: [{ id: "r1", type: "intersects", from: "circleA", to: "circleB" }],
    });
    const graph = unwrap(deriveConstraintGraph(input));
    expect(graph.constraints).toHaveLength(0);
    expect(overlapExemptions(graph)).toEqual([["circleA", "circleB"]]);
  });
});

describe("deriveConstraintGraph: groups", () => {
  it("aligns all members to the first and adds equalSpacing for 3+", () => {
    const input = ast({
      objects: [OBJ("g1"), OBJ("g2"), OBJ("g3")],
      groups: [{ id: "grp", name: "Row", members: ["g1", "g2", "g3"] }],
    });
    const graph = unwrap(deriveConstraintGraph(input));
    expect(graph.constraints).toContainEqual(
      expect.objectContaining({ type: "alignedWith", from: "g2", to: "g1", priority: "preferred" }),
    );
    expect(graph.constraints).toContainEqual(
      expect.objectContaining({ type: "alignedWith", from: "g3", to: "g1", priority: "preferred" }),
    );
    expect(graph.constraints.filter((c) => c.type === "equalSpacing")).toHaveLength(2);
  });
});

describe("deriveConstraintGraph: dedup and determinism", () => {
  it("collapses a relationship duplicating a nesting into one required constraint", () => {
    const input = ast({
      objects: [
        {
          ...OBJ("wall"),
          children: [OBJ("door")],
        },
      ],
      relationships: [{ id: "r1", type: "inside", from: "door", to: "wall" }],
    });
    const graph = unwrap(deriveConstraintGraph(input));
    const insideConstraints = graph.constraints.filter(
      (c) => c.type === "inside" && c.from === "door" && c.to === "wall",
    );
    expect(insideConstraints).toHaveLength(1);
    expect(insideConstraints[0]?.priority).toBe("required");
  });

  it("produces byte-identical output for the same input", () => {
    const input = ast({
      objects: [OBJ("a"), OBJ("b")],
      relationships: [{ id: "r1", type: "above", from: "a", to: "b" }],
    });
    const first = JSON.stringify(unwrap(deriveConstraintGraph(input)));
    const second = JSON.stringify(unwrap(deriveConstraintGraph(structuredClone(input))));
    expect(first).toBe(second);
  });
});

describe("validateConstraintGraph", () => {
  const base = { version: SCHEMA_VERSION, nodes: ["a", "b"] };

  it("rejects a constraint referencing an unknown node", () => {
    const result = validateConstraintGraph({
      ...base,
      constraints: [{ id: "c1", type: "above", from: "a", to: "ghost", priority: "required" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("CONSTRAINT_UNKNOWN_NODE");
  });

  it("rejects a self-referencing constraint", () => {
    const result = validateConstraintGraph({
      ...base,
      constraints: [{ id: "c1", type: "above", from: "a", to: "a", priority: "required" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("CONSTRAINT_SELF_REFERENCE");
  });

  it("rejects duplicate constraint ids", () => {
    const result = validateConstraintGraph({
      ...base,
      constraints: [
        { id: "c1", type: "above", from: "a", to: "b", priority: "required" },
        { id: "c1", type: "below", from: "b", to: "a", priority: "required" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("CONSTRAINT_DUPLICATE_ID");
  });

  it("rejects a required containment cycle", () => {
    const result = validateConstraintGraph({
      version: SCHEMA_VERSION,
      nodes: ["a", "b", "c"],
      constraints: [
        { id: "c1", type: "inside", from: "a", to: "b", priority: "required" },
        { id: "c2", type: "inside", from: "b", to: "c", priority: "required" },
        { id: "c3", type: "inside", from: "c", to: "a", priority: "required" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("CONSTRAINT_CONTAINMENT_CYCLE");
  });

  it("rejects contradictory above/below constraints on the same pair", () => {
    const result = validateConstraintGraph({
      ...base,
      constraints: [
        { id: "c1", type: "above", from: "a", to: "b", priority: "required" },
        { id: "c2", type: "above", from: "b", to: "a", priority: "required" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("CONSTRAINT_ORDERING_CONTRADICTION");
  });

  it("accepts 'above' and 'below' stating the same order (not a contradiction)", () => {
    const result = validateConstraintGraph({
      ...base,
      constraints: [
        { id: "c1", type: "above", from: "a", to: "b", priority: "required" },
        { id: "c2", type: "below", from: "b", to: "a", priority: "required" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a well-formed hand-composed graph", () => {
    const result = validateConstraintGraph({
      ...base,
      constraints: [{ id: "c1", type: "connectedTo", from: "a", to: "b", priority: "required" }],
    });
    expect(result.ok).toBe(true);
  });
});
