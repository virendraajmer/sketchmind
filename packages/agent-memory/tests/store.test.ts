/**
 * The learned-primitive store (AD-7, D-9).
 *
 * Two backends behind one interface: `InMemoryStore` for tests and ephemeral
 * runs, `FileStore` for a real persisted install. Both are exercised by the same
 * assertions, parameterised, for the reason Phase 3's provider contract suite
 * exists: "it behaves the same against both" is true by construction only when
 * there is one copy of the test body.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LexicalEmbedder } from "../src/internal/embedding.js";
import { FileStore, InMemoryStore, type MemoryStore } from "../src/store.js";

const NEPHRON = {
  name: "kidney nephron unit",
  description: "The filtering unit of a kidney: glomerulus, tubule, loop of Henle.",
  aliases: ["nephron"],
  keywords: ["kidney", "renal", "filtration"],
  subject: "biology",
};

const PULLEY = {
  name: "movable pulley",
  description: "A pulley attached to the load rather than a fixed point.",
  aliases: [],
  keywords: ["mechanical", "physics"],
  subject: "physics",
};

function withBackends(make: () => MemoryStore, cleanup?: () => void) {
  describe.each([{ name: "backend" }])("$name", () => {
    let store: MemoryStore;
    let embedder: LexicalEmbedder;

    beforeEach(() => {
      store = make();
      embedder = new LexicalEmbedder();
    });
    if (cleanup) afterEach(cleanup);

    it("learns a primitive and returns it by id", async () => {
      const learned = await store.learn(NEPHRON, embedder);
      expect(learned.id).toBeTruthy();
      const found = await store.get(learned.id);
      expect(found?.name).toBe("kidney nephron unit");
    });

    it("recalls by a differently-worded query -- the AD-7 acceptance case", async () => {
      await store.learn(NEPHRON, embedder);
      await store.learn(PULLEY, embedder);

      const results = await store.recall("nephron", embedder, { limit: 3 });

      expect(results[0]?.primitive.name).toBe("kidney nephron unit");
      expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    });

    it("returns nothing above the threshold when nothing matches", async () => {
      await store.learn(PULLEY, embedder);
      const results = await store.recall("nephron", embedder, { limit: 3, minScore: 0.5 });
      expect(results).toEqual([]);
    });

    it("increments usage count on every recall that returns it", async () => {
      const learned = await store.learn(NEPHRON, embedder);
      expect(learned.usageCount).toBe(0);

      await store.recall("nephron", embedder, { limit: 1 });
      const after = await store.get(learned.id);
      expect(after?.usageCount).toBe(1);
    });

    it("forgets by id", async () => {
      const learned = await store.learn(NEPHRON, embedder);
      await store.forget(learned.id);
      expect(await store.get(learned.id)).toBeUndefined();
      expect(await store.recall("nephron", embedder, { limit: 5 })).toEqual([]);
    });

    it("lists everything learned so far", async () => {
      await store.learn(NEPHRON, embedder);
      await store.learn(PULLEY, embedder);
      const all = await store.list();
      expect(all.map((p) => p.name).sort()).toEqual(["kidney nephron unit", "movable pulley"]);
    });
  });
}

describe("InMemoryStore", () => {
  withBackends(() => new InMemoryStore());
});

describe("FileStore", () => {
  let dir: string;
  withBackends(
    () => {
      dir = mkdtempSync(join(tmpdir(), "sketchmind-agent-memory-"));
      return new FileStore({ path: join(dir, "primitives.json") });
    },
    () => rmSync(dir, { recursive: true, force: true }),
  );

  it("round-trips a learned primitive across a fresh instance over the same path", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sketchmind-agent-memory-")), "primitives.json");
    const embedder = new LexicalEmbedder();

    const first = new FileStore({ path });
    const learned = await first.learn(NEPHRON, embedder);

    // A different instance, same file: this is what "process restart" means.
    const second = new FileStore({ path });
    const found = await second.get(learned.id);
    expect(found?.name).toBe("kidney nephron unit");

    const results = await second.recall("nephron", embedder, { limit: 1 });
    expect(results[0]?.primitive.id).toBe(learned.id);
  });

  it("starts empty when the file does not exist yet, rather than throwing", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sketchmind-agent-memory-")), "missing.json");
    const store = new FileStore({ path });
    expect(await store.list()).toEqual([]);
  });
});
