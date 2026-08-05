import { describe, it, expect } from "vitest";
import { fakeReturning } from "@sketchmind/llm-provider";
import { SCHEMA_VERSION, makeError, type IntentModel } from "@sketchmind/shared-types";
import {
  DIAGRAM_AST_PROMPT,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  composeDiagramAST,
} from "../src/index.js";

const circle = {
  id: "circle_diagram",
  subject: "circle",
  title: "Circle",
  category: "structural",
  objects: [
    {
      id: "circle",
      type: "circle",
      name: "Circle",
      category: "geometry",
      anchors: [{ name: "centre" }],
      behaviors: [],
      labels: [],
      children: [],
    },
  ],
  relationships: [],
  groups: [],
  annotations: [],
};

describe("diagram-reasoner package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/diagram-reasoner");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});

describe("composeDiagramAST", () => {
  /**
   * The AD-1 case. Under the docs' fixed pipeline this stage could not run
   * without a shape graph; here it composes from the sentence alone, which is
   * what makes "draw a circle" cost one model call instead of four.
   */
  it("composes from the request alone, with no earlier stage having run", async () => {
    const result = await composeDiagramAST({
      provider: fakeReturning(circle),
      request: "Draw a circle",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(SCHEMA_VERSION);
    expect(result.value.objects).toHaveLength(1);
  });

  it("sends only the stages that actually ran", async () => {
    const provider = fakeReturning(circle);
    await composeDiagramAST({ provider, request: "Draw a circle" });

    const sent = JSON.parse(provider.calls[0]?.messages[0]?.content ?? "{}");
    expect(sent.request).toBe("Draw a circle");
    expect(sent.plan).toBeUndefined();
    expect(sent.shapeGraph).toBeUndefined();
  });

  it("passes the intent through when one exists", async () => {
    const intent: IntentModel = {
      version: SCHEMA_VERSION,
      intent: "explain",
      subject: "movable pulley system",
      domain: "physics",
      category: "schematic",
      complexity: "moderate",
      teachingObjective: "Understand mechanical advantage.",
      rawRequest: "Draw a movable pulley",
    };
    const provider = fakeReturning(circle);
    await composeDiagramAST({ provider, request: "Draw a movable pulley", intent });

    const sent = JSON.parse(provider.calls[0]?.messages[0]?.content ?? "{}");
    expect(sent.intent.subject).toBe("movable pulley system");
  });

  /**
   * AD-2's repair path. Errors alone are a riddle; errors plus the text they
   * refer to are an instruction.
   */
  it("shows the model its failed attempt alongside the errors to fix", async () => {
    const provider = fakeReturning(circle);
    await composeDiagramAST({
      provider,
      request: "Draw a movable pulley",
      previousAttempt: { id: "broken" },
      previousErrors: [
        makeError({
          code: "AST_ORPHAN_OBJECT",
          message: "Object 'rope_2' has no relationship, parent, child, or group.",
          package: "@sketchmind/diagram-ast",
          stage: "diagram-ast",
          recoverable: true,
          path: "objects[3]",
        }),
      ],
    });

    const sent = JSON.parse(provider.calls[0]?.messages[0]?.content ?? "{}");
    expect(sent.previousAttempt).toEqual({ id: "broken" });
    expect(sent.previousErrors[0]).toContain("rope_2");
    expect(sent.previousErrors[0]).toContain("AST_ORPHAN_OBJECT");
  });

  it("returns diagram-ast's own semantic errors rather than a second opinion", async () => {
    const result = await composeDiagramAST({
      provider: fakeReturning({
        ...circle,
        relationships: [{ id: "r1", type: "connectedTo", from: "circle", to: "ghost" }],
      }),
      request: "Draw a circle",
      maxRepairAttempts: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("AST_UNKNOWN_REFERENCE");
    expect(result.errors[0]?.package).toBe("@sketchmind/diagram-ast");
  });
});

describe("DIAGRAM_AST_PROMPT", () => {
  it("forbids geometry and undeclared anchors", () => {
    const forbidden = DIAGRAM_AST_PROMPT.forbiddenOutput.join(" ");
    expect(forbidden).toMatch(/coordinate/i);
    expect(forbidden).toMatch(/anchor/i);
  });

  it("tells the model it may receive nothing but the request (AD-1)", () => {
    expect(DIAGRAM_AST_PROMPT.allowedInputs.join(" ")).toMatch(/if one was produced/i);
  });
});
