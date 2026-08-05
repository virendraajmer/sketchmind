/**
 * The primitive catalogue, and the search that runs before generation (V10).
 *
 * V10's Shape Intelligence Engine is "look it up, and only invent what you could
 * not find". This file is the looking-up half, and it is deliberately **zero
 * tokens and deterministic**: the search that guards every generation must not
 * itself cost a model call, or the guard becomes more expensive than the thing
 * it is guarding.
 *
 * `PrimitiveCatalog` is an interface with one method because the interesting
 * backends are not in this layer. `agent-tools-reasoning` backs it with
 * `agent-memory`'s persisted store (AD-7); Phase 12's `primitive-sdk` will back
 * it with the registered-primitive registry. Neither may be imported from here
 * -- `shape-intelligence` sits below both -- and neither needs to be.
 */
import type { FreeformShape, ShapeGraph } from "@sketchmind/shared-types";

/**
 * One catalogue entry, whatever produced it.
 *
 * `shapeGraph` and `shape` are both optional and both may be absent: an entry
 * that only records "we have seen a nephron before, here is what it is" is still
 * worth returning, because it tells the agent it is not the first to ask.
 */
export interface PrimitiveRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly keywords?: readonly string[];
  readonly subject?: string;
  /** The structural decomposition, when one was stored. */
  readonly shapeGraph?: ShapeGraph;
  /** The geometry, when this was learned from a freeform composition (AD-5). */
  readonly shape?: FreeformShape;
}

export interface PrimitiveMatch {
  readonly record: PrimitiveRecord;
  /** 0..1. Comparable only within one catalogue implementation. */
  readonly score: number;
}

export interface SearchOptions {
  readonly limit?: number;
  /** Below this, an entry is noise rather than a match. */
  readonly minScore?: number;
}

export interface PrimitiveCatalog {
  search(query: string, options?: SearchOptions): Promise<PrimitiveMatch[]>;
}

export const DEFAULT_SEARCH_LIMIT = 5;
export const DEFAULT_MIN_SCORE = 0.25;

/**
 * The threshold at which a match is good enough to use *instead of* generating.
 *
 * Higher than `DEFAULT_MIN_SCORE` on purpose. Showing the agent a weak match
 * costs it one line of context; silently substituting a weak match for the shape
 * it asked for costs it the diagram.
 */
export const REUSE_SCORE = 0.6;

/** Lowercase alphanumeric words, 2 characters or more. `a`/`of` carry no signal. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "its", "it",
  "of", "in", "on", "to", "an", "as", "by", "or", "is", "are", "be", "draw",
  "show", "diagram", "picture", "sketch",
]);

function contentTokens(text: string): string[] {
  return tokenize(text).filter((token) => !STOP_WORDS.has(token));
}

/**
 * How well a record answers a query, 0..1.
 *
 * Weighted by field, because "nephron" appearing as an alias is a much stronger
 * signal than "nephron" appearing once in a paragraph of description -- and the
 * alias case is exactly the one AD-7 exists to serve ("nephron" must find
 * "kidney nephron unit").
 *
 * Deliberately lexical. A semantic tier belongs behind `MemoryStore`'s embedder,
 * where it is already implemented; duplicating it here would give the same
 * question two different answers depending on which door it came through.
 */
export function lexicalScore(query: string, record: PrimitiveRecord): number {
  const wanted = new Set(contentTokens(query));
  if (wanted.size === 0) return 0;

  const fields: Array<[readonly string[], number]> = [
    [[record.name], 1],
    [record.aliases ?? [], 0.9],
    [record.keywords ?? [], 0.6],
    [record.subject ? [record.subject] : [], 0.3],
    [[record.description], 0.4],
  ];

  // Best weight any field gives each query token, summed and normalised by how
  // many tokens the query had. A query fully covered by the name scores 1.
  let earned = 0;
  for (const token of wanted) {
    let best = 0;
    for (const [values, weight] of fields) {
      if (weight <= best) continue;
      const present = values.some((value) => tokenize(value).includes(token));
      if (present) best = weight;
    }
    earned += best;
  }

  const coverage = earned / wanted.size;
  // An exact name match should beat a description that happens to use every
  // word. Without this, "pulley" ranks a paragraph mentioning pulleys above the
  // entry literally called "pulley".
  const exact = tokenize(record.name).join(" ") === contentTokens(query).join(" ") ? 0.15 : 0;
  return Math.min(1, coverage + exact);
}

/**
 * An in-process catalogue. The default when no store is wired up, and the one
 * every unit test uses -- it makes "search before generate" testable without a
 * database or a model.
 */
export class InMemoryPrimitiveCatalog implements PrimitiveCatalog {
  private readonly records: PrimitiveRecord[];

  constructor(records: readonly PrimitiveRecord[] = []) {
    this.records = [...records];
  }

  add(record: PrimitiveRecord): this {
    this.records.push(record);
    return this;
  }

  get size(): number {
    return this.records.length;
  }

  async search(query: string, options: SearchOptions = {}): Promise<PrimitiveMatch[]> {
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

    return this.records
      .map((record) => ({ record, score: lexicalScore(query, record) }))
      .filter((match) => match.score >= minScore)
      // Ties broken by name so the ordering is stable across runs, not by
      // insertion order, which depends on how the store happened to load.
      .sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name))
      .slice(0, limit);
  }
}

/** A catalogue that knows nothing. Every search returns nothing, and says so. */
export const EMPTY_CATALOG: PrimitiveCatalog = new InMemoryPrimitiveCatalog();
