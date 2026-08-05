import { describe, it, expect } from "vitest";
import {
  ShapeGraphSchema,
  ConstraintGraphSchema,
  ConstraintTypeSchema,
  ShapeNodeKindSchema,
  SCHEMA_VERSION,
} from "../src/index";

describe("ShapeGraph", () => {
  const graph = {
    version: SCHEMA_VERSION,
    id: "house",
    root: "house",
    nodes: [
      { id: "house", kind: "object", type: "house", category: "architecture", role: "subject" },
      { id: "roof", kind: "component", type: "roof", category: "architecture", role: "cover" },
      { id: "wall", kind: "component", type: "wall", category: "architecture", role: "support" },
    ],
    edges: [
      { id: "e1", type: "above", from: "roof", to: "wall" },
      { id: "e2", type: "contains", from: "house", to: "wall" },
    ],
  } as const;

  it("accepts the Volume 14 node definition", () => {
    expect(ShapeGraphSchema.parse(graph)).toMatchObject(graph);
  });

  it("covers every Volume 14 node kind", () => {
    expect([...ShapeNodeKindSchema.options].sort()).toEqual(
      ["annotation", "component", "connector", "label", "object"].sort(),
    );
  });

  it("carries anchors and behaviors on nodes", () => {
    const parsed = ShapeGraphSchema.parse({
      ...graph,
      nodes: [
        {
          ...graph.nodes[0],
          anchors: [{ name: "door", description: "front entrance" }],
          behaviors: ["open"],
        },
        ...graph.nodes.slice(1),
      ],
    });
    expect(parsed.nodes[0]?.anchors[0]?.name).toBe("door");
    expect(parsed.nodes[0]?.behaviors).toEqual(["open"]);
  });

  it("supports repeat rules, which belong to the graph and not the renderer", () => {
    const parsed = ShapeGraphSchema.parse({
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: "tooth",
          kind: "component",
          type: "gearTooth",
          category: "mechanical",
          role: "tooth",
          repeat: { count: 12, symmetry: "radial" },
        },
      ],
    });
    expect(parsed.nodes[3]?.repeat).toEqual({ count: 12, symmetry: "radial" });
  });

  it("supports inheritance from an existing shape", () => {
    const parsed = ShapeGraphSchema.parse({ ...graph, inherits: "pulley" });
    expect(parsed.inherits).toBe("pulley");
  });

  it("rejects an unknown edge type", () => {
    const r = ShapeGraphSchema.safeParse({
      ...graph,
      edges: [{ id: "e1", type: "orbits", from: "roof", to: "wall" }],
    });
    expect(r.success).toBe(false);
  });
});

describe("ConstraintGraph", () => {
  const cg = {
    version: SCHEMA_VERSION,
    nodes: ["ceiling", "pulley", "load"],
    constraints: [
      { id: "c1", type: "attachedTo", from: "pulley", to: "ceiling" },
      { id: "c2", type: "below", from: "load", to: "pulley", priority: "required" },
      { id: "c3", type: "equalSpacing", from: "load", to: "pulley", parameters: { gap: 2 } },
    ],
  } as const;

  it("accepts a constraint graph built from semantic relationships", () => {
    expect(ConstraintGraphSchema.parse(cg)).toMatchObject(cg);
  });

  it("supports all 15 Volume 14 constraint types", () => {
    expect(ConstraintTypeSchema.options).toHaveLength(15);
    for (const t of [
      "above",
      "below",
      "leftOf",
      "rightOf",
      "inside",
      "outside",
      "connectedTo",
      "attachedTo",
      "wrapAround",
      "parallelTo",
      "perpendicularTo",
      "centeredOn",
      "alignedWith",
      "equalSpacing",
      "mirrorOf",
    ]) {
      expect(ConstraintTypeSchema.options).toContain(t);
    }
  });

  it("rejects an unknown constraint type", () => {
    const r = ConstraintGraphSchema.safeParse({
      ...cg,
      constraints: [{ id: "c1", type: "hoversNear", from: "a", to: "b" }],
    });
    expect(r.success).toBe(false);
  });

  it("defaults constraint priority to required", () => {
    const parsed = ConstraintGraphSchema.parse(cg);
    expect(parsed.constraints[0]?.priority).toBe("required");
  });

  it("allows preferred constraints, so the solver can drop them under conflict", () => {
    const parsed = ConstraintGraphSchema.parse({
      ...cg,
      constraints: [{ id: "c1", type: "above", from: "a", to: "b", priority: "preferred" }],
    });
    expect(parsed.constraints[0]?.priority).toBe("preferred");
  });
});
