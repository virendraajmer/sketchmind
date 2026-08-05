import { describe, it, expect } from "vitest";
import { FakeProvider, fakeReturning } from "@sketchmind/llm-provider";
import { SCHEMA_VERSION, renderPromptTemplate } from "@sketchmind/shared-types";
import { INTENT_PROMPT, PACKAGE_NAME, PACKAGE_VERSION, analyzeIntent } from "../src/index.js";

const pulley = {
  intent: "explain",
  subject: "movable pulley system",
  domain: "physics",
  category: "schematic",
  complexity: "moderate",
  teachingObjective: "Understand how a movable pulley halves the effort needed to lift a load.",
};

describe("intent-analyzer package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/intent-analyzer");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});

describe("analyzeIntent", () => {
  it("produces a validated IntentModel from a request", async () => {
    const result = await analyzeIntent({
      provider: fakeReturning(pulley),
      request: "Draw a movable pulley",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subject).toBe("movable pulley system");
    expect(result.value.category).toBe("schematic");
  });

  /**
   * Both fields are supplied by us, not asked of the model: one because a model
   * should not have to know a schema version, the other because paraphrasing the
   * user's own words is the one thing this field must never do.
   */
  it("stamps the schema version and preserves the request verbatim", async () => {
    const request = "Draw a movable pulley, please";
    const result = await analyzeIntent({ provider: fakeReturning(pulley), request });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(SCHEMA_VERSION);
    expect(result.value.rawRequest).toBe(request);
  });

  it("never asks the model for version or rawRequest", async () => {
    const provider = fakeReturning(pulley);
    await analyzeIntent({ provider, request: "Draw a circle" });

    // The schema the model is shown is injected into the system message.
    const sent = provider.calls[0]?.system ?? "";
    expect(sent).toContain("teachingObjective");
    expect(sent).not.toContain("rawRequest");
    expect(sent).not.toContain('"version"');
  });

  it("reports a model that will not produce valid output as errors, not a throw", async () => {
    const result = await analyzeIntent({
      provider: new FakeProvider({
        responses: ["a pulley is a wheel on an axle"],
        capabilities: { structuredOutput: false },
      }),
      request: "Draw a movable pulley",
      maxRepairAttempts: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.stage).toBe("intent");
    expect(result.errors[0]?.recoverable).toBe(true);
  });

  it("rejects a category outside the closed set, rather than passing it through", async () => {
    const result = await analyzeIntent({
      provider: fakeReturning({ ...pulley, category: "vibes" }),
      request: "Draw a movable pulley",
      maxRepairAttempts: 0,
    });

    expect(result.ok).toBe(false);
  });

  it("attaches caller metadata without sending it to the model", async () => {
    const provider = fakeReturning(pulley);
    const result = await analyzeIntent({
      provider,
      request: "Draw a circle",
      metadata: { sessionId: "s-1" },
    });

    expect(result.ok && result.value.metadata).toEqual({ sessionId: "s-1" });
    expect(JSON.stringify(provider.calls)).not.toContain("s-1");
  });
});

describe("INTENT_PROMPT", () => {
  it("forbids geometry, as every SketchMind prompt must", () => {
    expect(INTENT_PROMPT.forbiddenOutput.join(" ")).toMatch(/coordinate/i);
  });

  /** The two examples are the ends of the range AD-1's adaptive depth spans. */
  it("shows both a complex and a simple request", () => {
    const rendered = renderPromptTemplate(INTENT_PROMPT);
    expect(rendered).toContain("Draw a movable pulley");
    expect(rendered).toContain("Draw a circle");
  });
});
