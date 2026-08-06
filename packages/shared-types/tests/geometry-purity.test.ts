/**
 * The geometry boundary, enforced.
 *
 * Every volume states in prose that semantic models must not contain geometry:
 * "Do not mix geometry into the Diagram AST" (V04), "Only this model contains
 * geometry" (V05), "The graph never stores coordinates" (V14). Prose does not
 * fail a build, and this is the invariant the entire architecture rests on --
 * once a coordinate leaks into the Diagram AST, the AST stops being renderer
 * independent and nothing downstream can put it back.
 *
 * So it is a test. Each guarded schema is converted to JSON Schema and walked;
 * any banned property name anywhere in the tree fails.
 *
 * Proven to fail when violated -- see the last block, which plants a geometry
 * field and asserts the walker catches it. A guard nobody has watched fail is
 * not a guard.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  DiagramASTSchema,
  ShapeGraphSchema,
  VisualPlanSchema,
  VILSchema,
  ConstraintGraphSchema,
  IntentModelSchema,
  LayoutModelSchema,
  StrokeASTSchema,
  CritiqueFindingSchema,
  CritiqueReportSchema,
} from "../src/index.js";

/**
 * Property names that mean "a position, size, or path in diagram space".
 *
 * `u`/`v` are deliberately absent: they are FreeformShape's unit-space
 * coordinates, which are proportions inside a shape, not places on the board
 * (see src/freeform.ts). FreeformShape is not a guarded model for that reason.
 */
const BANNED = [
  "x", "y", "cx", "cy", "dx", "dy",
  "width", "height", "rotation", "scale",
  "left", "top", "right", "bottom",
  "points", "path", "d", "transform",
  "bounds", "boundingBox", "viewBox", "coordinates",
  "position", "offset", "translate",
];

/** Collect every property name appearing anywhere in a JSON Schema. */
function collectPropertyNames(node: unknown, found = new Set<string>()): Set<string> {
  if (node === null || typeof node !== "object") return found;

  if (Array.isArray(node)) {
    for (const item of node) collectPropertyNames(item, found);
    return found;
  }

  const obj = node as Record<string, unknown>;

  if (obj.properties && typeof obj.properties === "object") {
    for (const key of Object.keys(obj.properties as Record<string, unknown>)) {
      found.add(key);
    }
  }

  // Recurse through everything, including $defs, anyOf, items, and the
  // property subschemas themselves -- geometry three levels down still counts.
  for (const value of Object.values(obj)) collectPropertyNames(value, found);

  return found;
}

function geometryFieldsIn(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  const names = collectPropertyNames(json);
  return BANNED.filter((banned) => names.has(banned));
}

const GUARDED: Array<[string, z.ZodType]> = [
  ["DiagramAST", DiagramASTSchema],
  ["ShapeGraph", ShapeGraphSchema],
  ["VisualPlan", VisualPlanSchema],
  ["VIL", VILSchema],
  ["ConstraintGraph", ConstraintGraphSchema],
  ["IntentModel", IntentModelSchema],
  ["CritiqueFinding", CritiqueFindingSchema],
  ["CritiqueReport", CritiqueReportSchema],
];

describe("geometry purity", () => {
  it.each(GUARDED)("%s contains no geometry field", (_name, schema) => {
    expect(geometryFieldsIn(schema)).toEqual([]);
  });

  it("guards every semantic model the pipeline produces before layout", () => {
    expect(GUARDED.map(([n]) => n)).toEqual([
      "DiagramAST",
      "ShapeGraph",
      "VisualPlan",
      "VIL",
      "ConstraintGraph",
      "IntentModel",
      "CritiqueFinding",
      "CritiqueReport",
    ]);
  });
});

describe("the two models that may carry geometry", () => {
  it("LayoutModel does carry it -- it is the model that owns geometry", () => {
    const found = geometryFieldsIn(LayoutModelSchema);
    expect(found).toContain("x");
    expect(found).toContain("width");
    expect(found).toContain("rotation");
  });

  it("StrokeAST carries pen paths", () => {
    expect(geometryFieldsIn(StrokeASTSchema)).toContain("points");
  });
});

describe("the guard itself", () => {
  it("fails when a geometry field is planted at the top level", () => {
    const planted = DiagramASTSchema.extend({ x: z.number() });
    expect(geometryFieldsIn(planted)).toEqual(["x"]);
  });

  it("fails when geometry is planted deep inside a nested object", () => {
    const planted = z.object({
      version: z.literal("1.0"),
      objects: z.array(
        z.object({
          id: z.string(),
          layout: z.object({ nested: z.object({ cx: z.number(), cy: z.number() }) }),
        }),
      ),
    });
    expect(geometryFieldsIn(planted)).toEqual(["cx", "cy"]);
  });

  it("fails when geometry is planted inside a recursive branch", () => {
    // The Diagram AST's real risk: geometry added to `children`, not the root.
    interface Node { id: string; width?: number; children: Node[] }
    const NodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.object({
        id: z.string(),
        width: z.number().optional(),
        children: z.array(NodeSchema).default([]),
      }),
    );
    expect(geometryFieldsIn(z.object({ objects: z.array(NodeSchema) }))).toEqual(["width"]);
  });

  it("does not fire on innocent names that merely contain a banned substring", () => {
    const innocent = z.object({
      maxWidth: z.number(),
      xAxisLabel: z.string(),
      pathology: z.string(),
      heightened: z.boolean(),
    });
    expect(geometryFieldsIn(innocent)).toEqual([]);
  });
});
