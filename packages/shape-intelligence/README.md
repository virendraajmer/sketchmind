# @sketchmind/shape-intelligence

`VisualPlan` to `ShapeGraph`, plus primitive discovery and generation
(V10 §Shape Intelligence Engine, V14 §Shape Graph, AD-5).

## Search before generate, made mechanical (V10)

V10's rule is "look it up, and only invent what you could not find". Here that is
not advice: `generatePrimitive` **runs the search itself** and returns the match
when one is good enough. There is no code path that generates without having
searched, so the guarantee does not depend on the agent choosing to behave —
which is the AD-8 shape of the thing. Bound the cost, never gate the decision.

The search is deliberately **zero tokens and deterministic**. A guard that costs
a model call is more expensive than what it guards.

Two thresholds, and they are not the same number:

| | |
|---|---|
| `DEFAULT_MIN_SCORE` (0.25) | Worth *showing* the agent. |
| `REUSE_SCORE` (0.6) | Worth *substituting* for what it asked for. |

Showing a weak match costs one line of context; silently substituting one costs
the diagram.

`generatePrimitive` searches by **name alone**, not name-plus-description:
appending a sentence dilutes the one token that identifies the thing. "pulley"
scores 1 against an entry called "pulley", while "pulley, a grooved wheel on an
axle that redirects a rope" scores 0.5 and misses its own exact match.
Description-led discovery is what `search_primitives` is for, where the agent
chooses the phrase.

## The catalogue is an interface, on purpose

`PrimitiveCatalog` has one method. The interesting backends are not in this
layer, and this package sits below both of them:

- `agent-tools-reasoning`'s `memoryCatalog()` backs it with `agent-memory`'s
  persisted store (AD-7).
- Phase 12's `primitive-sdk` will back it with the registered-primitive registry.

`InMemoryPrimitiveCatalog` is the default, and is what makes "search before
generate" testable without a database or a model.

Its scoring is lexical, weighted by field — an alias match counts far more than a
word buried in a description, which is exactly the case AD-7 exists to serve
("nephron" must find "kidney nephron unit"). A semantic tier belongs behind
`MemoryStore`'s embedder, where it already exists; duplicating it here would give
the same question two answers depending on which door it came through.

## Two ways to answer "what is this thing"

- **`generatePrimitive`** → a `ShapeGraph`: what it is *made of*. Semantic,
  reusable, no geometry at all.
- **`composeFreeform`** → a `FreeformShape`: what it *looks like*, in the shape's
  own 0..1 unit box, for objects with no structure worth decomposing (AD-5).

The AD-5 relaxation is bounded by `FreeformShapeSchema` itself — `u`/`v` outside
0..1 fail validation — so a model that starts emitting pixels is caught by the
parser, not by a reviewer.

## Semantic validation (AD-2)

`validateShapeGraph` reports every problem at once:

| Code | |
|---|---|
| `SHAPE_UNKNOWN_ROOT` | `root` names no node. |
| `SHAPE_UNKNOWN_REFERENCE` | An edge points at a node that does not exist. |
| `SHAPE_CONTAINMENT_CYCLE` | `inside`/`contains`/`wraps` loops back on itself — schema-valid, and unsolvable by every layout strategy Phase 6 will have. |
| `SHAPE_ORPHAN_NODE` | A node attached to nothing, so it can never be positioned. A single-node graph is fine: "a circle" has no parts. |
| `SHAPE_DUPLICATE_ID` / `SHAPE_DUPLICATE_ANCHOR` / `SHAPE_SELF_REFERENCE` | |

## The prompts

Three, in `src/internal/prompt.ts`, because this package answers three different
questions and blending them produces mush: `SHAPE_GRAPH_PROMPT`,
`PRIMITIVE_PROMPT`, `FREEFORM_PROMPT`. Only the freeform prompt mentions anything
numeric, and its forbidden-output section restates the unit-space boundary rather
than assuming it — an unstated exception is an invitation.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

Depends on `@sketchmind/llm-provider` and `@sketchmind/shared-types`, and on no
concrete provider. Direction is enforced by `scripts/check-layering.mjs`; run
`pnpm run check:layering`.
