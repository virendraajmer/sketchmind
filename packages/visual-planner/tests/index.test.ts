import { describe, it, expect } from "vitest";
import { fakeReturning } from "@sketchmind/llm-provider";
import { SCHEMA_VERSION, type IntentModel } from "@sketchmind/shared-types";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  VISUAL_PLAN_PROMPT,
  planVisual,
  validateVisualPlan,
} from "../src/index.js";

const intent: IntentModel = {
  version: SCHEMA_VERSION,
  intent: "explain",
  subject: "movable pulley system",
  domain: "physics",
  category: "schematic",
  complexity: "moderate",
  teachingObjective: "Understand how a movable pulley halves the effort.",
  rawRequest: "Draw a movable pulley",
};

const draft = {
  detailLevel: "standard",
  objects: [
    { id: "ceiling", name: "Ceiling", importance: "supporting" },
    { id: "fixed_pulley", name: "Fixed Pulley", importance: "primary" },
    { id: "load", name: "Load", importance: "secondary" },
  ],
  labels: [{ target: "load", text: "Load" }],
  highlights: [],
  animations: [],
  focusOrder: ["ceiling", "fixed_pulley", "load"],
};

describe("visual-planner package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/visual-planner");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});

describe("planVisual", () => {
  it("produces a validated plan and stamps the schema version", async () => {
    const result = await planVisual({ provider: fakeReturning(draft), intent });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(SCHEMA_VERSION);
    expect(result.value.objects.map((object) => object.id)).toEqual([
      "ceiling",
      "fixed_pulley",
      "load",
    ]);
  });

  it("sends the intent, including the user's original wording", async () => {
    const provider = fakeReturning(draft);
    await planVisual({ provider, intent });

    const sent = provider.calls[0]?.messages[0]?.content ?? "";
    expect(sent).toContain("movable pulley system");
    expect(sent).toContain("Draw a movable pulley");
  });
});

describe("validateVisualPlan", () => {
  const plan = { ...draft, version: SCHEMA_VERSION };

  /**
   * The failure this stage actually has: the model renames an object between the
   * `objects` array and the `labels` array, and nothing downstream notices until
   * layout tries to place a label on nothing.
   */
  it("catches a label pointing at an object that does not exist", () => {
    const result = validateVisualPlan({ ...plan, labels: [{ target: "rope", text: "Rope" }] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("PLAN_UNKNOWN_TARGET");
    expect(result.errors[0]?.path).toBe("labels[0].target");
    expect(result.errors[0]?.message).toContain("fixed_pulley");
  });

  it("reports every dangling reference at once, not just the first", () => {
    const result = validateVisualPlan({
      ...plan,
      labels: [{ target: "rope", text: "Rope" }],
      highlights: [{ target: "effort", reason: "n/a" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(2);
  });

  it("catches duplicate object ids", () => {
    const result = validateVisualPlan({
      ...plan,
      objects: [...plan.objects, { id: "load", name: "Load again", importance: "supporting" }],
      focusOrder: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.code === "PLAN_DUPLICATE_ID")).toBe(true);
  });

  /**
   * An omitted order is a gap we can fill deterministically; a partial one is a
   * claim that contradicts the object list, and rewriting it would throw away
   * what the model actually said.
   */
  it("fills an empty focusOrder by importance, deterministically", () => {
    const result = validateVisualPlan({ ...plan, focusOrder: [] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.focusOrder).toEqual(["fixed_pulley", "load", "ceiling"]);
  });

  it("rejects a partial focusOrder rather than silently completing it", () => {
    const result = validateVisualPlan({ ...plan, focusOrder: ["fixed_pulley"] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("PLAN_INCOMPLETE_FOCUS_ORDER");
    expect(result.errors[0]?.message).toContain("ceiling");
  });

  it("rejects a plan with no objects -- an empty plan is a failed plan", () => {
    expect(validateVisualPlan({ ...plan, objects: [], focusOrder: [] }).ok).toBe(false);
  });

  it("accepts a single-object plan", () => {
    const result = validateVisualPlan({
      version: SCHEMA_VERSION,
      detailLevel: "minimal",
      objects: [{ id: "circle", name: "Circle", importance: "primary" }],
      labels: [],
      highlights: [],
      animations: [],
      focusOrder: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.focusOrder).toEqual(["circle"]);
  });
});

describe("VISUAL_PLAN_PROMPT", () => {
  it("forbids geometry and dangling references", () => {
    const forbidden = VISUAL_PLAN_PROMPT.forbiddenOutput.join(" ");
    expect(forbidden).toMatch(/coordinate/i);
    expect(forbidden).toMatch(/not in `objects`/i);
  });
});
