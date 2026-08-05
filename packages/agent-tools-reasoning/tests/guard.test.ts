import { describe, it, expect } from "vitest";
import {
  BANNED_FIELDS,
  BANNED_FIELDS_UNIT_SPACE,
  geometryErrors,
  geometryViolations,
} from "../src/index.js";

describe("geometryViolations", () => {
  it("finds nothing in a geometry-free model", () => {
    expect(geometryViolations({ id: "circle", type: "circle", labels: [{ text: "Circle" }] })).toEqual([]);
  });

  /**
   * The case the static schema guard cannot cover: every semantic model carries
   * an open metadata bag, so a model stashing coordinates in one passes every
   * schema in the repo.
   */
  it("finds geometry hidden in an open metadata bag", () => {
    expect(geometryViolations({ id: "a", metadata: { x: 40, y: 120 } })).toEqual([
      "metadata.x",
      "metadata.y",
    ]);
  });

  it("finds geometry inside arrays, with the index in the path", () => {
    expect(geometryViolations({ objects: [{ id: "a" }, { id: "b", width: 10 }] })).toEqual([
      "objects[1].width",
    ]);
  });

  it("reports every violation, not just the first", () => {
    expect(geometryViolations({ svg: "<svg/>", canvasCommand: "arc", position: {} })).toHaveLength(3);
  });

  it("bans the two fields that only appear when a model tries to draw directly", () => {
    expect(BANNED_FIELDS).toContain("svg");
    expect(BANNED_FIELDS).toContain("canvasCommand");
  });

  /**
   * FreeformShape's `points` are `{ u, v }` proportions inside the shape's own
   * box (AD-5), not places on the board -- so the unit-space list makes room for
   * them while keeping `svg` and `transform` banned.
   */
  it("permits unit-space points under the freeform list, but never svg", () => {
    const shape = { parts: [{ points: [{ u: 0.5, v: 0.5 }] }] };

    expect(geometryViolations(shape, BANNED_FIELDS_UNIT_SPACE)).toEqual([]);
    expect(geometryViolations(shape)).toEqual(["parts[0].points"]);
    expect(geometryViolations({ svg: "x" }, BANNED_FIELDS_UNIT_SPACE)).toEqual(["svg"]);
  });
});

describe("geometryErrors", () => {
  it("produces recoverable errors naming the offending path", () => {
    const errors = geometryErrors({ metadata: { x: 1 } }, "diagram-ast");

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("AI_EMITTED_GEOMETRY");
    expect(errors[0]?.path).toBe("metadata.x");
    expect(errors[0]?.recoverable).toBe(true);
    expect(errors[0]?.message).toContain("layout engine");
  });
});
