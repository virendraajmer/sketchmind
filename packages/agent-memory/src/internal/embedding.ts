/**
 * Recall vectors (AD-7, D-8).
 *
 * The master plan left "embedding model for `agent-memory` recall" open. The
 * answer takes the same two-tier shape as AD-3's critique tiers: a free,
 * offline, deterministic default, and a real embedding endpoint behind an
 * interface for when it earns its cost.
 *
 * The default is **lexical**: whole tokens plus character trigrams, hashed into
 * a fixed vector. That is enough for the case AD-7 actually names -- "nephron"
 * finding a stored "kidney nephron unit" -- and it also survives plurals,
 * misspellings and word order.
 *
 * What it cannot do is match "nephron" to "renal filtration unit", which shares
 * no substring. That limit is real, is asserted in the tests, and is the reason
 * `EmbeddingProvider` exists: swapping in a semantic embedder is a constructor
 * argument, not a rewrite.
 *
 * Deliberately not done: adding `embed()` to `LLMProvider`. Nothing before Phase
 * 12 needs it, Azure embeddings are a separate deployment with separate config,
 * and widening a provider interface for one consumer is how abstractions rot.
 */

/**
 * The seam a real embedding backend plugs into.
 *
 * Two members on purpose. Anything more would be modelling one vendor's API and
 * would have to be renegotiated for the next.
 */
export interface EmbeddingProvider {
  readonly dimensions: number;
  /** Batched, because every real endpoint charges per request, not per text. */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/**
 * Cosine similarity, guarded at both edges.
 *
 * A zero vector (an entry with no indexable text) would otherwise produce NaN,
 * and one NaN poisons every comparison in the sort that follows.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const DEFAULT_DIMENSIONS = 512;

/** Lowercase, strip punctuation, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * FNV-1a. Chosen for being tiny, dependency-free and *stable across processes* --
 * a persisted index is worthless if a restart hashes the same token differently,
 * which rules out anything seeded at startup.
 */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

export interface LexicalEmbedderOptions {
  readonly dimensions?: number;
  /** Trigrams are what buy misspelling tolerance; 3 is the usual sweet spot. */
  readonly gramSize?: number;
  /**
   * Weight of whole-token features relative to character n-grams. Tokens carry
   * more meaning; n-grams carry more forgiveness. Both matter, tokens slightly
   * more, which is what this ratio says.
   */
  readonly tokenWeight?: number;
}

export class LexicalEmbedder implements EmbeddingProvider {
  readonly dimensions: number;

  private readonly gramSize: number;
  private readonly tokenWeight: number;

  constructor(options: LexicalEmbedderOptions = {}) {
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.gramSize = options.gramSize ?? 3;
    this.tokenWeight = options.tokenWeight ?? 2;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const normalized = normalize(text);
    if (normalized.length === 0) return vector;

    const add = (feature: string, weight: number): void => {
      const index = hash(feature) % this.dimensions;
      vector[index] = vector[index]! + weight;
    };

    for (const token of normalized.split(" ")) {
      if (token.length === 0) continue;
      add(`t:${token}`, this.tokenWeight);

      // Pad so a token shorter than the window still contributes n-grams, and so
      // the start and end of a word are themselves features -- that is what
      // makes "pulleys" land near "pulley".
      const padded = ` ${token} `;
      for (let i = 0; i + this.gramSize <= padded.length; i += 1) {
        add(`g:${padded.slice(i, i + this.gramSize)}`, 1);
      }
    }

    // Unit length, so cosine similarity is a plain dot product and long
    // descriptions do not outrank short ones purely by having more words.
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm === 0) return vector;
    return vector.map((value) => value / norm);
  }
}
