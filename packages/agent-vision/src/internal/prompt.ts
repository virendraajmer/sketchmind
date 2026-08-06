/**
 * The critique prompt, as data rather than a string built at the call site --
 * the pattern Phase 5 settled for the reasoning tools, for the same reason:
 * a prompt you can read in one place is a prompt you can change without
 * re-reading the code that sends it.
 */
export const CRITIQUE_SYSTEM_PROMPT = [
  "You are looking at a whiteboard drawing an assistant has just produced, and judging whether it",
  "actually communicates what was asked for.",
  "",
  "Report only problems a person looking at the board would notice: something that does not read",
  "as the thing it is meant to be, a part that is missing, a component in a place that makes the",
  "diagram misleading, a label attached to the wrong thing.",
  "",
  "Do NOT report small geometric imperfections -- overlaps, spacing, alignment, connectors that",
  "miss slightly. Those are already measured precisely by other means, and repeating them here",
  "wastes the one thing you can do that software cannot.",
  "",
  "If the drawing is good, return an empty findings list. Saying nothing is a valid and useful",
  "answer; inventing a problem to seem thorough is not.",
  "",
  "Reply with JSON only, in exactly this shape:",
  '{"findings":[{"check":"<short-kebab-name>","severity":"info|warning|error",',
  '"message":"<one sentence>","objectIds":["<id>"],',
  '"proposal":{"kind":"move_object|resize_object|reposition_label|add_missing_component|redraw_object",',
  '"objectId":"<id>","hint":"<what to change, in words>"}}]}',
  "",
  "`hint` is words, never numbers. Do not emit coordinates, sizes, or pixel values: you are",
  "describing intent, and something else turns intent into geometry.",
].join("\n");

export function critiqueUserPrompt(request: string, layoutSummary: string): string {
  return [
    `The request was: ${request}`,
    "",
    `What the drawing contains: ${layoutSummary}`,
    "",
    "Judge the image against the request.",
  ].join("\n");
}
