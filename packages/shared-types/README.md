# @sketchmind/shared-types

**Layer:** foundation (depends on nothing)

Canonical home for every model shared across SketchMind packages. No other
package may redefine these — duplication here is what causes the four internal
models to drift into each other (Volume 11 §Shared Types, Volume 12).

## Models owned by this package

Arriving in Phase 2:

| Model | Purpose |
|---|---|
| `IntentModel` | What the user is asking for: intent, domain, category, complexity |
| `VisualPlan` | What should appear: objects, labels, highlights, detail level |
| `VIL` | Visual Intent Language document — the AI/engine contract |
| `ShapeGraph` | Semantic structure of an object: nodes + edges, no geometry |
| `DiagramAST` | Canonical semantic diagram: objects, relationships, anchors |
| `ConstraintGraph` | Spatial relationships derived from the AST |
| `LayoutModel` | **The only model permitted numeric geometry** |
| `StrokeAST` | Ordered drawing sequence |
| `RuntimeEvent` | Session/stage/stroke lifecycle events |
| `SketchMindError` | `{ code, message, package, stage, recoverable }` |
| `AgentTrace` | One agent step: thought, tool, args, result, tokens, duration |
| `ToolDefinition` | Agent tool: name, description, Zod args schema, execution locus |
| `FreeformShape` | Geometric composition without manifest ceremony (AD-5) |

## Public API

See `src/index.ts`. Internals (if any) live in `src/internal/` and are not
importable from other packages.
