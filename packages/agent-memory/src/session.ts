/**
 * Session working memory (D-9).
 *
 * What this run has asked, drawn, recalled and failed at. It lives for one
 * session and is then discarded.
 *
 * Kept strictly apart from the learned-primitive store, which outlives every
 * session. Conflating the two is how one run's mistakes become permanent
 * knowledge: everything here is written freely by the loop, whereas the store is
 * written only through `learn`, so what gets remembered forever stays a
 * deliberate act.
 */
import {
  MemoryNoteSchema,
  SessionMemorySnapshotSchema,
  type MemoryNote,
  type MemoryNoteKind,
  type Metadata,
  type SessionMemorySnapshot,
} from "@sketchmind/shared-types";

/**
 * How many notes ever reach a prompt.
 *
 * Unbounded session memory is a token budget that grows with session length --
 * and the runs that need memory most are exactly the long ones, so "it only
 * matters for big sessions" is backwards.
 */
export const DEFAULT_MAX_NOTES = 50;

export interface SessionMemoryOptions {
  readonly sessionId: string;
  readonly request: string;
  readonly maxNotes?: number;
  readonly metadata?: Metadata;
  readonly now?: () => Date;
}

export class SessionMemory {
  readonly sessionId: string;
  readonly request: string;

  private readonly maxNotes: number;
  private readonly metadata: Metadata | undefined;
  private readonly now: () => Date;
  private readonly notes: MemoryNote[] = [];
  private readonly drawn = new Set<string>();
  private readonly recalled = new Set<string>();

  constructor(options: SessionMemoryOptions) {
    this.sessionId = options.sessionId;
    this.request = options.request;
    this.maxNotes = options.maxNotes ?? DEFAULT_MAX_NOTES;
    this.metadata = options.metadata;
    this.now = options.now ?? (() => new Date());
  }

  note(kind: MemoryNoteKind, content: string, metadata?: Metadata): this {
    this.notes.push(
      MemoryNoteSchema.parse({
        kind,
        content,
        timestamp: this.now().toISOString(),
        ...(metadata ? { metadata } : {}),
      }),
    );
    // Oldest first: the recent past is what the next step needs.
    if (this.notes.length > this.maxNotes) this.notes.splice(0, this.notes.length - this.maxNotes);
    return this;
  }

  /** A set, not a list: drawing the beam twice is one object on the board. */
  recordDrawn(objectId: string): this {
    this.drawn.add(objectId);
    return this;
  }

  recordRecall(primitiveId: string): this {
    this.recalled.add(primitiveId);
    return this;
  }

  failures(): readonly MemoryNote[] {
    return this.notes.filter((note) => note.kind === "failed");
  }

  /** Plain data, copied. What goes to the SSE stream or a checkpoint. */
  snapshot(): SessionMemorySnapshot {
    return {
      sessionId: this.sessionId,
      request: this.request,
      notes: this.notes.map((note) => ({ ...note })),
      drawnObjectIds: [...this.drawn],
      recalledPrimitiveIds: [...this.recalled],
      ...(this.metadata ? { metadata: this.metadata } : {}),
    };
  }

  static fromSnapshot(
    snapshot: SessionMemorySnapshot,
    options: { maxNotes?: number; now?: () => Date } = {},
  ): SessionMemory {
    const parsed = SessionMemorySnapshotSchema.parse(snapshot);
    const memory = new SessionMemory({
      sessionId: parsed.sessionId,
      request: parsed.request,
      ...(options.maxNotes === undefined ? {} : { maxNotes: options.maxNotes }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
    });
    memory.notes.push(...parsed.notes.map((note) => ({ ...note })));
    for (const id of parsed.drawnObjectIds) memory.drawn.add(id);
    for (const id of parsed.recalledPrimitiveIds) memory.recalled.add(id);
    return memory;
  }

  /**
   * The block that goes into the system prompt.
   *
   * Grouped by kind rather than strictly chronological: "what is already on the
   * board" and "what has already failed" are the two questions the next step
   * actually asks, and a flat timeline makes the model reconstruct both.
   */
  toPromptText(): string {
    const lines: string[] = [`The user asked: ${this.request}`];

    if (this.drawn.size > 0) {
      lines.push(`Already drawn: ${[...this.drawn].join(", ")}.`);
    }
    if (this.recalled.size > 0) {
      lines.push(`Recalled primitives: ${[...this.recalled].join(", ")}.`);
    }

    const failures = this.failures();
    if (failures.length > 0) {
      lines.push("Problems encountered so far (do not repeat these):");
      for (const note of failures) lines.push(`  - ${note.content}`);
    }

    const progress = this.notes.filter((note) => note.kind !== "failed");
    if (progress.length > 0) {
      lines.push("Progress so far:");
      for (const note of progress) lines.push(`  - [${note.kind}] ${note.content}`);
    }

    return lines.join("\n");
  }
}
