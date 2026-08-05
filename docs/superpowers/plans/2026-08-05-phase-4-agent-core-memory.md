# Phase 4 — Agent Core & Memory

**Branch:** `phase-4`
**Packages:** `agent-core`, `agent-memory` (plus an amendment to `llm-provider`)
**Deliverable:** a working agent loop — tools, budgets, cancellation, tracing, and persistent memory
with semantic recall — that runs identically against the fake provider and a real one (AD-1, AD-2,
AD-4, AD-7, AD-8).

This is the spine. Phases 5–12 add tools to it and never modify it.

---

## What Phase 3 left unfinished, discovered here

`llm-provider`'s `Message` is `{ role: "user" | "assistant", content: string }`. That is enough to
*ask* a model to call a tool — `completeWithTools` returns `ToolCall[]` — but there is no way to send
the **result** back. An agent loop is exactly the thing that needs to.

Two options:

1. **Encode results as text** in a synthetic user message: `"Tool search_primitives returned: {...}"`.
   Costs no interface change. But Anthropic's API *rejects* an assistant turn containing `tool_use`
   that is not followed by matching `tool_result` blocks, so a multi-step loop would fail against a
   real Anthropic provider while passing every test against the fake. It also destroys prompt
   caching, since each turn rewrites history rather than appending to it.
2. **Model tool results in the interface.** Both targets express this natively — Azure Responses uses
   `function_call` / `function_call_output` input items keyed by `call_id`; Anthropic uses `tool_use`
   and `tool_result` content blocks keyed by `id`.

D-2 of Phase 3 gave the test for whether something belongs in the interface: *can both Azure and
Anthropic express it?* Tool results pass that test unambiguously. So option 2, and Phase 3's
`types.ts` is amended rather than worked around.

This is the phased approach doing its job — the gap was invisible until something actually ran a
loop.

---

## Design decisions

### D-1. `Message` becomes a discriminated union that can carry a tool round trip

```ts
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: readonly ToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string; isError?: boolean };
```

The existing two-arm shape is a strict subset, so every Phase 3 call site and test still compiles.
Adapters translate: Azure emits a `function_call` item per `toolCalls` entry plus a
`function_call_output` per tool message; Anthropic emits `tool_use` blocks and `tool_result` blocks.
`isError` is carried because both providers have a first-class notion of a failed tool result, and
AD-2 makes failed results the interesting case rather than the exceptional one.

`content` on a tool message is a **string**, always. The agent serializes whatever the handler
returned to JSON before it gets here. Keeping it a string means the interface does not have to model
every provider's content-block vocabulary to say "here is what came back".

### D-2. `ToolDefinition = ToolSpec & { argsSchema, handler }` — the split Phase 2 predicted

`shared-types` owns `ToolSpec` (serializable: name, description, JSON Schema parameters, locus,
readOnly). `agent-core` owns the executable half. Registration takes a **Zod** schema and derives
the JSON Schema, so there is exactly one definition of a tool's arguments:

```ts
registry.register({
  name: "recall",
  description: "...",
  locus: "server",
  readOnly: true,
  argsSchema: z.object({ query: z.string() }),
  handler: async ({ query }, ctx) => ({ ... }),
});
```

The handler receives **parsed, typed** arguments. Type inference flows from `argsSchema` to the
handler parameter, so a handler that reads `args.querry` does not compile.

### D-3. Nothing in the loop throws on account of the model or a tool (AD-2)

This is the decision the whole phase turns on. Four failure classes, one treatment:

| What failed | Treatment |
|---|---|
| Model asked for a tool that does not exist | Observation: "no such tool; available: …" |
| Model's arguments fail Zod validation | Observation: every Zod error, with paths |
| Handler threw | Observation: `SketchMindError` with `recoverable: true` |
| Handler returned a `ValidationResult` that is `ok: false` | Observation: the structured errors verbatim |

All four become `role: "tool"` messages with `isError: true` and go back to the model, which gets
another step to fix them. The run continues. Only two things end a run early: budget exhaustion and
cancellation — plus a genuinely fatal provider error (auth, deployment-not-found), which is the one
case Phase 3 already classified as non-recoverable.

