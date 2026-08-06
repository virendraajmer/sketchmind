import { describe, it, expect } from "vitest";
import type { DiagramAST, LayoutModel, Stroke, StrokeAST } from "@sketchmind/shared-types";
import {
  DRAWING_PHASES,
  GENERATOR_FOR_TYPE,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  optimizeStrokes,
  planStrokes,
  registerStrokeGenerator,
  registeredStrokeGeneratorNames,
  validateStrokeAST,
} from "../src/index.js";

function unwrap<T>(result: { ok: boolean; value?: T; errors?: readonly unknown[] }): T {
  if (!result.ok) throw new Error(`expected ok, got: ${JSON.stringify(result.errors, null, 2)}`);
  return result.value as T;
}

function codes(result: { ok: boolean; errors?: readonly { code: string }[] }): string[] {
  if (result.ok) throw new Error("expected failure");
  return (result.errors ?? []).map((e) => e.code);
}

/**
 * A frame containing a bolt, plus a wheel that points at the frame. Small, but
 * it exercises every phase: nesting (outline vs detail), a connector, an
 * annotation, and a label.
 */
const AST: DiagramAST = {
  id: "rig",
  version: "1.0",
  subject: "a rig",
  title: "Rig",
  category: "schematic",
  objects: [
    {
      id: "frame",
      type: "surface",
      name: "Frame",
      category: "mechanical",
      anchors: [],
      behaviors: [],
      labels: [],
      children: [
        {
          id: "bolt",
          type: "circle",
          name: "Bolt",
          category: "mechanical",
          anchors: [],
          behaviors: [],
          labels: [],
          children: [],
        },
      ],
    },
    {
      id: "wheel",
      type: "pulley",
      name: "Wheel",
      category: "mechanical",
      anchors: [],
      behaviors: [],
      labels: [{ id: "wheel_label", text: "Wheel" }],
      children: [],
    },
  ],
  relationships: [{ id: "r1", type: "pointsTo", from: "wheel", to: "frame" }],
  groups: [],
  annotations: [{ id: "note1", target: "wheel", text: "spins freely", kind: "note" }],
  metadata: { tags: [] },
};

function node(objectId: string, x: number, y: number, width: number, height: number, zIndex: number) {
  return {
    objectId,
    position: { x, y },
    size: { width, height },
    rotation: 0,
    bounds: { x, y, width, height },
    anchors: [],
    zIndex,
  };
}

const LAYOUT: LayoutModel = {
  version: "1.0",
  diagramId: "rig",
  strategy: "hierarchical",
  canvas: { width: 400, height: 300 },
  nodes: [
    node("frame", 40, 40, 160, 120, 0),
    node("bolt", 60, 60, 40, 40, 1),
    node("wheel", 240, 40, 80, 80, 2),
  ],
  connectors: [
    {
      relationshipId: "r1",
      routing: "straight",
      points: [
        { x: 240, y: 80 },
        { x: 200, y: 80 },
      ],
    },
  ],
  labels: [
    {
      labelId: "wheel_label",
      targetId: "wheel",
      position: { x: 240, y: 140 },
      bounds: { x: 240, y: 140, width: 60, height: 24 },
      text: "Wheel",
    },
    {
      labelId: "note1",
      targetId: "wheel",
      position: { x: 240, y: 180 },
      bounds: { x: 240, y: 180, width: 90, height: 24 },
      text: "spins freely",
    },
  ],
};

const phaseOf = (stroke: Stroke): unknown => stroke.metadata?.["phase"];

describe("stroke-planner package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/stroke-planner");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});

