import { describe, it, expect } from "vitest";
import { InMemoryPrimitiveCatalog, lexicalScore, tokenize, type PrimitiveRecord } from "../src/index.js";

const nephron: PrimitiveRecord = {
  id: "p1",
  name: "kidney nephron unit",
  description: "The filtering unit of the kidney, with a glomerulus and a tubule.",
  aliases: ["nephron"],
  keywords: ["kidney", "filtration"],
  subject: "biology",
};

const pulley: PrimitiveRecord = {
  id: "p2",
  name: "pulley",
  description: "A grooved wheel on an axle that redirects a rope.",
  keywords: ["mechanical", "rope"],
  subject: "physics",
};

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, and drops one-character noise", () => {
    expect(tokenize("Kidney-Nephron (a Unit)")).toEqual(["kidney", "nephron", "unit"]);
  });
});

describe("lexicalScore", () => {
  /**
   * AD-7's stated case: "nephron" must find the entry stored as "kidney nephron
   * unit", or the system relearns the same thing forever.
   */
  it("matches an alias as strongly as a name", () => {
    expect(lexicalScore("nephron", nephron)).toBeGreaterThanOrEqual(0.9);
  });

  it("scores an unrelated query at zero", () => {
    expect(lexicalScore("photosynthesis", pulley)).toBe(0);
  });

  it("ignores the words every drawing request contains", () => {
    // "draw a diagram of the" carries no signal; only "pulley" should count.
    expect(lexicalScore("draw a diagram of the pulley", pulley)).toBeGreaterThan(0.9);
  });

  it("ranks an exact name above a description that merely mentions the word", () => {
    const mentions: PrimitiveRecord = {
      id: "p3",
      name: "block and tackle",
      description: "An assembly of pulley wheels and rope used to lift heavy loads.",
    };
    expect(lexicalScore("pulley", pulley)).toBeGreaterThan(lexicalScore("pulley", mentions));
  });

  it("returns zero for a query that is all stop words", () => {
    expect(lexicalScore("draw the", pulley)).toBe(0);
  });
});

describe("InMemoryPrimitiveCatalog", () => {
  const catalog = new InMemoryPrimitiveCatalog([nephron, pulley]);

  it("returns matches ranked by score", async () => {
    const matches = await catalog.search("nephron");
    expect(matches[0]?.record.id).toBe("p1");
  });

  it("returns nothing rather than noise when nothing is close enough", async () => {
    expect(await catalog.search("photosynthesis")).toEqual([]);
  });

  it("honours limit", async () => {
    const wide = new InMemoryPrimitiveCatalog([nephron, pulley]);
    expect(await wide.search("kidney pulley", { limit: 1, minScore: 0 })).toHaveLength(1);
  });

  /** Determinism matters: the same query must rank the same way every run. */
  it("breaks ties by name, not by insertion order", async () => {
    const a: PrimitiveRecord = { id: "a", name: "zebra", description: "A striped horse." };
    const b: PrimitiveRecord = { id: "b", name: "antelope", description: "A striped horse." };

    const forward = await new InMemoryPrimitiveCatalog([a, b]).search("striped horse");
    const backward = await new InMemoryPrimitiveCatalog([b, a]).search("striped horse");

    expect(forward.map((match) => match.record.id)).toEqual(backward.map((match) => match.record.id));
  });

  it("makes no model call -- there is no provider to give it", async () => {
    // Structural, not behavioural: the class takes records and nothing else.
    expect(new InMemoryPrimitiveCatalog().size).toBe(0);
  });
});