`SketchMindError.recoverable` is what distinguishes them, and it is already on every error the repo
produces. This phase consumes that field rather than inventing a parallel notion.

### D-4. Budgets are a deadline and two counters, checked at step boundaries

```ts
interface BudgetState { steps: number; tokensIn: number; tokensOut: number; deadline: number; }
```

Wall-clock is an **absolute deadline** computed once at start, not a `setTimeout`. A timer that fires
mid-`await` cannot stop the in-flight request, leaks a handle, and is untestable without faking
timers; a deadline compared at each boundary is none of those things, and it composes with the
`AbortSignal` that actually cancels the HTTP request.

Exhaustion is not an error. `runAgent` resolves with `{ status: "budget-exhausted", reason, trace,
output }` and whatever partial result exists. AD-8 says budgets bound cost and liveness — a budget
that throws away the work done so far bounds cost by destroying value.

### D-5. Cancellation is one `AbortSignal`, composed, honored within one step

The caller's signal, the deadline, and an internal controller compose into one signal handed to the
provider (which Phase 3 already threads to the transport) and to every tool handler via
`ToolContext`. A cancelled run stops at the next step boundary at the latest, and immediately if the
in-flight provider call honors abort — which both SDKs do.

In-flight tool handlers get the signal, so a well-written tool stops too. A handler that ignores it
is awaited to completion but its result is discarded; the alternative — abandoning the promise — is
how you leak file handles.

### D-6. Tracing is a push, not a poll

Every step appends an `AgentTraceStep` and invokes an optional `onStep` callback synchronously. That
callback is the entire integration surface Phase 9's SSE stream needs: `onStep: (step) => sse.send(step)`.
No event emitter, no subscription lifecycle, no buffering policy in this package — those are
transport concerns and belong in `session-protocol`.

The trace records the thought, tool name, parsed args, result, error, per-step token counts, duration,
and timestamp. Every field of `AgentTraceStep` gets populated, because a trace with holes in it is
how an autonomous agent becomes unauditable.

### D-7. Parallel tool calls are executed in parallel only when the provider allows it

`capabilities.parallelToolCalls` gates it. When true and the model returns several calls, they run
via `Promise.all` and each produces its own trace step and its own tool message. When false, the
request sets `allowParallelCalls: false` and any calls that still arrive run sequentially. Callers
branch on the capability flag, never on the provider id — the standing constraint.

Read-only tools (`readOnly: true`) are safe to run concurrently by definition. State-changing tools
are *not* reordered relative to each other within a batch when running sequentially.

### D-8. `agent-memory` recall is pluggable, and ships with a zero-cost default

The master plan's open item was "embedding model for `agent-memory` recall". The answer follows the
same two-tier shape as AD-3's critique tiers:

| Tier | Mechanism | Cost | Default |
|---|---|---|---|
| **Lexical** | Token + character-trigram hashing into a fixed vector, cosine similarity | Zero tokens, offline, deterministic | **On** |
| **Semantic** | A real embedding endpoint behind `EmbeddingProvider` | Tokens + latency + a second deployment | Off |

`EmbeddingProvider` is a two-method interface (`embed(texts)`, `dimensions`) defined in
`agent-memory`. The default `LexicalEmbedder` implements it with no dependencies and no network.

Note what the lexical tier actually buys: the acceptance criterion — "nephron" recalls a stored
"kidney nephron unit" — is a *lexical overlap* case, and trigram hashing handles it, along with
plurals, misspellings, and word order. What it cannot do is match "nephron" to "renal filtration
unit", which shares no substring. That is a real limit, stated plainly rather than papered over, and
it is why the interface exists: swapping in a real embedder is a constructor argument.

Deliberately **not** done: adding `embed()` to `LLMProvider`. No phase before 12 needs it, Azure
embeddings are a separate deployment with separate config, and widening a provider interface for one
consumer is how abstractions rot.

### D-9. Memory has two halves with different lifetimes, and they do not share a store

