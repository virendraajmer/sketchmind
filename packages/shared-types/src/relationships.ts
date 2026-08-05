/**
 * The semantic relationship vocabulary, shared by VIL and the Diagram AST.
 *
 * Volume 04 lists 12 relationship types; Volume 13 lists 8 for VIL, two of which
 * (`contains`, `pointsTo`) are absent from Volume 04. Keeping two vocabularies
 * would force a lossy translation table on the VIL -> AST conversion, and every
 * lossy table eventually loses something that mattered. They are unified here
 * into 14.
 *
 * `contains` is kept alongside `inside` because they differ in direction, and
 * the agent reliably picks the one matching its sentence ("the cell contains a
 * nucleus" vs "the nucleus is inside the cell"). `pointsTo` is required for
 * arrows and callouts, which every annotated diagram needs.
 *
 * These describe **intent, never geometry** (Volume 04 §Relationships). The
 * mapping from relationship to spatial constraint happens in the constraint
 * engine, not here.
 */
import { z } from "zod";

export const RelationshipTypeSchema = z.enum([
  // Volume 04
  "connectedTo",
  "inside",
  "above",
  "below",
  "leftOf",
  "rightOf",
  "wraps",
  "attachedTo",
  "intersects",
  "parallelTo",
  "centeredOn",
  "alignedWith",
  // Volume 13
  "contains",
  "pointsTo",
]);
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

export const RelationshipSchema = z.object({
  id: z.string().min(1),
  type: RelationshipTypeSchema,
  /** Source object id. */
  from: z.string().min(1),
  /** Target object id. */
  to: z.string().min(1),
  label: z.string().optional(),
  /** Named anchor on `from`, e.g. a pulley's `rim` (Volume 04 §Anchors). */
  fromAnchor: z.string().optional(),
  toAnchor: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Relationship = z.infer<typeof RelationshipSchema>;
