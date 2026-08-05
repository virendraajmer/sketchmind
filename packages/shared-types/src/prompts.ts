/**
 * The Standard Prompt Template (Volume 15 §Standard Prompt Template).
 *
 * V15 requires every prompt to define six sections: System Instructions, Agent
 * Objective, Allowed Inputs, Expected Output, Forbidden Output, Completion
 * Rules. This models that requirement as data so the rule is checkable rather
 * than a convention someone remembers -- a prompt missing `forbiddenOutput` does
 * not parse.
 *
 * It lives in `shared-types` because all four Phase 5 reasoning packages author
 * prompts, and two copies of "what a prompt is" would drift on the first edit
 * (Global Constraints: shared models live only here).
 *
 * `version` is an integer, not the repo's `SCHEMA_VERSION`. A prompt is versioned
 * on its own clock: rewording the intent prompt is a change worth tracking and
 * has nothing to do with whether `IntentModel`'s shape changed.
 *
 * ## Why forbiddenOutput is required, not optional
 *
 * The one thing every SketchMind prompt must say is "no coordinates, no SVG, no
 * canvas commands" (Global Constraints: AI boundaries). Making the field
 * mandatory means a prompt that forgets to say it cannot be constructed.
 */
import { z } from "zod";

/**
 * A few-shot example. `output` is a JSON string rather than a parsed object so
 * examples can be shown to the model verbatim, including the formatting it
 * should imitate.
 */
export const PromptExampleSchema = z.object({
  /** The input as the model will see it. */
  input: z.string().min(1),
  /** The response it should produce, as literal JSON text. */
  output: z.string().min(1),
  /** Why this example is here. Rendered as a comment, never sent as content. */
  note: z.string().optional(),
});
export type PromptExample = z.infer<typeof PromptExampleSchema>;

export const PromptTemplateSchema = z.object({
  /** Stable identifier, e.g. `intent-analyzer`. */
  id: z.string().min(1),
  /** Bumped whenever the text changes in a way that could change behaviour. */
  version: z.number().int().positive(),
  systemInstructions: z.string().min(1),
  objective: z.string().min(1),
  allowedInputs: z.array(z.string().min(1)).min(1),
  expectedOutput: z.string().min(1),
  /** At least one entry: every prompt must forbid geometry. */
  forbiddenOutput: z.array(z.string().min(1)).min(1),
  completionRules: z.array(z.string().min(1)).min(1),
  examples: z.array(PromptExampleSchema).default([]),
});
export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

/** Construct a template, failing loudly at module load if a section is missing. */
export function definePrompt(template: z.input<typeof PromptTemplateSchema>): PromptTemplate {
  return PromptTemplateSchema.parse(template);
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * Render a template into the system string a provider receives.
 *
 * Section headings are kept literal and in V15's order. Models follow a prompt
 * with visible structure more reliably than one written as a paragraph, and a
 * fixed order means two prompts differing only in wording produce diffs that are
 * about the wording.
 */
export function renderPromptTemplate(template: PromptTemplate): string {
  const sections = [
    template.systemInstructions.trim(),
    `# Objective\n${template.objective.trim()}`,
    `# Allowed Inputs\n${bullets(template.allowedInputs)}`,
    `# Expected Output\n${template.expectedOutput.trim()}`,
    `# Forbidden Output\n${bullets(template.forbiddenOutput)}`,
    `# Completion Rules\n${bullets(template.completionRules)}`,
  ];

  if (template.examples.length > 0) {
    const rendered = template.examples
      .map((example, index) => {
        const heading = `## Example ${index + 1}${example.note ? ` -- ${example.note}` : ""}`;
        return `${heading}\nInput:\n${example.input.trim()}\nOutput:\n${example.output.trim()}`;
      })
      .join("\n\n");
    sections.push(`# Examples\n${rendered}`);
  }

  return sections.join("\n\n");
}
