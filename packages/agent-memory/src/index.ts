/**
 * @sketchmind/agent-memory
 *
 * Session working memory and a persisted learned-primitive store with semantic
 * recall (AD-7). Two halves with different lifetimes that deliberately do not
 * share a store (D-9):
 *
 *  - `SessionMemory` -- what this run asked, drew and failed at. Lives for one
 *    session, discarded after.
 *  - `MemoryStore` (`InMemoryStore` / `FileStore`) -- learned primitives that
 *    outlive every session, written only through `learn`, exposed to a loop as
 *    `recall` / `learn` / `forget` via `createMemoryTools`.
 *
 * Depends on `@sketchmind/agent-core` for `defineTool`, not the reverse: the
 * loop knows nothing about memory, and a locus with no store still runs it.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */

export const PACKAGE_NAME = "@sketchmind/agent-memory";
export const PACKAGE_VERSION = "0.0.1";

export {
  SessionMemory,
  DEFAULT_MAX_NOTES,
  type SessionMemoryOptions,
} from "./session.js";

export {
  FileStore,
  InMemoryStore,
  type FileStoreOptions,
  type LearnInput,
  type MemoryStore,
  type RecallHit,
  type RecallOptions,
} from "./store.js";

export { createMemoryTools, type MemoryToolsOptions } from "./tools.js";

export {
  LexicalEmbedder,
  cosineSimilarity,
  type EmbeddingProvider,
  type LexicalEmbedderOptions,
} from "./internal/embedding.js";
