import { describe, it, expect } from "vitest";
import { FakeProvider, fakeReturning } from "@sketchmind/llm-provider";
import { SCHEMA_VERSION, type ShapeGraph, type VisualPlan } from "@sketchmind/shared-types";
import {
  InMemoryPrimitiveCatalog,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  buildShapeGraph,
  composeFreeform,
  generatePrimitive,
  searchPrimitives,
  validateShapeGraph,
} from "../src/index.js";

const graphDraft = {
  id: "pulley_system",
  root: "pulley_system",
  nodes: [
    { id: "pulley_system", kind: "object", type: "pulley_system", category: "mechanical", role: "assembly", anchors: [], behaviors: [] },
    { id: "wheel", kind: "component", type: "wheel", category: "mechanical", role: "redirect", anchors: [{ name: "rim" }], behaviors: ["rotate"] },
  ],
  edges: [{ id: "e1", type: "contains", from: "pulley_system", to: "wheel" }],
};

const graph: ShapeGraph = { ...graphDraft, version: SCHEMA_VERSION } as ShapeGraph;

const plan: VisualPlan = {
  version: SCHEMA_VERSION,
  detailLevel: "standard",
  objects: [{ id: "wheel", name: "Wheel", importance: "primary" }],
  labels: [],
  highlights: [],
  animations: [],
  focusOrder: ["wheel"],
};

describe("shape-intelligence package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/shape-intelligence");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});

describe("buildShapeGraph", () => {
  it("produces a validated graph and stamps the version", async () => {
    const result = await buildShapeGraph({ provider: fakeReturning(graphDraft), plan });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(SCHEMA_VERSION);
    expect(result.value.root).toBe("pulley_system");
  });

  it("returns the semantic errors when the model's graph does not hang together", async () => {
    const result = await buildShapeGraph({
      provider: fakeReturning({ ...graphDraft, root: "nowhere" }),
      plan,
      maxRepairAttempts: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("SHAPE_UNKNOWN_ROOT");
  });
});

describe("validateShapeGraph", () => {
  it("accepts a well-formed graph", () => {
    expect(validateShapeGraph(graph).ok).toBe(true);
  });

  it("catches an edge pointing at a node that does not exist", () => {
    const result = validateShapeGraph({
      ...graph,
      edges: [{ id: "e1", type: "contains", from: "pulley_system", to: "ghost" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.code === "SHAPE_UNKNOWN_REFERENCE")).toBe(true);
  });

  /**
   * A graph claiming a wheel is inside its own hub validates perfectly against
   * the schema and is unsolvable by every layout strategy Phase 6 will have.
   */
  it("catches containment that loops back on itself", () => {
    const result = validateShapeGraph({
      ...graph,
      edges: [
        { id: "e1", type: "contains", from: "pulley_system", to: "wheel" },
        { id: "e2", type: "inside", from: "pulley_system", to: "wheel" },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.code === "SHAPE_CONTAINMENT_CYCLE")).toBe(true);
  });

  it("catches a node attached to nothing", () => {
    const result = validateShapeGraph({
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: "stray", kind: "component", type: "bolt", category: "mechanical", role: "fastener", anchors: [], behaviors: [] },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.code === "SHAPE_ORPHAN_NODE")).toBe(true);
  });

  it("accepts a single-node graph -- 'a circle' has no parts to attach", () => {
    const result = validateShapeGraph({
      version: SCHEMA_VERSION,
      id: "circle",
      root: "circle",
      nodes: [{ id: "circle", kind: "object", type: "circle", category: "geometry", role: "subject", anchors: [], behaviors: [] }],
      edges: [],
    });

    expect(result.ok).toBe(true);
  });

  it("catches a duplicate anchor name on one node", () => {
    const result = validateShapeGraph({
      ...graph,
      nodes: [
        graph.nodes[0]!,
        { ...graph.nodes[1]!, anchors: [{ name: "rim" }, { name: "rim" }] },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.code === "SHAPE_DUPLICATE_ANCHOR")).toBe(true);
  });
});

describe("searchPrimitives", () => {
  it("reports finding nothing as success with an empty list, not as a failure", async () => {
    const result = await searchPrimitives({
      catalog: new InMemoryPrimitiveCatalog(),
      query: "nephron",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

describe("generatePrimitive", () => {
  const catalog = new InMemoryPrimitiveCatalog([
    {
      id: "p1",
      name: "pulley",
      description: "A grooved wheel on an axle that redirects a rope.",
      shapeGraph: graph,
    },
  ]);

  /**
   * V10's rule made mechanical: the search is inside the generator, so there is
   * no code path that generates without having searched first.
   */
  it("reuses a known primitive instead of calling the model", async () => {
    const provider = fakeReturning(graphDraft);
    const result = await generatePrimitive({
      provider,
      name: "pulley",
      description: "A grooved wheel on an axle that redirects a rope.",
      catalog,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reused).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });

  it("generates when the catalogue has nothing close, and reports what it searched", async () => {
    const provider = fakeReturning(graphDraft);
    const result = await generatePrimitive({
      provider,
      name: "nephron",
      description: "The filtering unit of the kidney.",
      catalog,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reused).toBe(false);
    expect(result.value.matches).toEqual([]);
    expect(provider.calls).toHaveLength(1);
  });

  it("does not substitute a weak match for the thing that was asked for", async () => {
    const weak = new InMemoryPrimitiveCatalog([
      {
        id: "p2",
        name: "block and tackle",
        description: "An assembly of pulley wheels and rope.",
        shapeGraph: graph,
      },
    ]);

    const result = await generatePrimitive({
      provider: fakeReturning(graphDraft),
      name: "pulley",
      description: "A grooved wheel.",
      catalog: weak,
      // Well above what a partial description overlap can reach.
      reuseScore: 0.95,
    });

    expect(result.ok && result.value.reused).toBe(false);
  });
});

describe("composeFreeform", () => {
  const bolt = {
    id: "lightning_bolt",
    name: "lightning-bolt",
    parts: [
      {
        id: "outline",
        kind: "polygon",
        closed: true,
        order: 0,
        points: [
          { u: 0.55, v: 0 },
          { u: 0.2, v: 0.55 },
          { u: 0.35, v: 1 },
        ],
      },
    ],
    anchors: [{ name: "tip", at: { u: 0.35, v: 1 } }],
    aspectRatio: 0.6,
  };

  it("produces a validated shape in unit space", async () => {
    const result = await composeFreeform({
      provider: fakeReturning(bolt),
      name: "lightning-bolt",
      description: "A jagged downward bolt.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.parts[0]?.points[0]).toEqual({ u: 0.55, v: 0 });
  });

  /**
   * The AD-5 relaxation is bounded by the schema, not by the prompt: a model
   * that starts emitting pixels is caught here rather than by a reviewer.
   */
  it("rejects a point outside the 0..1 unit box", async () => {
    const result = await composeFreeform({
      provider: new FakeProvider({
        responses: [JSON.stringify({ ...bolt, parts: [{ ...bolt.parts[0], points: [{ u: 240, v: 80 }] }] })],
      }),
      name: "lightning-bolt",
      description: "A jagged downward bolt.",
      maxRepairAttempts: 0,
    });

    expect(result.ok).toBe(false);
  });
});
