# @sketchmind/shared-types

**Layer:** foundation (depends on nothing but `zod`)

Canonical home for every model shared across SketchMind packages. No other
package may redefine these — duplication here is what causes the four internal
models to drift into each other (Volume 11 §Shared Types, Volume 12).

Every model is written once as a Zod schema, with its TypeScript type derived via
`z.infer`. Writing the type by hand alongside the schema gives you two
definitions that drift the first time someone edits one.

## Models

| Model | File | Purpose |
|---|---|---|
| `SketchMindError`, `ValidationResult` | `errors.ts` | Structured errors; validation returns them rather than throwing (AD-2) |
| Branded ids, `PipelineStage`, `Locus` | `primitives.ts` | Shared vocabulary |
| `Relationship` (14 types) | `relationships.ts` | Semantic relationships, shared by VIL and the AST |
| `IntentModel`, `VisualPlan`, `VIL` | `intent.ts` | What the user asked for, and what should appear |
| `ShapeGraph` | `shape-graph.ts` | What an object is made of: nodes + edges, no geometry |
| `ConstraintGraph` (15 types) | `constraints.ts` | Spatial intent, still no numbers |
| `DiagramAST` | `diagram.ts` | Canonical semantic diagram — the single source of truth |
| `LayoutModel` | `layout.ts` | **Geometry lives here** |
| `StrokeAST` (12 stroke types) | `stroke.ts` | Ordered drawing sequence — the other geometry-bearing model |
| `FreeformShape` | `freeform.ts` | One-off composition without manifest ceremony (AD-5) |
| `RuntimeEvent`, `Session` | `runtime.ts` | Lifecycle events as a discriminated union |
| `AgentTrace`, `ToolSpec`, `AgentBudget` | `agent.ts` | Agent observability and tool catalogue |

## The geometry boundary

Only `LayoutModel` and `StrokeAST` may contain numeric geometry. Every volume
states this in prose; `tests/geometry-purity.test.ts` enforces it — each semantic
schema is converted to JSON Schema, walked, and failed on any banned property
name at any depth. The test includes negative controls proving the walker
actually catches planted geometry, including inside recursive branches.

`FreeformShape` is deliberately not guarded: its `u`/`v` values are proportions
inside a shape's own 0..1 box, not positions on the board. See `src/freeform.ts`
for why that relaxation is bounded and safe.

## `ToolSpec`, not `ToolDefinition`

This package owns the serializable half of a tool — name, description, JSON
Schema parameters, execution locus. The `handler` stays in Phase 4's `agent-core`
(`ToolDefinition = ToolSpec & { handler }`), because a handler signature here
would drag the agent runtime into the foundation layer and invert the dependency
direction `scripts/check-layering.mjs` enforces.

That split is also what lets the server hand the browser a tool catalogue
without handing it server code.

## Public API

See `src/index.ts`.
