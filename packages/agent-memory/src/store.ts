/**
 * The learned-primitive store (AD-7, D-9).
 *
 * This is what makes V10's "primitives are learned and stored" real rather than
 * aspirational: a persisted, semantically searchable index, written only through
 * `learn`. That narrow door is deliberate -- it is what keeps "remembered
 * forever" a decision the agent makes on purpose, distinct from `SessionMemory`,
 * which is written freely and discarded at the end of the run.
 *
 * Two backends, one interface. Phase 12 swaps in a vector DB by implementing
 * these same three methods against it.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  LearnedPrimitiveSchema,
  type LearnedPrimitive,
} from "@sketchmind/shared-types";
import { cosineSimilarity, type EmbeddingProvider } from "./internal/embedding.js";

/** What `learn` needs; the rest (`id`, timestamps, `usageCount`) is assigned. */
export type LearnInput = Pick<
  LearnedPrimitive,
  "name" | "description" | "subject" | "aliases" | "keywords" | "shape" | "metadata"
>;

export interface RecallOptions {
  readonly limit?: number;
  /** Below this cosine score, an entry is noise, not a match. */
  readonly minScore?: number;
}

export interface RecallHit {
  readonly primitive: LearnedPrimitive;
  readonly score: number;
}

/** The text actually indexed: name, aliases and keywords carry more recall
 * weight than they get from appearing once in a longer description. */
function indexText(primitive: Pick<LearnInput, "name" | "description" | "aliases" | "keywords">): string {
  return [primitive.name, primitive.name, ...(primitive.aliases ?? []), ...(primitive.keywords ?? []), primitive.description].join(
    " ",
  );
}

export interface MemoryStore {
  learn(input: LearnInput, embedder: EmbeddingProvider): Promise<LearnedPrimitive>;
  get(id: string): Promise<LearnedPrimitive | undefined>;
  forget(id: string): Promise<void>;
  list(): Promise<readonly LearnedPrimitive[]>;
  /** Ranked by cosine similarity between `query` and each entry's index text. */
  recall(query: string, embedder: EmbeddingProvider, options?: RecallOptions): Promise<RecallHit[]>;
}

interface Entry {
  primitive: LearnedPrimitive;
  vector: number[];
}

/**
 * Shared ranking and bookkeeping over an in-process `Map`. Both backends build
 * on this rather than duplicating the recall math -- `FileStore` differs only in
 * when it persists.
 */
abstract class MapBackedStore implements MemoryStore {
  protected readonly entries = new Map<string, Entry>();

  async learn(input: LearnInput, embedder: EmbeddingProvider): Promise<LearnedPrimitive> {
    const now = new Date().toISOString();
    const primitive = LearnedPrimitiveSchema.parse({
      version: "1.0",
      id: randomUUID(),
      name: input.name,
      description: input.description,
      subject: input.subject,
      aliases: input.aliases ?? [],
      keywords: input.keywords ?? [],
      shape: input.shape,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    });
    const [vector] = await embedder.embed([indexText(primitive)]);
    this.entries.set(primitive.id, { primitive, vector: vector! });
    await this.persist();
    return primitive;
  }

  async get(id: string): Promise<LearnedPrimitive | undefined> {
    return this.entries.get(id)?.primitive;
  }

  async forget(id: string): Promise<void> {
    this.entries.delete(id);
    await this.persist();
  }

  async list(): Promise<readonly LearnedPrimitive[]> {
    return [...this.entries.values()].map((entry) => entry.primitive);
  }

  async recall(
    query: string,
    embedder: EmbeddingProvider,
    options: RecallOptions = {},
  ): Promise<RecallHit[]> {
    const limit = options.limit ?? 5;
    const minScore = options.minScore ?? 0.1;
    const [queryVector] = await embedder.embed([query]);

    const ranked = [...this.entries.values()]
      .map((entry) => ({ primitive: entry.primitive, score: cosineSimilarity(queryVector!, entry.vector) }))
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Recall is the moment a primitive proves useful -- Phase 12 promotes on
    // reuse, and this is the counter that decision reads.
    for (const hit of ranked) {
      const entry = this.entries.get(hit.primitive.id)!;
      entry.primitive = { ...entry.primitive, usageCount: entry.primitive.usageCount + 1 };
    }
    if (ranked.length > 0) await this.persist();

    return ranked.map((hit) => ({
      primitive: this.entries.get(hit.primitive.id)!.primitive,
      score: hit.score,
    }));
  }

  /** No-op for the in-memory backend; `FileStore` overrides it. */
  protected async persist(): Promise<void> {
    // Intentionally empty.
  }
}

/** Ephemeral, in-process. Tests and any run with no persisted install. */
export class InMemoryStore extends MapBackedStore {}

export interface FileStoreOptions {
  readonly path: string;
}

interface FileShape {
  readonly entries: Array<{ primitive: LearnedPrimitive; vector: number[] }>;
}

/**
 * A JSON file holding both the primitives and their vectors, so a fresh process
 * over the same path recalls without re-embedding everything at startup.
 *
 * Persistence is synchronous-ish from the caller's point of view -- `learn`,
 * `forget` and a scoring `recall` all await the write before returning -- so a
 * crash right after either call cannot lose the primitive it just reported
 * success for.
 */
export class FileStore extends MapBackedStore {
  private readonly path: string;
  private loaded: Promise<void> | undefined;

  constructor(options: FileStoreOptions) {
    super();
    this.path = options.path;
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= this.load();
    return this.loaded;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    const parsed = JSON.parse(raw) as FileShape;
    for (const entry of parsed.entries) {
      this.entries.set(entry.primitive.id, {
        primitive: LearnedPrimitiveSchema.parse(entry.primitive),
        vector: entry.vector,
      });
    }
  }

  protected override async persist(): Promise<void> {
    const shape: FileShape = {
      entries: [...this.entries.values()].map((entry) => ({
        primitive: entry.primitive,
        vector: entry.vector,
      })),
    };
    await mkdir(dirname(this.path), { recursive: true });
    // Write-then-rename: a crash mid-write leaves the old file intact rather
    // than a half-written JSON document that fails every future load.
    const tmpPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(shape, null, 2), "utf8");
    await rename(tmpPath, this.path);
  }

  override async learn(input: LearnInput, embedder: EmbeddingProvider): Promise<LearnedPrimitive> {
    await this.ensureLoaded();
    return super.learn(input, embedder);
  }

  override async get(id: string): Promise<LearnedPrimitive | undefined> {
    await this.ensureLoaded();
    return super.get(id);
  }

  override async forget(id: string): Promise<void> {
    await this.ensureLoaded();
    return super.forget(id);
  }

  override async list(): Promise<readonly LearnedPrimitive[]> {
    await this.ensureLoaded();
    return super.list();
  }

  override async recall(
    query: string,
    embedder: EmbeddingProvider,
    options: RecallOptions = {},
  ): Promise<RecallHit[]> {
    await this.ensureLoaded();
    return super.recall(query, embedder, options);
  }
}
