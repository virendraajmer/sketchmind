import { describe, expect, it } from "vitest";
import { CHECKS, DEFAULT_OPTIONS, type CheckInput } from "../src/internal/checks.js";
import type { DiagramAST, LayoutModel, StrokeAST } from "@sketchmind/shared-types";

const node = (objectId: string, x: number, y: number, width = 20, height = 20) => ({
  objectId,
  position: { x, y },
  size: { width, height },
  rotation: 0,
  bounds: { x, y, width, height },
  anchors: [],
  zIndex: 0,
});

const ast = { objects: [], relationships: [] } as unknown as DiagramAST;

function layout(partial: Partial<LayoutModel>): LayoutModel {
  return {
    version: "1.0.0",
    diagramId: "d1",
    strategy: "manual",
    canvas: { width: 200, height: 200 },
    nodes: [],
    connectors: [],
    labels: [],
    ...partial,
  } as LayoutModel;
}

function input(model: LayoutModel, strokes?: StrokeAST): CheckInput {
  return { ast, layout: model, options: DEFAULT_OPTIONS, ...(strokes ? { strokes } : {}) };
}

const runCheck = (name: string, checkInput: CheckInput) => {
  const check = CHECKS.find((c) => c.name === name);
  if (!check) throw new Error(`no check named ${name}`);
  return check.run(checkInput);
};

describe("overlap", () => {
  it("reports two nodes sitting on top of each other", () => {
    const found = runCheck("overlap", input(layout({ nodes: [node("a", 0, 0), node("b", 10, 10)] })));
    expect(found).toHaveLength(1);
    expect(found[0]?.objectIds.sort()).toEqual(["a", "b"]);
    expect(found[0]?.proposal?.kind).toBe("move_object");
  });

  it("stays silent for separated nodes", () => {
    expect(runCheck("overlap", input(layout({ nodes: [node("a", 0, 0), node("b", 100, 100)] })))).toEqual([]);
  });

  it("stays silent for nodes that merely touch", () => {
    expect(runCheck("overlap", input(layout({ nodes: [node("a", 0, 0), node("b", 20, 0)] })))).toEqual([]);
  });
});

describe("out-of-bounds", () => {
  it("reports a node outside the canvas", () => {
    const found = runCheck("out-of-bounds", input(layout({ nodes: [node("a", 190, 10)] })));
    expect(found).toHaveLength(1);
    expect(found[0]?.objectIds).toEqual(["a"]);
  });

  it("stays silent for a node inside the canvas", () => {
    expect(runCheck("out-of-bounds", input(layout({ nodes: [node("a", 10, 10)] })))).toEqual([]);
  });
});

describe("anchor-miss", () => {
  const anchored = layout({
    nodes: [
      { ...node("pulley", 0, 0), anchors: [{ name: "groove", point: { x: 10, y: 0 } }] },
      node("weight", 100, 100),
    ],
    connectors: [
      {
        relationshipId: "rope",
        routing: "straight",
        points: [
          { x: 40, y: 40 },
          { x: 110, y: 110 },
        ],
        metadata: { sourceAnchor: "pulley:groove" },
      },
    ],
  });

  it("reports an endpoint far from its declared anchor", () => {
    const found = runCheck("anchor-miss", input(anchored));
    expect(found).toHaveLength(1);
    expect(found[0]?.check).toBe("anchor-miss");
    expect(found[0]?.objectIds).toContain("pulley");
  });

  it("stays silent when the endpoint meets the anchor", () => {
    const met = layout({
      ...anchored,
      connectors: [
        {
          ...anchored.connectors[0]!,
          points: [
            { x: 10, y: 0 },
            { x: 110, y: 110 },
          ],
        },
      ],
    });
    expect(runCheck("anchor-miss", input(met))).toEqual([]);
  });
});

describe("connector-crossing", () => {
  it("reports two connectors that cross", () => {
    const crossing = layout({
      connectors: [
        { relationshipId: "r1", routing: "straight", points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] },
        { relationshipId: "r2", routing: "straight", points: [{ x: 0, y: 100 }, { x: 100, y: 0 }] },
      ],
    });
    expect(runCheck("connector-crossing", input(crossing))).toHaveLength(1);
  });

  it("stays silent for parallel connectors", () => {
    const parallel = layout({
      connectors: [
        { relationshipId: "r1", routing: "straight", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
        { relationshipId: "r2", routing: "straight", points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] },
      ],
    });
    expect(runCheck("connector-crossing", input(parallel))).toEqual([]);
  });
});

describe("degenerate-size", () => {
  it("reports a zero-sized node", () => {
    const found = runCheck("degenerate-size", input(layout({ nodes: [node("a", 10, 10, 0, 0)] })));
    expect(found).toHaveLength(1);
    expect(found[0]?.proposal?.kind).toBe("resize_object");
  });

  it("stays silent for a normal node", () => {
    expect(runCheck("degenerate-size", input(layout({ nodes: [node("a", 10, 10)] })))).toEqual([]);
  });
});

describe("whitespace-imbalance", () => {
  it("reports content bunched into one corner", () => {
    const found = runCheck(
      "whitespace-imbalance",
      input(layout({ nodes: [node("a", 0, 0), node("b", 20, 0)] })),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("info");
    expect(found[0]?.proposal).toBeUndefined();
  });

  it("stays silent for centred content", () => {
    const centred = layout({ nodes: [node("a", 80, 80, 40, 40)] });
    expect(runCheck("whitespace-imbalance", input(centred))).toEqual([]);
  });
});

describe("stroke-coverage", () => {
  const strokes = (targets: string[]): StrokeAST =>
    ({
      version: "1.0.0",
      diagramId: "d1",
      strokes: targets.map((target, index) => ({
        id: `s${index}`,
        type: "rectangle",
        target,
        order: index,
        dependencies: [],
        points: [{ x: 0, y: 0 }],
        style: {},
        timing: {},
      })),
    }) as unknown as StrokeAST;

  it("reports a node nothing drew", () => {
    const found = runCheck(
      "stroke-coverage",
      input(layout({ nodes: [node("a", 0, 0), node("b", 100, 100)] }), strokes(["a"])),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.objectIds).toEqual(["b"]);
  });

  it("stays silent when every node is drawn", () => {
    const found = runCheck(
      "stroke-coverage",
      input(layout({ nodes: [node("a", 0, 0)] }), strokes(["a"])),
    );
    expect(found).toEqual([]);
  });

  it("is skipped when there is no stroke AST", () => {
    expect(runCheck("stroke-coverage", input(layout({ nodes: [node("a", 0, 0)] })))).toEqual([]);
  });
});
