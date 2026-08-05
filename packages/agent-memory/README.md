# @sketchmind/agent-memory

Session working memory and a persisted learned-primitive store with semantic
recall (AD-7). Makes V10's "primitives are learned and stored" real: without
this, "draw a nephron" would never match a stored "kidney nephron unit" and the
system relearns forever.

## Two halves, two lifetimes (D-9)

- **`SessionMemory`** — what this run asked, drew, recalled and failed at.
  Lives for one session, discarded after. Written freely; `note()`,
  `recordDrawn()`, `recordRecall()`.
- **`MemoryStore`** (`InMemoryStore` / `FileStore`) — learned primitives that
  outlive every session. Written only through `learn()`, exposed to a loop as
  three tools via `createMemoryTools()`.

They deliberately do not share a store. Conflating them is how one session's
mistakes become permanent knowledge; the store's narrow write path is what
keeps "remembered forever" a decision, not an accident.

## Recall: lexical by default, semantic behind an interface (D-8)

`LexicalEmbedder` hashes whole tokens and character trigrams into a fixed
vector and ranks by cosine similarity. Zero tokens, no network, deterministic
across process restarts (a persisted index has to hash the same text the same
way every time, or a restart invalidates it). It handles the case AD-7 actually
names — "nephron" finding "kidney nephron unit" — plus plurals, misspellings,
and word order.

It cannot match a pure synonym: "nephron" and "renal filtration unit" share no
substring, and no similarity score bridges that. This is a real, tested limit,
not a hidden one — see `tests/embedding.test.ts`. Swapping in a real embedding
endpoint is a constructor argument: implement `EmbeddingProvider` (`embed`,
`dimensions`) and pass it wherever a `LexicalEmbedder` is passed today.
Deliberately not added: `embed()` on `LLMProvider` itself — no phase before 12
needs it, and widening a provider interface for one consumer is how
abstractions rot.

## The memory tools

`createMemoryTools({ store, embedder })` returns three `ToolDefinition`s from
`@sketchmind/agent-core`:

| Tool | Locus | Read-only | |
|---|---|---|---|
| `recall` | server | yes | Empty results are `ok: true, value: []` — finding nothing needs no fixing (AD-2 is about failures the agent can act on). |
| `learn` | server | no | Only for something proven worth reusing, not scratch work. |
| `forget` | server | no | Removes a primitive learned incorrectly. |

## Persistence

`FileStore` writes a JSON file holding both primitives and their vectors, so a
fresh process over the same path recalls without re-embedding at startup.
Writes go through a temp file plus rename, so a crash mid-write cannot corrupt
the store.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

Depends on `@sketchmind/agent-core` (for `defineTool`) and
`@sketchmind/shared-types`, not the reverse — the loop knows nothing about
memory, and a locus with no store still runs it. Direction is enforced by
`scripts/check-layering.mjs`; run `pnpm run check:layering`.
