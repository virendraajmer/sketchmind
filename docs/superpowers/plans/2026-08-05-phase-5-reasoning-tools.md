# Phase 5 — Reasoning Tools

**Branch:** `phase-4` (continues the Phase 4 line)
**Packages:** `intent-analyzer`, `visual-planner`, `shape-intelligence`, `diagram-reasoner`,
`agent-tools-reasoning` (plus amendments to `shared-types`, `llm-provider`, and the layering script)
**Deliverable:** natural language → validated `DiagramAST`, with the agent choosing how much
reasoning to apply (AD-1, AD-2, AD-5).

Phase 4 built the spine. This phase is the first set of tools hung off it, and it did not modify
`agent-core` — which was the claim Phase 4 made and this is the first phase in a position to check.

---

## What earlier phases left unfinished, discovered here

### The layer graph had `tools` on the wrong side of `agent`

`scripts/check-layering.mjs` ordered the layers `app → orchestrator → agent → tools → core`, so a
package in `tools` depending on one in `agent` was an upward dependency and a CI failure.

But every tool package needs `defineTool` from `agent-core` — `agent-memory` already does exactly
that, and got away with it only because it happens to sit *in* the agent layer. Meanwhile
`agent-core` deliberately imports no tool package; Phase 4's own words were "Phases 5–12 add tools
to it and never modify it".

So the real import direction is `tools → agent`, and the plan's "Applications → Agent → Tools →
Core" chain describes **call flow**, not imports. Placing tools below agent would have left three
options, all bad: duplicate the tool-definition format, split `agent-core` in two, or have tool
packages export loose functions that someone else wraps.

**Change:** `tools` moves above `agent` in `LAYERS`, with the reasoning recorded in the file. No
package's dependencies changed to accommodate this; the check now describes what the code does.

### `completeStructured` throws, and four stages wanted it not to

`LLMProvider.completeStructured` raises `LLMProviderError`. That is right for the interface — a
provider that cannot answer is a transport failure. But every reasoning stage wants the AD-2
framing: "the model produced something that did not validate" is an observation the agent fixes.

Four packages each writing the same try/catch would be four chances to classify it differently.
`requestStructured` (in `llm-provider`, D-1 below) does it once.

---

## Design decisions

### D-1. `requestStructured` splits provider failure from model failure, once

```ts
requestStructured(provider, request, origin): Promise<StructuredOutcome<T>>
```

- `error.recoverable === true` → `ValidationResult` failure, re-attributed to the calling stage.
  The provider's own code, message and details survive; `details.providerPackage` records where it
  actually came from, because that is the first thing anyone debugging asks.
- `recoverable === false` → rethrown. Bad credentials, a missing deployment, a schema no provider
  can express. Swallowing those into a tool result would make a misconfigured server look like a
  confused model, and the agent would burn its whole step budget "fixing" it.

It lives in `llm-provider` because it is part of "everything that must behave identically no matter
which model is behind it", and it imports no SDK.

### D-2. Prompts are versioned data, and V15's six sections are a parse error when missing

`PromptTemplate` in `shared-types` models V15's Standard Prompt Template: system instructions,
objective, allowed inputs, expected output, forbidden output, completion rules, plus few-shot
examples. `definePrompt()` parses at module load, so a prompt missing a section fails at import
rather than at review.

`forbiddenOutput` is **required with at least one entry**. The one thing every SketchMind prompt
must say is "no coordinates, no SVG, no canvas commands"; making the field mandatory means a prompt
that forgets cannot be constructed.

It lives in `shared-types` because all four reasoning packages author prompts and two definitions of
"what a prompt is" would drift on the first edit. `version` is a plain integer on its own clock —
rewording the intent prompt has nothing to do with whether `IntentModel`'s shape changed.

Each prompt is a module under its package's `src/internal/prompt.ts`: changing how the model is
asked is a reviewable diff touching no logic, and Phase 9's inspector can display the exact prompt a
run used.

