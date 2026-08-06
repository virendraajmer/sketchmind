/**
 * Critique findings (AD-3, Phase 10).
 *
 * One shape for both tiers. The geometric tier is deterministic code reading
 * models the pipeline already built; the visual tier is a model reading pixels.
 * They disagree about everything except what a finding looks like, which is why
 * the repair path never has to ask which one spoke.
 *
 * `hint` is prose and never a coordinate. A proposal describes intent -- "attach
 * it to the groove" -- and the solver remains the only thing that turns intent
 * into numbers. `.strict()` on every proposal variant is what stops a model
 * quietly attaching an `x` and a `y`.
 */
import { z } from "zod";
import { SchemaVersionSchema } from "./primitives.js";

export const CritiqueTierSchema = z.enum(["geometric", "visual"]);
export type CritiqueTier = z.infer<typeof CritiqueTierSchema>;

export const CritiqueSeveritySchema = z.enum(["info", "warning", "error"]);
export type CritiqueSeverity = z.infer<typeof CritiqueSeveritySchema>;

export const FixProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move_object"), objectId: z.string().min(1), hint: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("resize_object"), objectId: z.string().min(1), hint: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("reposition_label"), labelId: z.string().min(1), hint: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("add_missing_component"), description: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("redraw_object"), objectId: z.string().min(1), hint: z.string().min(1) }).strict(),
]);
export type FixProposal = z.infer<typeof FixProposalSchema>;

export const CritiqueFindingSchema = z.object({
  id: z.string().min(1),
  tier: CritiqueTierSchema,
  /** Stable check name, e.g. `anchor-miss`. Groups findings across rounds. */
  check: z.string().min(1),
  severity: CritiqueSeveritySchema,
  /** Plain language, addressed to the agent that will act on it. */
  message: z.string().min(1),
  objectIds: z.array(z.string().min(1)).default([]),
  proposal: FixProposalSchema.optional(),
});
export type CritiqueFinding = z.infer<typeof CritiqueFindingSchema>;

export const CritiqueReportSchema = z.object({
  version: SchemaVersionSchema,
  tier: CritiqueTierSchema,
  findings: z.array(CritiqueFindingSchema),
});
export type CritiqueReport = z.infer<typeof CritiqueReportSchema>;

/**
 * The comparison the round cap depends on. Findings are already sorted by
 * `critiqueGeometry`, so identity is a plain structural compare over the fields
 * that describe the problem -- ids are regenerated per round and would make
 * every round look new.
 */
export function findingsEqual(
  a: readonly CritiqueFinding[],
  b: readonly CritiqueFinding[],
): boolean {
  if (a.length !== b.length) return false;
  const key = (f: CritiqueFinding): string =>
    `${f.tier}|${f.check}|${f.severity}|${f.objectIds.join(",")}`;
  return a.every((finding, index) => key(finding) === key(b[index] as CritiqueFinding));
}
