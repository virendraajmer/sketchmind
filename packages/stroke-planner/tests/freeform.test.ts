import { describe, it, expect } from "vitest";
import type { DiagramAST, FreeformShape, LayoutModel, StrokeAST } from "@sketchmind/shared-types";
import { planStrokes } from "../src/index.js";

function unwrap(result: { ok: boolean; value?: StrokeAST; errors?: readonly unknown[] }): StrokeAST {
  if (!result.ok) throw new Error(`expected ok, got: ${JSON.stringify(result.errors, null, 2)}`);
  return result.value as StrokeAST;
}

const HEXAGON: FreeformShape = {
  version: "1.0",
  id: "hexagon",
  name: "hexagon",
  parts: [
    {
      id: "outline",
      kind: "polygon",
      points: [
        { u: 0.25, v: 0.0669873 },
        { u: 0.75, v: 0.0669873 },
        { u: 1, v: 0.5 },
        { u: 0.75, v: 0.9330127 },
        { u: 0.25, v: 0.9330127 },
        { u: 0, v: 0.5 },
      ],
      closed: false,
      order: 0,
    },
  ],
  anchors: [],
  aspectRatio: 1,
};

function astOf(type: string): DiagramAST {
  return {
    id: "d",
    version: "1.0",
    subject: type,
    title: type,
    category: "structural",
    objects: [
      {
        id: "shape",
        type,
        name: type,
        category: "geometry",
        anchors: [],
        behaviors: [],
        labels: [],
        children: [],
      },
    ],
    relationships: [],
    groups: [],
    annotations: [],
    metadata: { tags: [] },
  };
}

// A deliberately non-square box: the shape must be letterboxed inside it, not
// stretched to fill it.
const LAYOUT: LayoutModel = {
  version: "1.0",
  diagramId: "d",
  strategy: "grid",
  canvas: { width: 220, height: 170 },
  nodes: [
    {
      objectId: "shape",
      position: { x: 40, y: 40 },
      size: { width: 140, height: 90 },
      rotation: 0,
      bounds: { x: 40, y: 40, width: 140, height: 90 },
      anchors: [],
      zIndex: 0,
    },
  ],
  connectors: [],
  labels: [],
};

const freeforms = new Map([[HEXAGON.id, HEXAGON]]);

describe("freeform generator (AD-5)", () => {
  it("draws the composed shape instead of the type table's box", () => {
    const strokes = unwrap(planStrokes(astOf("hexagon"), LAYOUT, { freeforms })).strokes;
    expect(strokes).toHaveLength(1);
    expect(strokes[0]!.type).toBe("polygon");
    // Six vertices, closed by repeating the first.
    expect(strokes[0]!.points).toHaveLength(7);
    expect(strokes[0]!.metadata?.["generator"]).toBe("freeform");
  });

  // The regression this whole path exists to fix: before it, every unrecognised
  // type silently became a rectangle.
  it("still falls back to a box when nothing composed a shape", () => {
    const strokes = unwrap(planStrokes(astOf("hexagon"), LAYOUT)).strokes;
    expect(strokes[0]!.type).toBe("rectangle");
  });

  it("scales into the node without distorting the shape's aspect ratio", () => {
    const points = unwrap(planStrokes(astOf("hexagon"), LAYOUT, { freeforms })).strokes[0]!.points;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    // A 1:1 shape in a 140x90 box is letterboxed into 90x90, centred: u 0..1
    // maps to x 65..155, and v 0..1 to y 40..130. This hexagon's own extent is
    // u 0..1 by v 0.067..0.933, so it fills the width and insets the height.
    expect(Math.min(...xs)).toBeCloseTo(65, 3);
    expect(Math.max(...xs)).toBeCloseTo(155, 3);
    expect(Math.min(...ys)).toBeCloseTo(40 + 0.0669873 * 90, 3);
    expect(Math.max(...ys)).toBeCloseTo(40 + 0.9330127 * 90, 3);
  });

  it("matches a shape by the object's own type, not only an explicit id", () => {
    const shapes = new Map([["bolt_1", { ...HEXAGON, id: "bolt_1", name: "Lightning Bolt" }]]);
    const strokes = unwrap(
      planStrokes(astOf("lightning-bolt"), LAYOUT, { freeforms: shapes }),
    ).strokes;
    expect(strokes[0]!.type).toBe("polygon");
  });

  it("prefers the shape an object names explicitly", () => {
    const ast = astOf("blob");
    const objects = [{ ...ast.objects[0]!, properties: { freeformId: "hexagon" } }];
    const strokes = unwrap(planStrokes({ ...ast, objects }, LAYOUT, { freeforms })).strokes;
    expect(strokes[0]!.type).toBe("polygon");
  });

  it("samples a curve into a pen path rather than emitting its control points", () => {
    const wave: FreeformShape = {
      ...HEXAGON,
      id: "wave",
      name: "wave",
      parts: [
        {
          id: "c",
          kind: "curve",
          points: [
            { u: 0, v: 0.5 },
            { u: 0.33, v: 0 },
            { u: 0.66, v: 1 },
            { u: 1, v: 0.5 },
          ],
          closed: false,
          order: 0,
        },
      ],
    };
    const strokes = unwrap(
      planStrokes(astOf("wave"), LAYOUT, { freeforms: new Map([["wave", wave]]) }),
    ).strokes;
    expect(strokes[0]!.type).toBe("curve");
    expect(strokes[0]!.points.length).toBeGreaterThan(4);
  });

  it("is deterministic, like every other plan (AD-6)", () => {
    const once = planStrokes(astOf("hexagon"), LAYOUT, { freeforms });
    const twice = planStrokes(astOf("hexagon"), LAYOUT, { freeforms });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});
