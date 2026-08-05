import { describe, it, expect } from "vitest";
import {
  IntentModelSchema,
  VisualPlanSchema,
  VILSchema,
  TeachingIntentSchema,
  RelationshipTypeSchema,
  SCHEMA_VERSION,
} from "../src/index.js";

const intent = {
  version: SCHEMA_VERSION,
  intent: "explain",
  subject: "pulley system",
  domain: "physics",
  category: "schematic",
  complexity: "moderate",
  teachingObjective: "Show how a movable pulley halves the required force.",
  rawRequest: "Draw a pulley system",
} as const;

describe("IntentModel", () => {
  it("accepts the Volume 03 Intent Analyzer output", () => {
    expect(IntentModelSchema.parse(intent)).toEqual(intent);
  });

  it("rejects an unknown teaching intent, since intent selects the drawing strategy", () => {
    const r = IntentModelSchema.safeParse({ ...intent, intent: "vibes" });
    expect(r.success).toBe(false);
  });

  it("leaves domain open, because the agent must handle any technical domain", () => {
    const r = IntentModelSchema.safeParse({ ...intent, domain: "marine biology" });
    expect(r.success).toBe(true);
  });

  it("rejects an empty subject", () => {
    expect(IntentModelSchema.safeParse({ ...intent, subject: "" }).success).toBe(false);
  });

  it("covers every Volume 13 teaching intent", () => {
    expect([...TeachingIntentSchema.options].sort()).toEqual(
      ["animate", "classify", "compare", "demonstrate", "explain", "highlight", "label"].sort(),
    );
  });
});

describe("VisualPlan", () => {
  const plan = {
    version: SCHEMA_VERSION,
    detailLevel: "standard",
    objects: [
      { id: "ceiling", name: "Ceiling", importance: "supporting" },
      { id: "pulley", name: "Fixed Pulley", importance: "primary" },
    ],
    labels: [{ target: "pulley", text: "Fixed Pulley" }],
    highlights: [{ target: "pulley", reason: "the mechanism under discussion" }],
    animations: [{ target: "pulley", behavior: "rotate" }],
    focusOrder: ["ceiling", "pulley"],
  } as const;

  it("accepts the Volume 03 Visual Planning Agent output", () => {
    expect(VisualPlanSchema.parse(plan)).toEqual(plan);
  });

  it("requires at least one object -- an empty plan is a failed plan", () => {
    expect(VisualPlanSchema.safeParse({ ...plan, objects: [] }).success).toBe(false);
  });
});

describe("VIL", () => {
  const vil = {
    version: SCHEMA_VERSION,
    intent: "explain",
    subject: "pulley system",
    context: { gradeLevel: "secondary" },
    objects: [
      { id: "pulley", type: "pulley", role: "mechanism", importance: "primary" },
      { id: "load", type: "mass", role: "load", importance: "secondary" },
    ],
    relationships: [{ id: "r1", type: "connectedTo", from: "pulley", to: "load" }],
    annotations: [{ id: "a1", target: "pulley", text: "pivot point" }],
    emphasis: ["pulley"],
    metadata: { source: "test" },
  } as const;

  it("accepts the Volume 13 core sections", () => {
    expect(VILSchema.parse(vil)).toMatchObject(vil);
  });

  it("defaults optional collections, so the model may omit what is empty", () => {
    const parsed = VILSchema.parse(vil);
    // The fixture omits per-object labels/behaviors entirely.
    expect(parsed.objects[0]).toMatchObject({ labels: [], behaviors: [] });
  });

  it("rejects an unsupported relationship type", () => {
    const r = VILSchema.safeParse({
      ...vil,
      relationships: [{ id: "r1", type: "orbits", from: "pulley", to: "load" }],
    });
    expect(r.success).toBe(false);
  });

  it("shares one relationship vocabulary with the Diagram AST", () => {
    // Volume 04 lists 12 and Volume 13 lists 8 with two not in Volume 04.
    // Unified deliberately so VIL -> AST needs no lossy translation table.
    const options = [...RelationshipTypeSchema.options];
    expect(options).toContain("contains");
    expect(options).toContain("pointsTo");
    expect(options).toContain("wraps");
    expect(options).toHaveLength(14);
  });

  it("rejects a missing version, so schema evolution stays detectable", () => {
    const { version: _drop, ...rest } = vil;
    expect(VILSchema.safeParse(rest).success).toBe(false);
  });
});
