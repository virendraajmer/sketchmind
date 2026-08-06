# @sketchmind/agent-tools-geometry

The geometry pipeline, exposed as agent tools (AD-1) — the other half of the
catalogue `agent-tools-reasoning` opened.

This package owns no pipeline logic. `constraint-engine`, `layout-engine` and
`stroke-planner` keep their V12 contracts and know nothing about agents; this is
the seam that turns them into a tool catalogue.

## The three tools

`createGeometryTools({ workspace, getAst })` returns, in this order:

| Tool | |
|---|---|
| `derive_constraints` | `DiagramAST` → `ConstraintGraph`. Relationships, still no positions. |
| `solve_layout` | → `LayoutModel`. The first stage that produces coordinates, and the only one allowed to. |
| `plan_strokes` | → `StrokeAST`. The drawing sequence, in teaching order. |

Like the reasoning tools, nothing here expresses a required order — only the
descriptions do, and the model may disagree with them.

## Why there is no geometry guard

Every reasoning tool runs its output through a guard that rejects coordinates,
because a model authored that output. These three stages are deterministic code
and producing coordinates is exactly their job. The guard is not omitted by
oversight; here it would be checking the wrong invariant.

## Why the model never sees the geometry

Each handler stores the real artifact in the `GeometryWorkspace` and returns a
*summary* — counts, the strategy chosen, canvas size, which objects got strokes.
A `LayoutModel` is thousands of numbers the model cannot usefully read, and the
surest way to stop it inventing coordinates is to never put any in its context.

Failures are the exception: a failed `ValidationResult` passes through verbatim,
because an error the model cannot read is one it cannot fix (AD-2).

`plan_strokes` returns `targets` — the object ids that got strokes — so the model
can tell "I drew everything" from "I drew the pulley and forgot the rope" without
being shown a single coordinate.

## Why the workspace is separate

`GeometryWorkspace` is deliberately not `ReasoningWorkspace`. The two tool
packages know nothing about each other; the join is the `getAst` function passed
in at construction, supplied by whoever assembles the session (in Phase 9, that
is `apps/api`). `getAst` is a getter rather than a value because the AST does not
exist when the tools are built — the agent composes it mid-run.

## Why there is no render tool

Rendering needs a mounted `RendererAdapter`, which lives in the browser. The
server produces a Stroke AST and streams it. There is nothing here for a
server-locus tool to call.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

Sits in the `tools` layer, which sits **above** `agent` — `agent-core`
deliberately knows nothing about any tool package, while every tool package needs
`defineTool` from it. Direction is enforced by `scripts/check-layering.mjs`; run
`pnpm run check:layering`.
