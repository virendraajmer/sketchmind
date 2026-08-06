import { describe, expect, it } from "vitest";
import {
  CritiqueFindingSchema,
  CritiqueReportSchema,
  RuntimeEventSchema,
  SCHEMA_VERSION,
} from "../src/index.js";

const FINDING = {
  id: "f1",
  tier: "geometric",
  check: "anchor-miss",
  severity: "error",
  message: "The rope does not meet the pulley's groove anchor.",
  objectIds: ["rope_1", "pulley_1"],
  proposal: { kind: "move_object", objectId: "rope_1", hint: "attach it to the groove" },
};

describe("CritiqueFinding", () => {
  it("accepts a well-formed finding", () => {
    const parsed = CritiqueFindingSchema.safeParse(FINDING);
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown tier", () => {
    const parsed = CritiqueFindingSchema.safeParse({ ...FINDING, tier: "vibes" });
    expect(parsed.success).toBe(false);
  });

  it("defaults objectIds to an empty array", () => {
    const { objectIds, ...rest } = FINDING;
    const parsed = CritiqueFindingSchema.parse(rest);
    expect(parsed.objectIds).toEqual([]);
  });

  it("makes the proposal optional", () => {
    const { proposal, ...rest } = FINDING;
    expect(CritiqueFindingSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects a coordinate smuggled into a proposal", () => {
    const parsed = CritiqueFindingSchema.safeParse({
      ...FINDING,
      proposal: { kind: "move_object", objectId: "rope_1", hint: "here", x: 10, y: 20 },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("CritiqueReport", () => {
  it("round-trips a report", () => {
    const report = { version: SCHEMA_VERSION, tier: "visual", findings: [FINDING] };
    expect(CritiqueReportSchema.safeParse(report).success).toBe(true);
  });
});

describe("VisionCritique runtime event", () => {
  it("carries structured findings and a tier", () => {
    const parsed = RuntimeEventSchema.safeParse({
      sessionId: "s1",
      at: new Date().toISOString(),
      type: "VisionCritique",
      tier: "geometric",
      findings: [FINDING],
      accepted: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects the old string-array shape", () => {
    const parsed = RuntimeEventSchema.safeParse({
      sessionId: "s1",
      at: new Date().toISOString(),
      type: "VisionCritique",
      findings: ["looks wrong"],
      accepted: false,
    });
    expect(parsed.success).toBe(false);
  });
});
