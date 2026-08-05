# @sketchmind/visual-planner

`IntentModel` to `VisualPlan` (V03 §Visual Planning Agent, V15 §Agent Contracts).

Decides **what appears** on the board, and nothing else. Not what it looks like,
not what it is made of, not where it goes. That restraint is why the stage exists
separately: "which objects belong in this explanation" is a teaching judgement,
and mixing it with "what is a pulley made of" (`shape-intelligence`) produces
plans that are really half-drawn diagrams.

## The hard part is leaving things out

A model asked "what should appear in a pulley diagram" will happily add bolts,
brackets and a background wall. Every object planned here becomes an object the
layout engine must find room for, so `detailLevel` and the prompt's "must earn
its place" rule exist to push back.

## Semantic validation (AD-2)

`VisualPlanSchema` guarantees a label has a `target` string. It cannot guarantee
that string names an object in the same plan — and the model renaming an object
between the `objects` array and the `labels` array is this stage's most common
failure, invisible until layout tries to place a label on nothing.

`validateVisualPlan` catches, and reports **all at once**:

| Code | |
|---|---|
| `PLAN_UNKNOWN_TARGET` | A label, highlight, animation or focus entry names an object that does not exist. |
| `PLAN_DUPLICATE_ID` | Two objects share an id. |
| `PLAN_INCOMPLETE_FOCUS_ORDER` | A partial draw order — see below. |

It is exported separately from `planVisual` because the agent may compose a plan
itself for a trivial request rather than spend a model call on it (AD-1), and a
hand-composed plan is held to the same standard.

## focusOrder: filled when empty, rejected when partial

An **empty** `focusOrder` is filled deterministically by importance
(primary → secondary → supporting, ties keeping declaration order). The model
declining to order six objects is not a mistake it needs to see.

A **partial** one is rejected. It is a claim about draw order that contradicts
the object list, and silently completing it would discard what the model actually
intended for the objects it did name.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

Depends on `@sketchmind/llm-provider` and `@sketchmind/shared-types`, and on no
concrete provider. Direction is enforced by `scripts/check-layering.mjs`; run
`pnpm run check:layering`.