### D-3. The model is asked for a *draft*, never for fields we already hold

Every stage asks for `<Model>Schema.omit({ version: true, ... })` and fills the rest in:

| Withheld | Why |
|---|---|
| `version` | An agent should not need to know a schema version to describe a pulley. Letting it guess produces models claiming versions that never existed. |
| `rawRequest` | Asking the model to echo a string we hold is paying tokens to invite a paraphrase of the one field whose whole value is being verbatim. |
| `metadata` | Caller context. Attached to the result, never sent. |

Deriving the draft with `.omit()` rather than hand-writing it means the two cannot drift.

Consequence worth stating: `toStrictJsonSchema` drops optional open-ended maps, so the model cannot
emit `parameters` or `properties` bags through structured output at all. That is a real narrowing of
V14's parametric shapes, and it is the right trade for now — those bags are also the one place
geometry can hide (see D-6).

### D-4. Every stage exports its validator separately from its generator

`validateVisualPlan`, `validateShapeGraph`, `validateDiagramAST` are public alongside `planVisual`,
`buildShapeGraph`, `composeDiagramAST`. Under AD-1 the agent may hand-compose an artifact for a
trivial request rather than spend a model call on it, and a hand-composed artifact has to be held to
exactly the same standard as a generated one.

All of them report **every** problem at once. An agent that gets one error per round trip burns a
round trip per mistake.

New semantic checks this phase adds:

- **Plan:** dangling label/highlight/animation/focus targets, duplicate ids, partial focus order.
- **Shape graph:** unknown root, unknown edge endpoints, self-edges, containment cycles, orphan
  nodes, duplicate anchors.

The containment cycle check is worth its own line: a graph claiming a wheel is inside its own hub
validates perfectly against the schema and is unsolvable by every layout strategy Phase 6 will have.

### D-5. `focusOrder`: filled when empty, rejected when partial

An empty draw order is filled deterministically by importance, ties keeping declaration order. The
model declining to order six objects is not a mistake it needs to see.

A partial order is rejected. It is a claim that contradicts the object list, and silently completing
it would discard what the model actually intended for the objects it did name. Determinism matters
here even though AD-6 only guarantees it from the AST down — a stage that reordered itself run to
run would make the AST non-reproducible for no reason.

### D-6. The geometry boundary gets a runtime half

`shared-types/tests/geometry-purity.test.ts` proves the *schemas* carry no geometry. That is a static
guarantee about shapes we declared, and it is not enough: every semantic model has an open
`metadata` / `properties` / `parameters` bag, and a model that stashes `{ x: 40, y: 120 }` in one
passes every schema in the repo.

`agent-tools-reasoning` checks every successful tool result for banned property names before the
model sees it. Violations are **rejected whole, not stripped** — silently removing the field teaches
the model nothing and leaves the run holding an artifact that differs from what the model believes
it produced. `AI_EMITTED_GEOMETRY` is recoverable; the model removes the field next step.

`FreeformShape` is checked against a narrower list that permits `points`, because its points are
`{ u, v }` proportions inside the shape's own 0..1 box (AD-5) rather than places on the board. `svg`,
`path` and `transform` stay banned even there: the relaxation is "proportions", not "draw it
yourself".

### D-7. "Search before generate" is structural, not advisory

V10 says look it up before inventing it. `generatePrimitive` **runs the search itself** and returns
a match at or above `REUSE_SCORE` without a model call, so there is no code path that generates
without having searched. The guarantee does not depend on the agent choosing to behave — which is
the AD-8 shape of it: bound the cost, never gate the decision.

Two thresholds, deliberately different numbers: `DEFAULT_MIN_SCORE` (0.25) is "worth showing the
agent", `REUSE_SCORE` (0.6) is "worth substituting for what it asked for". Showing a weak match costs
one line of context; silently substituting one costs the diagram.

The search is by **name alone**. Appending the description dilutes the one token that identifies the
thing — "pulley" scores 1 against an entry called "pulley", while "pulley, a grooved wheel on an axle
that redirects a rope" scores 0.5 and misses its own exact match. (This was found by a failing test,
not by inspection.)

