/**
 * `agent-memory`'s learned-primitive store, seen as a `PrimitiveCatalog` (AD-7).
 *
 * `shape-intelligence` cannot import `agent-memory` -- it sits below it, and
 * should not know that a persistent store exists. It declares the one-method
 * interface it needs instead. This file is where the two meet, and it is the
 * only place in Phase 5 that knows both names.
 *
 * The payoff is the second half of AD-7: "draw a nephron" searches the store the
 * agent wrote last week, gets back the "kidney nephron unit" it learned then, and
 * skips generation entirely.
 */
import type { EmbeddingProvider, MemoryStore } from "@sketchmind/agent-memory";
import type { PrimitiveCatalog, PrimitiveMatch, SearchOptions } from "@sketchmind/shape-intelligence";
import { ShapeGraphSchema, type ShapeGraph } from "@sketchmind/shared-types";

/**
 * A learned primitive may have been stored with its structural decomposition in
 * `metadata.shapeGraph` (that is where `learn` puts it -- `LearnedPrimitive.shape`
 * holds freeform geometry, not a graph). Anything unparseable is ignored rather
 * than thrown: a corrupt entry from an older schema should degrade recall, not
 * break it.
 */
function shapeGraphOf(metadata: Record<string, unknown> | undefined): ShapeGraph | undefined {
  if (metadata === undefined) return undefined;
  const parsed = ShapeGraphSchema.safeParse(metadata["shapeGraph"]);
  return parsed.success ? parsed.data : undefined;
}

export function memoryCatalog(store: MemoryStore, embedder: EmbeddingProvider): PrimitiveCatalog {
  return {
    async search(query: string, options: SearchOptions = {}): Promise<PrimitiveMatch[]> {
      const hits = await store.recall(query, embedder, {
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.minScore === undefined ? {} : { minScore: options.minScore }),
      });

      return hits.map((hit) => {
        const graph = shapeGraphOf(hit.primitive.metadata);
        return {
          score: hit.score,
          record: {
            id: hit.primitive.id,
            name: hit.primitive.name,
            description: hit.primitive.description,
            aliases: hit.primitive.aliases,
            keywords: hit.primitive.keywords,
            ...(hit.primitive.subject === undefined ? {} : { subject: hit.primitive.subject }),
            ...(hit.primitive.shape === undefined ? {} : { shape: hit.primitive.shape }),
            ...(graph === undefined ? {} : { shapeGraph: graph }),
          },
        };
      });
    },
  };
}
