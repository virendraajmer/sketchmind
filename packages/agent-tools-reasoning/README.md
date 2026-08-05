# @sketchmind/agent-tools-reasoning

The reasoning pipeline, exposed as agent tools (AD-1).

This package owns no reasoning. `intent-analyzer`, `visual-planner`,
`shape-intelligence` and `diagram-reasoner` each keep their V12/V15 contract and
know nothing about agents; this is the seam that turns them into a tool
catalogue, and the only place that knows both an `LLMProvider` and a
`ToolDefinition`. Keeping the seam thin is the point — when Phase 6 adds the
layout stage, it becomes another tool here and neither the loop nor any reasoning
package changes.

## The eight tools

`createReasoningTools({ provider, workspace, catalog? })` returns, in this order:

| Tool | Read-only | |
|---|---|---|
| `analyze_intent` | yes | NL → `IntentModel`. |
| `plan_visual` | yes | → `VisualPlan`. Reads the intent from the workspace. |
| `build_shape_graph` | yes | → `ShapeGraph`. Reads plan and intent from the workspace. |
| `compose_diagram_ast` | no | → `DiagramAST`, from whatever exists. Works with nothing. |
| `validate_diagram` | yes | Every problem at once; remembers failures for the next repair. |
| `search_primitives` | yes | Zero model calls. |
| `generate_primitive` | no | Searches first, always (V10). |
| `compose_freeform` | no | One-off shape in unit space (AD-5). |

Nothing here expresses a preferred order. Only the descriptions do, and the model
is free to disagree with them — that freedom is AD-1.

## Three properties every tool has

**It returns a `ValidationResult`.** `agent-core` unwraps `ok` and turns `errors`
into an observation verbatim (AD-2), so a stage's own validator becomes the
agent's error message with no adapter in between.

**Its output is checked for geometry** before the model sees it. `shared-types`
already proves the *schemas* are geometry-free, but that is a static guarantee
about shapes we declared — every semantic model carries an open `metadata` /
`properties` / `parameters` bag, and a model stashing `{ x: 40, y: 120 }` in one
passes every schema in the repo. `src/internal/guard.ts` is the runtime half.
Violations are rejected whole rather than stripped: silently removing the field
teaches the model nothing and leaves the run holding an artifact that differs
from what the model believes it produced.

`FreeformShape` is checked against a narrower list — its `points` are `{ u, v }`
proportions inside the shape's own box (AD-5), not places on the board — but
`svg`, `path` and `transform` stay banned even there. The relaxation is
"proportions", not "draw it yourself".

**It reads its inputs from the `ReasoningWorkspace`**, so the model is never
asked to carry a `ShapeGraph` back through its own context window. That is not a
small tax: a round trip is thousands of tokens the model already saw, and an
opportunity for it to paraphrase its own prior output on the way past.

## Missing input is an observation, not a refusal

`plan_visual` with no intent returns `REASONING_MISSING_INPUT` — recoverable,
naming the tool that fixes it, and suggesting `compose_diagram_ast` if the
request is simple enough not to need the stage at all. Nothing here gates
anything (AD-8).

## Three lifetimes, three homes

`ReasoningWorkspace` is per-run artifact state. It is deliberately distinct from
`agent-memory`'s `SessionMemory` (what happened, in prose, for the model) and its
`MemoryStore` (learned primitives that outlive every session).

## memoryCatalog

`shape-intelligence` declares the one-method `PrimitiveCatalog` it needs and
cannot import `agent-memory` — it sits below it. `memoryCatalog(store, embedder)`
is where the two meet, and the only place in Phase 5 that knows both names. It is
the second half of AD-7: "draw a nephron" searches the store the agent wrote last
week, finds the "kidney nephron unit" it learned then, and skips generation.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

Sits in the `tools` layer, which sits **above** `agent` — `agent-core`
deliberately knows nothing about any tool package, while every tool package needs
`defineTool` from it. Direction is enforced by `scripts/check-layering.mjs`; run
`pnpm run check:layering`.
