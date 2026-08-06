import { describe, expect, it } from "vitest";
import {
  boxesOverlap,
  centroidOf,
  containsBox,
  distance,
  overlapArea,
  segmentsIntersect,
} from "../src/internal/geometry.js";

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("overlapArea", () => {
  it("is zero for disjoint boxes", () => {
    expect(overlapArea(box(0, 0, 10, 10), box(20, 20, 10, 10))).toBe(0);
  });

  it("is zero for boxes that only touch", () => {
    expect(overlapArea(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(0);
  });

  it("measures a partial overlap", () => {
    expect(overlapArea(box(0, 0, 10, 10), box(5, 5, 10, 10))).toBe(25);
  });
});

describe("boxesOverlap", () => {
  it("ignores an overlap within tolerance", () => {
    expect(boxesOverlap(box(0, 0, 10, 10), box(9.8, 0, 10, 10), 0.5)).toBe(false);
  });

  it("reports an overlap beyond tolerance", () => {
    expect(boxesOverlap(box(0, 0, 10, 10), box(5, 0, 10, 10), 0.5)).toBe(true);
  });
});

describe("containsBox", () => {
  it("is true when inner sits wholly inside outer", () => {
    expect(containsBox(box(0, 0, 100, 100), box(10, 10, 10, 10))).toBe(true);
  });

  it("is false when inner pokes out", () => {
    expect(containsBox(box(0, 0, 100, 100), box(95, 10, 10, 10))).toBe(false);
  });
});

describe("segmentsIntersect", () => {
  it("detects a crossing", () => {
    const hit = segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 });
    expect(hit).toBe(true);
  });

  it("does not report parallel segments", () => {
    const hit = segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 });
    expect(hit).toBe(false);
  });

  it("does not report segments that merely share an endpoint", () => {
    const hit = segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 5 });
    expect(hit).toBe(false);
  });
});

describe("distance", () => {
  it("measures a 3-4-5 triangle", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

describe("centroidOf", () => {
  it("averages box centres", () => {
    expect(centroidOf([box(0, 0, 10, 10), box(10, 10, 10, 10)])).toEqual({ x: 10, y: 10 });
  });

  it("returns the origin for no boxes", () => {
    expect(centroidOf([])).toEqual({ x: 0, y: 0 });
  });
});
