/**
 * The memory tools: `recall` / `learn` / `forget` (D-10).
 *
 * These are `ToolDefinition`s from `agent-core`, so a loop plugs them in exactly
 * like any tool Phase 5 will add. `agent-memory` depends on `agent-core`, not
 * the reverse: the loop knows nothing about a primitive store, and a client
 * locus with no store at all still runs the identical loop.
 */
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@sketchmind/agent-core";
import { InMemoryStore } from "../src/store.js";
import { LexicalEmbedder } from "../src/internal/embedding.js";
import { createMemoryTools } from "../src/tools.js";

function context(): ToolContext {
  return {
    sessionId: "session-1",
    signal: new AbortController().signal,
    locus: "server",
    toolCallId: "call-1",
  };
}

describe("createMemoryTools", () => {
  it("returns recall, learn and forget as server-locus tools", () => {
    const tools = createMemoryTools({ store: new InMemoryStore(), embedder: new LexicalEmbedder() });
    expect(tools.map((t) => t.name).sort()).toEqual(["forget", "learn", "recall"]);
    expect(tools.every((t) => t.locus === "server")).toBe(true);
  });

  it("marks recall read-only and learn/forget as state-changing", () => {
    const tools = createMemoryTools({ store: new InMemoryStore(), embedder: new LexicalEmbedder() });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.recall!.readOnly).toBe(true);
    expect(byName.learn!.readOnly).toBe(false);
    expect(byName.forget!.readOnly).toBe(false);
  });

  it("learns a primitive and recalls it by a related query", async () => {
    const tools = createMemoryTools({ store: new InMemoryStore(), embedder: new LexicalEmbedder() });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    const learned = (await byName.learn!.handler(
      {
        name: "kidney nephron unit",
        description: "The filtering unit of a kidney.",
        aliases: ["nephron"],
        keywords: ["kidney", "renal"],
      },
      context(),
    )) as { id: string };
    expect(learned.id).toBeTruthy();

    const result = (await byName.recall!.handler({ query: "nephron", limit: 3 }, context())) as {
      ok: true;
      value: Array<{ primitive: { name: string } }>;
    };
    expect(result.ok).toBe(true);
    expect(result.value[0]?.primitive.name).toBe("kidney nephron unit");
  });

  it("reports empty recall as success, not as an error the agent must recover from", async () => {
    const tools = createMemoryTools({ store: new InMemoryStore(), embedder: new LexicalEmbedder() });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    const result = (await byName.recall!.handler({ query: "nephron", limit: 3 }, context())) as {
      ok: true;
      value: unknown[];
    };
    // Finding nothing is a normal outcome, not a validation failure (AD-2 is
    // about failures the agent can fix -- an empty result needs no fixing).
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("forgets a learned primitive", async () => {
    const store = new InMemoryStore();
    const tools = createMemoryTools({ store, embedder: new LexicalEmbedder() });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    const learned = (await byName.learn!.handler(
      { name: "movable pulley", description: "…", aliases: [], keywords: [] },
      context(),
    )) as { id: string };

    await byName.forget!.handler({ id: learned.id }, context());
    expect(await store.get(learned.id)).toBeUndefined();
  });
});