- **`SessionMemory`** — what this run has asked, drawn, and failed at. Lives for one session, in
  process, discarded after. Read into the prompt each step.
- **`PrimitiveStore`** — learned primitives that outlive every session. Persisted, semantically
  indexed, written only by `learn`.

Conflating them is how a session's mistakes become permanent knowledge. The store is written through
one narrow door (`learn`) so that what gets remembered forever is always a deliberate act.

Backends: `InMemoryStore` (tests, ephemeral) and `FileStore` (a JSON file plus its vectors) behind a
`MemoryStore` interface. Phase 12 swaps in a vector DB by implementing three methods.

### D-10. `agent-memory` depends on `agent-core`, not the reverse

Both are in the `agent` layer, so a sideways dependency is legal. The direction matters: `agent-core`
is a runtime that knows nothing about memory, and `agent-memory` exposes `createMemoryTools()`
returning `ToolDefinition[]` to plug into it. A loop that hardcoded a memory store would be
untestable without one and unusable for Phase 11's client locus, which has no primitive store at all.

---

## Task breakdown

TDD throughout: test first, watch it fail, implement, watch it pass.

| # | Task | Files |
|---|---|---|
| 0 | `Message` union + tool round trip; both adapters; contract test | `llm-provider/src/types.ts`, both adapters' `translate.ts` |
| 1 | `ToolDefinition`, `ToolRegistry`, Zod→JSON Schema derivation, locus filtering | `agent-core/src/tools.ts` |
| 2 | Tool execution: arg validation, handler invocation, failure-as-observation | `agent-core/src/internal/execute.ts` |
| 3 | `BudgetTracker` + signal composition | `agent-core/src/internal/budget.ts` |
| 4 | `runAgent` — the loop — plus trace assembly and `onStep` | `agent-core/src/loop.ts` |
| 5 | `SessionMemory` | `agent-memory/src/session.ts` |
| 6 | `EmbeddingProvider`, `LexicalEmbedder`, cosine recall | `agent-memory/src/internal/embedding.ts` |
| 7 | `MemoryStore` (in-memory + file), `LearnedPrimitive`, `createMemoryTools()` | `agent-memory/src/{store,tools}.ts` |
| 8 | READMEs, master-plan update, full gate | — |

All nine tasks complete. See Outcome below.

---

## Acceptance criteria

- [x] A toy agent with 2 fake tools completes a multi-step goal and emits a full trace with every
      `AgentTraceStep` field populated. — `agent-core/tests/loop.test.ts`.
- [x] A tool that throws produces an observation the agent recovers from — the run reaches
      `status: "completed"`, and the trace shows the error step followed by a successful retry (AD-2).
- [x] A tool call naming a nonexistent tool, and one with schema-invalid arguments, are both
      observations rather than crashes. — `agent-core/tests/execute.test.ts`, `loop.test.ts`.
- [x] Exceeding each of the step, token, and time budgets terminates cleanly with a partial result
      and a distinct `stopReason` — three separate tests, never a hang (a fourth test races the
      runaway case against a 2s timeout).
- [x] Cancellation mid-run stops within one step boundary, propagates the signal to in-flight tool
      handlers, and returns the partial trace.
- [x] `recall("nephron")` returns a stored "kidney nephron unit" ahead of unrelated entries (AD-7). —
      `agent-memory/tests/{embedding,store}.test.ts`; the lexical tier's synonym limit ("renal
      filtration unit" does not match) is asserted alongside it, not hidden.
- [x] `FileStore` round-trips a learned primitive across process restart (a fresh instance over the
      same path). — `agent-memory/tests/store.test.ts`.
- [x] The loop runs identically against `FakeProvider` and against a real adapter over a stubbed
      transport — one test body, two providers, per Phase 3's D-8 pattern. — extended to *three*
      providers (fake, Azure, Anthropic) in `tests/agent-loop-providers.test.ts` at the repo root,
      the first use of the root `tests/` workspace Volume 11 called for.