describe("planStrokes ordering (Volume 06 §Human Drawing Rules)", () => {
  it("draws outlines, then details, then connectors, then annotations, then labels", () => {
    const ast = unwrap(planStrokes(AST, LAYOUT));
    expect(ast.strokes.map(phaseOf)).toEqual([
      "outline",
      "outline",
      "detail",
      "connector",
      "annotation",
      "label",
    ]);
    expect(ast.strokes.map((s) => s.target)).toEqual([
      "frame",
      "wheel",
      "bolt",
      "wheel",
      "wheel",
      "wheel",
    ]);
  });

  it("orders within a phase by the layout's own zIndex, not by proximity", () => {
    // `bolt` sits inside `frame`, so a nearest-neighbour planner would draw it
    // second. Phase order wins: every outline precedes every detail (D-3).
    const ast = unwrap(planStrokes(AST, LAYOUT));
    const outlines = ast.strokes.filter((s) => phaseOf(s) === "outline");
    expect(outlines.map((s) => s.target)).toEqual(["frame", "wheel"]);
  });

  it("keeps the declared drawing phases in the sequence the array states", () => {
    expect([...DRAWING_PHASES]).toEqual(["outline", "detail", "connector", "annotation", "label"]);
  });
});

describe("planStrokes output", () => {
  it("is deterministic -- the same inputs yield a byte-identical Stroke AST (AD-6)", () => {
    const a = unwrap(planStrokes(AST, LAYOUT));
    const b = unwrap(planStrokes(structuredClone(AST), structuredClone(LAYOUT)));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("picks a stroke shape from the object's semantic type", () => {
    const ast = unwrap(planStrokes(AST, LAYOUT));
    const byKey = new Map(ast.strokes.map((s) => [`${s.target}:${String(phaseOf(s))}`, s]));
    // `pulley` and `circle` are in the round-things table; `surface` is not.
    expect(GENERATOR_FOR_TYPE["pulley"]).toBe("disc");
    expect(byKey.get("frame:outline")!.type).toBe("rectangle");
    expect(byKey.get("wheel:outline")!.type).toBe("circle");
    expect(byKey.get("bolt:detail")!.type).toBe("circle");
  });

  it("emits an arrow only for a directional relationship", () => {
    const arrow = unwrap(planStrokes(AST, LAYOUT)).strokes.find((s) => phaseOf(s) === "connector")!;
    expect(arrow.type).toBe("arrow");
    expect(arrow.metadata?.["relationshipId"]).toBe("r1");

    const symmetric = structuredClone(AST);
    symmetric.relationships[0]!.type = "connectedTo";
    const line = unwrap(planStrokes(symmetric, LAYOUT)).strokes.find(
      (s) => phaseOf(s) === "connector",
    )!;
    expect(line.type).toBe("line");
  });

  it("carries label text on a text stroke and records which label it drew", () => {
    const label = unwrap(planStrokes(AST, LAYOUT)).strokes.find((s) => phaseOf(s) === "label")!;
    expect(label.type).toBe("text");
    expect(label.text).toBe("Wheel");
    expect(label.metadata?.["labelId"]).toBe("wheel_label");
  });

  it("chains dependencies and numbers order to match the sequence", () => {
    const ast = unwrap(planStrokes(AST, LAYOUT));
    ast.strokes.forEach((stroke, index) => {
      expect(stroke.order).toBe(index);
      expect(stroke.dependencies).toEqual(index === 0 ? [] : [ast.strokes[index - 1]!.id]);
    });
  });

  it("scales duration with path length and pauses only at phase boundaries", () => {
    const ast = unwrap(planStrokes(AST, LAYOUT));
    const frame = ast.strokes[0]!;
    const bolt = ast.strokes[2]!;
    expect(frame.timing.durationMs).toBeGreaterThan(bolt.timing.durationMs);

    // frame -> wheel stays inside `outline`; wheel -> bolt crosses into `detail`.
    expect(ast.strokes[0]!.timing.pauseAfterMs).toBe(0);
    expect(ast.strokes[1]!.timing.pauseAfterMs).toBeGreaterThan(0);
    expect(ast.strokes[ast.strokes.length - 1]!.timing.pauseAfterMs).toBe(0);

    const summed = ast.strokes.reduce(
      (total, s) => total + s.timing.delayMs + s.timing.durationMs + s.timing.pauseAfterMs,
      0,
    );
    expect(ast.totalDurationMs).toBe(summed);
  });

  it("reports bounds covering every drawn thing, labels included", () => {
    const bounds = unwrap(planStrokes(AST, LAYOUT)).bounds!;
    expect(bounds.x).toBe(40);
    expect(bounds.y).toBe(40);
    // The furthest label reaches x=330, y=204.
    expect(bounds.x + bounds.width).toBe(330);
    expect(bounds.y + bounds.height).toBe(204);
  });

  it("emits exact points -- jitter travels as style intent, never baked in (D-5)", () => {
    const wheel = unwrap(planStrokes(AST, LAYOUT)).strokes.find((s) => s.target === "wheel")!;
    expect(wheel.style.jitter).toBeGreaterThan(0);
    // The disc generator starts at the top of the bounds; jitter would move it.
    expect(wheel.points).toContainEqual({ x: 280, y: 40 });
  });
});

describe("planStrokes failure modes", () => {
  it("rejects a layout solved for a different diagram", () => {
    const other = { ...LAYOUT, diagramId: "something_else" };
    expect(codes(planStrokes(AST, other))).toContain("STROKE_DIAGRAM_MISMATCH");
  });

  it("reports objects the layout never placed, and nodes the AST never declared", () => {
    const missing = { ...LAYOUT, nodes: LAYOUT.nodes.filter((n) => n.objectId !== "bolt") };
    expect(codes(planStrokes(AST, missing))).toContain("STROKE_UNKNOWN_OBJECT");

    const extra = { ...LAYOUT, nodes: [...LAYOUT.nodes, node("ghost", 0, 0, 10, 10, 3)] };
    expect(codes(planStrokes(AST, extra))).toContain("STROKE_UNKNOWN_OBJECT");
  });

  it("names the registered generators rather than silently substituting one", () => {
    const result = planStrokes(AST, LAYOUT, { generatorFor: () => "hexagon" });
    expect(codes(result)).toContain("STROKE_GENERATOR_NOT_IMPLEMENTED");
  });
});

describe("stroke generator registry (Volume 06 §Extensibility)", () => {
  it("ships box and disc, and accepts a plugin generator without changing the planner", () => {
    expect(registeredStrokeGeneratorNames()).toEqual(["box", "disc"]);

    registerStrokeGenerator({
      name: "test-cross",
      generate: ({ node: n }) => [
        {
          type: "line",
          points: [
            { x: n.bounds.x, y: n.bounds.y },
            { x: n.bounds.x + n.bounds.width, y: n.bounds.y + n.bounds.height },
          ],
        },
      ],
    });

    const ast = unwrap(
      planStrokes(AST, LAYOUT, {
        generatorFor: (o) => (o.id === "frame" ? "test-cross" : undefined),
      }),
    );
    const frame = ast.strokes.find((s) => s.target === "frame")!;
    expect(frame.type).toBe("line");
    expect(frame.metadata?.["generator"]).toBe("test-cross");
  });
});

describe("the optimizer (Volume 06 §Stroke Optimizer)", () => {
  function strokeOf(
    overrides: Partial<Stroke> & Pick<Stroke, "id" | "target" | "points">,
  ): Stroke {
    return {
      type: "line",
      order: 0,
      dependencies: [],
      style: { width: 2, jitter: 0.1, pressureProfile: "taperBoth", ink: "pen", dashed: false },
      timing: { delayMs: 0, durationMs: 300, pauseAfterMs: 0 },
      ...overrides,
    } as Stroke;
  }

  function astOf(strokes: Stroke[]): StrokeAST {
    return unwrap(
      validateStrokeAST({
        version: "1.0",
        diagramId: "rig",
        strokes: strokes.map((s, i) => ({
          ...s,
          order: i,
          dependencies: i === 0 ? [] : [strokes[i - 1]!.id],
        })),
      }),
    );
  }

  it("merges consecutive polylines on the same target when the pen never lifted", () => {
    const merged = unwrap(
      optimizeStrokes(
        astOf([
          strokeOf({
            id: "a",
            target: "wheel",
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
            ],
          }),
          strokeOf({
            id: "b",
            target: "wheel",
            points: [
              { x: 10, y: 0 },
              { x: 10, y: 10 },
            ],
          }),
        ]),
      ),
    );
    expect(merged.strokes).toHaveLength(1);
    expect(merged.strokes[0]!.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  it("refuses to merge strokes that realise different relationships", () => {
    const kept = unwrap(
      optimizeStrokes(
        astOf([
          strokeOf({
            id: "a",
            target: "wheel",
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
            ],
            metadata: { relationshipId: "r1" },
          }),
          strokeOf({
            id: "b",
            target: "wheel",
            points: [
              { x: 10, y: 0 },
              { x: 20, y: 0 },
            ],
            metadata: { relationshipId: "r2" },
          }),
        ]),
      ),
    );
    expect(kept.strokes).toHaveLength(2);
  });

  it("thins collinear interior points without moving the endpoints", () => {
    const thinned = unwrap(
      optimizeStrokes(
        astOf([
          strokeOf({
            id: "a",
            target: "wheel",
            points: [
              { x: 0, y: 0 },
              { x: 5, y: 0 },
              { x: 9, y: 0 },
              { x: 10, y: 0 },
            ],
          }),
        ]),
      ),
    );
    expect(thinned.strokes[0]!.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it("drops a redundant redraw of what was just drawn", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const deduped = unwrap(
      optimizeStrokes(
        astOf([
          strokeOf({ id: "a", target: "wheel", points }),
          strokeOf({ id: "b", target: "wheel", points, metadata: { keep: "apart" } }),
        ]),
      ),
    );
    expect(deduped.strokes).toHaveLength(1);
  });

  it("never changes which objects are drawn -- coverage diff, not stroke count (D-7)", () => {
    const planned = unwrap(planStrokes(AST, LAYOUT, { optimize: false }));
    const optimized = unwrap(optimizeStrokes(planned));

    const coverage = (a: StrokeAST): string[] =>
      [...new Set(a.strokes.map((s) => `${s.target}:${s.type}`))].sort();
    expect(coverage(optimized)).toEqual(coverage(planned));
  });

  it("keeps a degenerate stroke rather than leaving its object undrawn", () => {
    const collapsed = unwrap(
      optimizeStrokes(
        astOf([
          strokeOf({
            id: "a",
            target: "wheel",
            points: [
              { x: 5, y: 5 },
              { x: 5, y: 5 },
            ],
          }),
        ]),
      ),
    );
    expect(collapsed.strokes.map((s) => s.target)).toEqual(["wheel"]);
  });
});

describe("validateStrokeAST", () => {
  const base = {
    version: "1.0",
    diagramId: "rig",
    strokes: [
      {
        id: "a",
        type: "line",
        target: "wheel",
        order: 0,
        dependencies: [],
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    ],
  };

  it("accepts a well-formed AST and fills in style and timing defaults", () => {
    const ast = unwrap(validateStrokeAST(base));
    expect(ast.strokes[0]!.style.width).toBeGreaterThan(0);
    expect(ast.strokes[0]!.timing.durationMs).toBeGreaterThan(0);
  });

  it("rejects duplicate ids, mismatched order, missing text, and forward dependencies", () => {
    expect(
      codes(
        validateStrokeAST({ ...base, strokes: [base.strokes[0], { ...base.strokes[0], order: 1 }] }),
      ),
    ).toContain("STROKE_DUPLICATE_ID");

    expect(codes(validateStrokeAST({ ...base, strokes: [{ ...base.strokes[0], order: 7 }] }))).toContain(
      "STROKE_ORDER_INVALID",
    );

    expect(
      codes(
        validateStrokeAST({
          ...base,
          strokes: [{ ...base.strokes[0], type: "text", points: [{ x: 0, y: 0 }] }],
        }),
      ),
    ).toContain("STROKE_TEXT_MISSING");

    expect(
      codes(validateStrokeAST({ ...base, strokes: [{ ...base.strokes[0], dependencies: ["later"] }] })),
    ).toContain("STROKE_DEPENDENCY_INVALID");
  });
});
