/**
 * Session working memory (Phase 4, D-9).
 *
 * What this run has asked, drawn and failed at. It lives for one session and is
 * then discarded -- deliberately not the same store as learned primitives, so a
 * session's mistakes cannot become permanent knowledge.
 */
import { describe, expect, it } from "vitest";
import { SessionMemory } from "../src/session.js";

describe("SessionMemory", () => {
  it("remembers the request it was created for", () => {
    const memory = new SessionMemory({ sessionId: "s1", request: "Draw a movable pulley." });
    expect(memory.snapshot().request).toBe("Draw a movable pulley.");
    expect(memory.snapshot().notes).toEqual([]);
  });

  it("records notes in order, each with a kind and a timestamp", () => {
    const memory = new SessionMemory({ sessionId: "s1", request: "Draw a lever." });
    memory.note("planned", "Beam across a fulcrum.");
    memory.note("drew", "Drew the beam.");

    const { notes } = memory.snapshot();
    expect(notes.map((n) => n.kind)).toEqual(["planned", "drew"]);
    expect(notes[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("tracks what is on the board, so a follow-up turn does not redraw it", () => {
    const memory = new SessionMemory({ sessionId: "s1", request: "Draw a lever." });
    memory.recordDrawn("beam");
    memory.recordDrawn("fulcrum");
    memory.recordDrawn("beam");

    // A set, not a list: drawing the beam twice is one object on the board.
    expect(memory.snapshot().drawnObjectIds).toEqual(["beam", "fulcrum"]);
  });

  it("tracks which learned primitives it recalled, for the Phase 12 usage count", () => {
    const memory = new SessionMemory({ sessionId: "s1", request: "Draw a nephron." });
    memory.recordRecall("prim_nephron");
    expect(memory.snapshot().recalledPrimitiveIds).toEqual(["prim_nephron"]);
  });

  it("keeps failures, which are the most useful thing a session can tell itself", () => {
    const memory = new SessionMemory({ sessionId: "s1", request: "Draw a lever." });
    memory.note("failed", "compose_diagram_ast: orphan object 'rope_2'.");
    expect(memory.failures()).toHaveLength(1);
  });

  it("renders a compact prompt block the agent can actually read", () => {
    const memory = new SessionMemory({ sessionId: "s1", request: "Draw a lever." });
    memory.note("drew", "Drew the beam.");
    memory.note("failed", "Label overlapped the fulcrum.");

    const text = memory.toPromptText();
    expect(text).toContain("Draw a lever.");
    expect(text).toContain("Drew the beam.");
    expect(text).toContain("Label overlapped the fulcrum.");
  });

  it("bounds how much it will ever put in a prompt", () => {
    const memory = new SessionMemory({ sessionId: "s1", request: "Draw a lever.", maxNotes: 3 });
    for (let i = 0; i < 10; i += 1) memory.note("drew", `Step ${i}.`);

    // Unbounded session memory is a token budget that grows with the session
    // length -- the runs that need memory most are exactly the long ones.
    const { notes } = memory.snapshot();
    expect(notes).toHaveLength(3);
    expect(notes.map((n) => n.content)).toEqual(["Step 7.", "Step 8.", "Step 9."]);
  });

  it("round-trips through its snapshot, so a session can be checkpointed", () => {
    const memory = new SessionMemory({ sessionId: "s1", request: "Draw a lever." });
    memory.note("drew", "Drew the beam.");
    memory.recordDrawn("beam");

    const restored = SessionMemory.fromSnapshot(memory.snapshot());
    expect(restored.snapshot()).toEqual(memory.snapshot());
  });

  it("produces a snapshot that is plain data, not a live view", () => {
    const memory = new SessionMemory({ sessionId: "s1", request: "Draw a lever." });
    const before = memory.snapshot();
    memory.note("drew", "Drew the beam.");
    // A snapshot handed to the SSE stream must not change under the caller.
    expect(before.notes).toHaveLength(0);
  });
});
