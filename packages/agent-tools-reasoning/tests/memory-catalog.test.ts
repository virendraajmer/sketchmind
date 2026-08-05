import { describe, it, expect } from "vitest";
import { InMemoryStore, LexicalEmbedder } from "@sketchmind/agent-memory";
import { SCHEMA_VERSION } from "@sketchmind/shared-types";
import { memoryCatalog } from "../src/index.js";

const graph = {
  version: SCHEMA_VERSION,
  id: "nephron",
  root: "nephron",
  nodes: [
    { id: "nephron", kind: "object", type: "nephron", category: "biology", role: "subject", anchors: [], behaviors: [] },
  ],
  edges: [],
};

async function seeded() {
  const store = new InMemoryStore();
  const embedder = new LexicalEmbedder();

  await store.learn(
    {
      name: "kidney nephron unit",
      description: "The filtering unit of the kidney.",
      subject: "biology",
      aliases: ["nephron"],
      keywords: ["kidney", "filtration"],
      metadata: { shapeGraph: graph },
    },
    embedder,
  );

  return memoryCatalog(store, embedder);
}

describe("memoryCatalog", () => {
  /**
   * AD-7's stated case, end to end through the bridge: a query that uses none of
   * the stored name's words still finds it, because the store indexes aliases.
   */
  it("finds a learned primitive by an alias the caller used instead of its name", async () => {
    const matches = await (await seeded()).search("nephron");

    expect(matches[0]?.record.name).toBe("kidney nephron unit");
    expect(matches[0]?.score).toBeGreaterThan(0);
  });

  it("carries the stored shape graph through, so it can be reused not regenerated", async () => {
    const matches = await (await seeded()).search("nephron");
    expect(matches[0]?.record.shapeGraph?.root).toBe("nephron");
  });

  it("ignores a stored graph that no longer parses rather than failing the search", async () => {
    const store = new InMemoryStore();
    const embedder = new LexicalEmbedder();
    await store.learn(
      { name: "old entry", description: "Learned under an older schema.", aliases: [], keywords: [], metadata: { shapeGraph: { nope: true } } },
      embedder,
    );

    const matches = await memoryCatalog(store, embedder).search("old entry");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.record.shapeGraph).toBeUndefined();
  });

  it("returns nothing, not an error, when the store is empty", async () => {
    const catalog = memoryCatalog(new InMemoryStore(), new LexicalEmbedder());
    expect(await catalog.search("nephron")).toEqual([]);
  });
});
