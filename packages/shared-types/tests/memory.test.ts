/**
 * Agent memory models (AD-7).
 *
 * These live here rather than in `agent-memory` for the usual reason: Phase 12's
 * `primitive-sdk` promotes a learned primitive to a registered one, and two
 * packages that each define "a learned primitive" would drift on the first edit.
 */
import { describe, expect, it } from "vitest";
import {
  LearnedPrimitiveSchema,
  MemoryNoteSchema,
  SessionMemorySnapshotSchema,
  SCHEMA_VERSION,
} from "../src/index.js";

const BASE = {
  version: SCHEMA_VERSION,
  id: "prim_nephron",
  name: "kidney nephron unit",
  description: "The filtering unit of a kidney: glomerulus, tubule, loop of Henle.",
  createdAt: "2026-08-05T10:00:00.000Z",
  updatedAt: "2026-08-05T10:00:00.000Z",
};

describe("LearnedPrimitive", () => {
  it("accepts the minimum a primitive needs to be recalled later", () => {
    const parsed = LearnedPrimitiveSchema.parse(BASE);
    expect(parsed.aliases).toEqual([]);
    expect(parsed.keywords).toEqual([]);
    expect(parsed.usageCount).toBe(0);
  });

  it("carries aliases and keywords, which are what make recall land", () => {
    const parsed = LearnedPrimitiveSchema.parse({
      ...BASE,
      aliases: ["nephron"],
      keywords: ["kidney", "renal", "filtration"],
      subject: "biology",
    });
    expect(parsed.aliases).toEqual(["nephron"]);
    expect(parsed.subject).toBe("biology");
  });

  it("may embed the freeform shape it learned, ready for Phase 12 promotion", () => {
    const parsed = LearnedPrimitiveSchema.parse({
      ...BASE,
      shape: {
        version: SCHEMA_VERSION,
        id: "shape_nephron",
        name: "nephron",
        parts: [{ id: "p1", kind: "curve", points: [{ u: 0, v: 0 }, { u: 1, v: 1 }] }],
      },
    });
    expect(parsed.shape?.parts).toHaveLength(1);
  });

  it("requires a description, because recall matches on meaning, not on an id", () => {
    expect(() => LearnedPrimitiveSchema.parse({ ...BASE, description: "" })).toThrow();
  });
});

describe("MemoryNote", () => {
  it("records what happened, with a kind the agent can filter on", () => {
    const note = MemoryNoteSchema.parse({
      kind: "drew",
      content: "Drew the fixed pulley at the ceiling.",
      timestamp: "2026-08-05T10:00:00.000Z",
    });
    expect(note.kind).toBe("drew");
  });

  it("rejects a kind outside the vocabulary", () => {
    expect(() =>
      MemoryNoteSchema.parse({ kind: "vibes", content: "…", timestamp: "2026-08-05T10:00:00.000Z" }),
    ).toThrow();
  });
});

describe("SessionMemorySnapshot", () => {
  it("is serializable, so Phase 9 can stream it to the browser", () => {
    const snapshot = SessionMemorySnapshotSchema.parse({
      sessionId: "session-1",
      request: "Draw a movable pulley.",
      notes: [],
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});
