/**
 * Recall (AD-7, Phase 4 D-8).
 *
 * The master plan's acceptance criterion is here: "nephron" must find a stored
 * "kidney nephron unit". The default embedder is lexical -- token and
 * character-trigram hashing -- which handles that case, plurals, misspellings
 * and word order, and cannot handle a pure synonym. That limit is asserted
 * rather than hidden, because a recall system whose failure mode is undocumented
 * is one nobody can decide to upgrade.
 */
import { describe, expect, it } from "vitest";
import { LexicalEmbedder, cosineSimilarity } from "../src/internal/embedding.js";

const embedder = new LexicalEmbedder();

async function similarity(a: string, b: string): Promise<number> {
  const [va, vb] = await embedder.embed([a, b]);
  return cosineSimilarity(va!, vb!);
}

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  it("is 0 rather than NaN for a zero vector", () => {
    // An empty description embeds to zeros. Returning NaN would poison every
    // sort that touched it.
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
  });

  it("returns 0 for mismatched dimensions instead of reading past the end", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe("LexicalEmbedder", () => {
  it("produces unit-length vectors of its declared dimension", async () => {
    const [vector] = await embedder.embed(["kidney nephron unit"]);
    expect(vector).toHaveLength(embedder.dimensions);
    const norm = Math.sqrt(vector!.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("is deterministic, which is what makes a persisted index reusable", async () => {
    const [a] = await embedder.embed(["kidney nephron unit"]);
    const [b] = await new LexicalEmbedder().embed(["kidney nephron unit"]);
    // A different process must produce the same vector, or every restart
    // invalidates the whole stored index.
    expect(a).toEqual(b);
  });

  it("embeds an empty string without dividing by zero", async () => {
    const [vector] = await embedder.embed([""]);
    expect(vector!.every((v) => v === 0)).toBe(true);
  });

  it("scores a shared term far above unrelated text (the AD-7 case)", async () => {
    const hit = await similarity("nephron", "kidney nephron unit");
    const miss = await similarity("nephron", "hydraulic press assembly");
    expect(hit).toBeGreaterThan(miss);
    expect(hit).toBeGreaterThan(0.2);
  });

  it("tolerates plurals and word order", async () => {
    // Not equal to the singular -- it is a different surface form -- but well
    // clear of the "unrelated text" band the nephron/press case sits in below.
    expect(await similarity("pulleys", "pulley")).toBeGreaterThan(0.35);
    expect(await similarity("movable pulley system", "system pulley movable")).toBeGreaterThan(0.9);
  });

  it("tolerates a misspelling, which trigrams buy and whole-token matching does not", async () => {
    expect(await similarity("nephrone", "nephron")).toBeGreaterThan(0.5);
  });

  it("is case- and punctuation-insensitive", async () => {
    expect(await similarity("Kidney Nephron, unit.", "kidney nephron unit")).toBeGreaterThan(0.95);
  });

  it("cannot match a pure synonym -- the documented limit of the lexical tier", async () => {
    // "renal filtration unit" shares no substring with "nephron". Upgrading to a
    // real embedding provider is a constructor argument, and this test is the
    // reason someone would decide to.
    const synonym = await similarity("nephron", "renal filtration unit");
    expect(synonym).toBeLessThan(0.2);
  });
});