### D-8. `PrimitiveCatalog` is a one-method interface, and the bridge lives above it

`shape-intelligence` sits below `agent-memory` and must not know a persistent store exists, so it
declares the interface it needs. `agent-tools-reasoning`'s `memoryCatalog(store, embedder)` is where
the two meet, and the only place in Phase 5 that knows both names. Phase 12's `primitive-sdk` will
supply a second implementation without either package changing.

`InMemoryPrimitiveCatalog`'s scoring is lexical and field-weighted: an alias match counts far more
than a word buried in a description, which is exactly the case AD-7 names. A semantic tier is
deliberately *not* duplicated here — it already exists behind `MemoryStore`'s embedder, and two
implementations would give the same question two answers depending on which door it came through.

### D-9. `ReasoningWorkspace`: artifacts stay server-side, the model carries none of them

Without it, every stage's output would travel back through the model to become the next stage's
arguments. A `ShapeGraph` round trip is thousands of tokens the model already saw, plus an
opportunity to paraphrase its own prior output on the way past.

So `plan_visual` and `build_shape_graph` take **no arguments** and read from the workspace. The model
still sees each result — it just is not asked to carry it.

Three lifetimes, three homes: `ReasoningWorkspace` (this run's artifacts), `SessionMemory` (what
happened, in prose, for the model), `MemoryStore` (outlives every session).

The workspace also holds the last failed AST and its errors, which is what makes the next
`compose_diagram_ast` a *repair* rather than a fresh guess — and a successful composition clears it,
so later calls do not keep apologising for a mistake already fixed.

### D-10. Missing input is an observation, never a refusal

`plan_visual` with no intent returns `REASONING_MISSING_INPUT`: recoverable, naming the tool that
produces the missing input, and suggesting `compose_diagram_ast` if the request is simple enough not
to need the stage at all. Nothing in this phase gates anything (AD-8).

---

## Acceptance

All verified by `tests/reasoning-pipeline.test.ts` (root, through the real `runAgent` loop) plus the
per-package suites. No network: the whole suite runs on `FakeProvider`.

- [x] "Draw a movable pulley" produces a valid `DiagramAST` with ceiling, fixed pulley, movable
      pulley, rope, load.
- [x] "Draw a circle" completes with fewer tool calls **and** fewer reasoning round trips than the
      pulley — one, against four (AD-1).
- [x] A deliberately malformed AST returns structured errors the agent fixes on a subsequent step,
      verifiable in the trace: step 1 carries `AST_ORPHAN_OBJECT` naming `rope_2`, the run continues,
      step 3 passes.
- [x] `search_primitives` is consulted before `generate_primitive` — enforced inside the generator,
      not by convention (D-7).
- [x] No agent output contains `x`, `y`, `svg`, or `canvasCommand` — asserted against what the tools
      actually returned in a full run, not against the schemas (D-6).
- [x] All tools unit-tested against the fake provider; no network in the default suite.

Additional properties worth having asserted:

- [x] A tool that does not exist is also just an observation; the run recovers and completes.
- [x] A successful composition clears the remembered failure.
- [x] Freeform unit-space points survive the geometry guard; `svg` does not.
- [x] The full chain runs with each stage reading the last from the workspace.

---

## Notes for Phase 6

- `parameters` / `properties` bags are unreachable through structured output (D-3). If parametric
  shapes matter to the constraint engine, that is the phase to decide how they get filled — most
  likely a dedicated tool with a closed schema rather than reopening the map.
- `agent-tools-geometry` (Phase 9 in the Package Map) will want the same workspace. Consider whether
  `ReasoningWorkspace` becomes a shared `PipelineWorkspace` at that point rather than a second one
  appearing beside it.
- The `tools`-above-`agent` layer order (see above) is now the precedent for every later tool
  package; `agent-tools-geometry` and `agent-tools-canvas` are already listed there.