- [x] A provider with `parallelToolCalls: false` never receives a parallel batch, and the loop still
      completes the same goal. — `agent-core/tests/loop.test.ts`; a companion test asserts the branch
      is on the capability flag, not the provider id.
- [x] `agent-core` imports no concrete provider package (lint + layering enforced). — layering script
      passes at 30 packages; the one place a concrete adapter meets an agent package is the root
      `tests/` suite, which the layering script does not gate (it only reads `packages/` and `apps/`)
      and which itself is barred from importing a provider SDK by the standing lint rule.
- [x] Full gate green: layering → lint → typecheck → build → test.

---

## Outcome

All nine tasks landed on `phase-4`, TDD throughout. Final state:

- **`llm-provider`** amendment — `Message` is now `UserMessage | AssistantMessage |
  ToolResultMessage`. The two-arm shape Phase 3 used is a strict subset, so every existing call site
  kept compiling. Two new contract-suite cases (`describeProviderContract`) hold every provider,
  present and future, to accepting a full call-and-result history and to treating a failed tool
  result as data rather than an exception. 147 tests passing (was 135).
- **Both adapters' `translate.ts`** gained the round trip, and the two turned out to differ sharply:
  Azure flattens calls and outputs into sibling `function_call` / `function_call_output` items;
  Anthropic nests `tool_use` inside its assistant turn and *requires* every result from one parallel
  batch to land in a single user turn, rejecting anything else outright. Neither rule escaped its
  adapter. Found and fixed in the same pass: `AzureOpenAIProvider` was returning `text: undefined`
  (not `""`) whenever a response carried no text output — legal per the Responses API for a
  tool-calls-only turn, invisible until `runAgent` tried to replay that value as history and crashed
  one step later. `llm-provider-azure-openai` 68 tests passing (was 59) · `llm-provider-anthropic` 56
  (was 49).
- **`agent-core`** — `tools.ts` (`defineTool`, `ToolRegistry`), `internal/execute.ts`
  (`executeToolCall`, the AD-2 enforcement point), `internal/budget.ts` (`BudgetTracker`,
  `composeRunSignal`), `loop.ts` (`runAgent`). 54 tests passing across 5 files, covering every
  Phase 4 acceptance criterion for the loop itself.
- **`agent-memory`** — `session.ts` (`SessionMemory`), `internal/embedding.ts` (`LexicalEmbedder`,
  `cosineSimilarity`), `store.ts` (`InMemoryStore`, `FileStore`), `tools.ts` (`createMemoryTools`).
  40 tests passing across 5 files. `shared-types` gained `LearnedPrimitive` / `MemoryNote` /
  `SessionMemorySnapshot` (`src/memory.ts`) — living there rather than in `agent-memory` because
  Phase 12's `primitive-sdk` promotes a learned primitive to a registered one, and two packages each
  defining "a learned primitive" would drift on the first edit.
- **Root `tests/` workspace** — did not exist as a working package before this phase (only a
  placeholder README). Added `package.json`, `tsconfig.json`, and joined it to
  `pnpm-workspace.yaml` / `vitest.workspace.ts`, satisfying V11's "root `tests/` holds contract and
  system tests" for the first time. `tests/agent-loop-providers.test.ts` runs one `runAgent` script
  against `FakeProvider` and both real adapters over stubbed transports — the strongest form of the
  D-8 pattern yet, since it is the one place a concrete provider and an agent package meet at all.
  It deliberately avoids importing `openai` or `@anthropic-ai/sdk` as *types* (using `as never` for
  the stub client) so the LLM-independence lint rule holds even here, though the layering script
  itself does not scan `tests/`.
- **Not committed.** Per standing instruction, the user reviews and checks in.

Not done in this phase, intentionally out of scope: wiring `recall`/`learn`/`forget` or the memory
tools into a live `runAgent` call by default (Phase 5 decides which tools a given reasoning task
gets); a semantic `EmbeddingProvider` backed by a real endpoint (the interface exists; nothing before
Phase 12 needs an implementation of it); checkpoint/resume for `SessionMemory` beyond the
snapshot/restore round trip already in place (full checkpointing is Phase 12).
