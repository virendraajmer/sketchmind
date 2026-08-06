import { describe, expect, it } from "vitest";
import { critiqueGeometry } from "../src/index.js";
import type { DiagramAST, LayoutModel } from "@sketchmind/shared-types";

const ast = { objects: [], relationships: [] } as unknown as DiagramAST;

const node = (objectId: string, x: number, y: number, width = 20, height = 20) => ({
  objectId,
  position: { x, y },
  size: { width, height },
  rotation: 0,
  bounds: { x, y, width, height },
  anchors: [],
  zIndex: 0,
});

const layout = (nodes: ReturnType<typeof node>[]): LayoutModel =>
  ({
    version: "1.0",
    diagramId: "d1",
    strategy: "manual",
    canvas: { width: 200, height: 200 },
    nodes,
    connectors: [],
    labels: [],
  }) as LayoutModel;

describe("critiqueGeometry", () => {
  it("returns nothing for a clean diagram", () => {
    expect(critiqueGeometry({ ast, layout: layout([node("a", 90, 90)]) })).toEqual([]);
  });

  it("collects findings from several checks at once", () => {
    const found = critiqueGeometry({
      ast,
      layout: layout([node("a", 0, 0), node("b", 10, 10), node("c", 205, 205, 0, 0)]),
    });
    const checks = new Set(found.map((f) => f.check));
    expect(checks.has("overlap")).toBe(true);
    expect(checks.has("degenerate-size")).toBe(true);
    expect(checks.has("out-of-bounds")).toBe(true);
  });

  it("is deterministic: the same input yields an identically ordered array", () => {
    const model = layout([node("b", 10, 10), node("a", 0, 0)]);
    const first = critiqueGeometry({ ast, layout: model });
    const second = critiqueGeometry({ ast, layout: model });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("honours a disabled check", () => {
    const found = critiqueGeometry({
      ast,
      layout: layout([node("a", 0, 0), node("b", 10, 10)]),
      options: { checks: { overlap: false } },
    });
    expect(found.some((f) => f.check === "overlap")).toBe(false);
  });

  it("honours a widened overlap tolerance", () => {
    const found = critiqueGeometry({
      ast,
      layout: layout([node("a", 0, 0), node("b", 10, 10)]),
      options: { overlapToleranceUnits: 50 },
    });
    expect(found.some((f) => f.check === "overlap")).toBe(false);
  });

  it("tags every finding as geometric", () => {
    const found = critiqueGeometry({ ast, layout: layout([node("a", 0, 0), node("b", 10, 10)]) });
    expect(found.every((f) => f.tier === "geometric")).toBe(true);
  });
});
