import { describe, it, expect } from "vitest";
import { PromptTemplateSchema, definePrompt, renderPromptTemplate } from "../src/index.js";

const minimal = {
  id: "test-prompt",
  version: 1,
  systemInstructions: "You are a test.",
  objective: "Do the test thing.",
  allowedInputs: ["A string."],
  expectedOutput: "A JSON object.",
  forbiddenOutput: ["Any coordinate."],
  completionRules: ["Answer with JSON only."],
};

describe("PromptTemplate", () => {
  it("accepts a template carrying all six V15 sections", () => {
    const template = definePrompt(minimal);
    expect(template.id).toBe("test-prompt");
    expect(template.examples).toEqual([]);
  });

  /**
   * The point of modelling the template rather than writing prose: V15's six
   * sections become a parse error rather than a review comment.
   */
  it.each([
    "systemInstructions",
    "objective",
    "allowedInputs",
    "expectedOutput",
    "forbiddenOutput",
    "completionRules",
  ])("rejects a template missing %s", (field) => {
    const { [field]: _dropped, ...rest } = minimal as Record<string, unknown>;
    expect(PromptTemplateSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an empty forbiddenOutput -- every prompt must forbid geometry", () => {
    expect(PromptTemplateSchema.safeParse({ ...minimal, forbiddenOutput: [] }).success).toBe(false);
  });
});

describe("renderPromptTemplate", () => {
  it("renders the six sections in V15's order", () => {
    const rendered = renderPromptTemplate(definePrompt(minimal));
    const order = ["# Objective", "# Allowed Inputs", "# Expected Output", "# Forbidden Output", "# Completion Rules"];
    const positions = order.map((heading) => rendered.indexOf(heading));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(rendered.startsWith("You are a test.")).toBe(true);
  });

  it("omits the examples section entirely when there are none", () => {
    expect(renderPromptTemplate(definePrompt(minimal))).not.toContain("# Examples");
  });

  it("renders examples with their input and output, and the note as a heading", () => {
    const rendered = renderPromptTemplate(
      definePrompt({
        ...minimal,
        examples: [{ input: "draw a circle", output: '{"ok":true}', note: "the simple case" }],
      }),
    );

    expect(rendered).toContain("## Example 1 -- the simple case");
    expect(rendered).toContain("draw a circle");
    expect(rendered).toContain('{"ok":true}');
  });

  it("is deterministic -- the same template renders byte-identically", () => {
    const template = definePrompt(minimal);
    expect(renderPromptTemplate(template)).toBe(renderPromptTemplate(template));
  });
});
