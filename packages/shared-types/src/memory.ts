/**
 * Agent memory models (AD-7).
 *
 * V10 describes primitives being "learned and stored" and leaves it there. AD-7
 * makes it real, and the model that makes it real is this one: a learned
 * primitive has to be findable by a query that does not use its name, or the
 * system relearns the same nephron forever.
 *
 * Hence `aliases` and `keywords` alongside `description` -- they are not
 * decoration, they are the recall surface. `LexicalEmbedder` in `agent-memory`
 * indexes exactly these fields.
 *
 * These live here rather than in `agent-memory` because Phase 12's
 * `primitive-sdk` promotes a learned primitive into a registered one, and two
 * packages that each defined "a learned primitive" would drift on the first edit.
 */
import { z } from "zod";
import { MetadataSchema, SchemaVersionSchema } from "./primitives.js";
import { FreeformShapeSchema } from "./freeform.js";

export const LearnedPrimitiveSchema = z.object({
  version: SchemaVersionSchema,
  id: z.string().min(1),
  /** The canonical name, as the agent would say it: "kidney nephron unit". */
  name: z.string().min(1),
  /**
   * What it is and when to use it. Required, because recall matches on meaning:
   * an entry with no description is one only its own id can ever find.
   */
  description: z.string().min(1),
  /** Domain, e.g. `biology`. Narrows recall when the agent knows the field. */
  subject: z.string().optional(),
  /** Other names for the same thing. "nephron" for "kidney nephron unit". */
  aliases: z.array(z.string().min(1)).default([]),
  keywords: z.array(z.string().min(1)).default([]),
  /** The geometry, when this was learned from a freeform composition (AD-5). */
  shape: FreeformShapeSchema.optional(),
  /** How often it has been recalled. Phase 12 promotes on reuse. */
  usageCount: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  metadata: MetadataSchema.optional(),
});
export type LearnedPrimitive = z.infer<typeof LearnedPrimitiveSchema>;

/**
 * One thing worth remembering within a session.
 *
 * `failed` is in the vocabulary on purpose: what did not work is the most useful
 * thing a session can tell its own later steps, and AD-2 makes failures common
 * rather than exceptional.
 */
export const MemoryNoteKindSchema = z.enum([
  "asked",
  "planned",
  "drew",
  "failed",
  "corrected",
  "recalled",
  "learned",
]);
export type MemoryNoteKind = z.infer<typeof MemoryNoteKindSchema>;

export const MemoryNoteSchema = z.object({
  kind: MemoryNoteKindSchema,
  content: z.string().min(1),
  timestamp: z.string(),
  metadata: MetadataSchema.optional(),
});
export type MemoryNote = z.infer<typeof MemoryNoteSchema>;

/**
 * The session's working memory, as data.
 *
 * Serializable so Phase 9 can stream it and Phase 12 can checkpoint it. Kept
 * separate from the learned-primitive store on purpose (D-9): conflating them is
 * how one session's mistakes become permanent knowledge.
 */
export const SessionMemorySnapshotSchema = z.object({
  sessionId: z.string().min(1),
  /** What the user actually asked, in their words. */
  request: z.string(),
  notes: z.array(MemoryNoteSchema).default([]),
  /** Ids of objects drawn so far, so a follow-up turn knows what is on the board. */
  drawnObjectIds: z.array(z.string().min(1)).default([]),
  /** Ids of learned primitives recalled during this session. */
  recalledPrimitiveIds: z.array(z.string().min(1)).default([]),
  metadata: MetadataSchema.optional(),
});
export type SessionMemorySnapshot = z.infer<typeof SessionMemorySnapshotSchema>;
