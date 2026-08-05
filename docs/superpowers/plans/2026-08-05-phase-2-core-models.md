# Phase 2 — Core Models

**Branch:** `develop`
**Packages touched:** `shared-types`, `diagram-ast`, `utilities` (+ a repo-wide tsconfig fix)
**Deliverable:** every model in the pipeline exists exactly once, as a Zod schema with the
TypeScript type derived from it, and the geometry boundary is enforced by an automated test
rather than by discipline.

---

## Design decisions

### D-1. Zod schema is the source of truth; the TS type is derived

Every model is written once as a Zod schema, and its type comes from `z.infer`. Writing the
type by hand next to the schema means two definitions that drift silently the first time
someone edits one.

```ts
export const DiagramObjectSchema = z.object({ /* ... */ });
export type DiagramObject = z.infer<typeof DiagramObjectSchema>;
```

**Zod 4** (4.4.3), not Zod 3. Phase 3 needs JSON Schema to drive Azure OpenAI structured
outputs, and Zod 4 ships `z.toJSONSchema()` in core. On Zod 3 that requires a third-party
converter whose output would have to be trusted against the real API. The same function also
powers the geometry-purity test in Task 7, so it earns its place twice.

### D-2. Validation returns a result; it does not throw

AD-2 says a validation failure is an agent *observation*, not a pipeline halt. An exception is
the wrong shape for that: the agent needs to read every problem at once and decide what to fix,
and a thrown error carries one failure and a stack trace nobody can act on.

```ts
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: SketchMindError[] };
```

Callers that genuinely want to fail fast get a separate `assert*` wrapper. The default is the
one the agent uses.

### D-3. `SketchMindError` is data, not an `Error` subclass

Volume 12 requires `{ code, message, package, stage, recoverable }`. These objects travel over
SSE to the browser agent and into the agent's context window, so they must be plain JSON.
An `Error` subclass loses its fields on `structuredClone`/`JSON.stringify` and drags a stack
trace into the model's context that costs tokens and teaches it nothing.

A `path` field is added (not in Volume 12): the agent's first question about a validation
failure is always *where*, and without it the agent has to re-read the whole document.

### D-4. Geometry purity is tested, not documented

The rule "only `LayoutModel` and `StrokeAST` contain geometry" is the single most important
invariant in the system, and every volume states it as prose. Prose does not fail a build.

Task 7 converts each semantic schema to JSON Schema, walks it recursively, and fails on any
property named `x`, `y`, `width`, `height`, `rotation`, `cx`, `cy`, `dx`, `dy`, `points`,
`path`, `d`, `transform`, `left`, `top`, `bounds`, `boundingBox`, `viewBox`, or `coordinates`.
The banned list lives next to the test, and adding a model to the guarded set is one line.

### D-5. Ids are branded strings

`ObjectId`, `StrokeId`, `SessionId` etc. are `string & { readonly __brand: unique symbol }`.
Passing a stroke id where an object id belongs is otherwise a compile-time no-op, and it is
exactly the mistake that produces a diagram that validates and renders wrong.

### D-6. `ToolDefinition` lives in `shared-types` without its handler

The plan lists `ToolDefinition` as `{ name, description, argsSchema, locus, handler }`. The
`handler` cannot live in `shared-types` — it would drag the agent runtime's types into the
foundation layer and invert the dependency direction that `check-layering.mjs` enforces.

So `shared-types` owns `ToolSpec` (`name`, `description`, `argsSchema`, `locus`) — the
serializable half that gets sent to the LLM and across the wire. Phase 4's `agent-core` owns
`ToolDefinition = ToolSpec & { handler }`. This is the split that lets the browser receive a
tool catalogue without receiving server code.

### D-7. Tests get typechecked (repo-wide fix)

Every package's `typecheck` script is `tsc -p tsconfig.json --noEmit`, and every
`tsconfig.json` has `"include": ["src"]`. **Test files are currently not typechecked at all.**
In a phase whose entire output is types, that hole would let a test assert something the
compiler would have rejected.

Fix: each package gains a `tsconfig.test.json` covering `src` + `tests`, and `typecheck`
becomes `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json`. Applied by script
across all 30 workspace members.

---

## Task breakdown

Each task is TDD: test first, watch it fail, implement, watch it pass.

| # | Task | Files |
|---|---|---|
| 0 | Test typecheck + add `zod` to `shared-types` | all `tsconfig.test.json`, `scripts/add-test-tsconfig.mjs` |
| 1 | Primitives: branded ids, `SketchMindError`, `ValidationResult`, shared enums | `src/primitives.ts`, `src/errors.ts` |
| 2 | `IntentModel`, `VisualPlan`, `VIL` | `src/intent.ts`, `src/vil.ts` |
| 3 | `ShapeGraph`, `ConstraintGraph` (15 constraint types) | `src/shape-graph.ts`, `src/constraints.ts` |
| 4 | `DiagramAST` (12 relationship types) | `src/diagram.ts` |
| 5 | `LayoutModel`, `StrokeAST` (12 stroke types), `FreeformShape` | `src/layout.ts`, `src/stroke.ts`, `src/freeform.ts` |
| 6 | `RuntimeEvent`, `AgentTrace`, `ToolSpec` | `src/runtime.ts`, `src/agent.ts` |
| 7 | Geometry-purity guard | `tests/geometry-purity.test.ts` |
| 8 | `buildDiagramAST` / `validateDiagramAST` | `packages/diagram-ast/src/*` |
| 9 | Full gate: layering → lint → typecheck → build → test | — |

`utilities` gets only what Task 8 actually needs (deterministic id generation, stable sort),
rather than a speculative helper library.

---

## Acceptance criteria

- [x] Every model in the Phase 2 table exists as a Zod schema in `shared-types`, with the type
      derived via `z.infer`, and is defined nowhere else in the repo.
- [x] `diagram-ast` exposes `buildDiagramAST` and `validateDiagramAST`; a hand-built AST
      round-trips through `parse` → `serialize` → `parse` unchanged.
- [x] Contract tests fail correctly for: duplicate object id, orphan object, relationship
      pointing at a missing object, unknown relationship type, unknown constraint type,
      missing schema version.
- [x] An automated test asserts no geometry field exists on `DiagramAST`, `ShapeGraph`,
      `VisualPlan`, `VIL`, or `ConstraintGraph` — **and is proven to fail when a geometry
      field is planted**, the same way the Phase 1 provider-SDK guard was proven.
      Verified twice: four negative-control cases in the test itself, plus a real
      `x: z.number()` planted into `src/diagram.ts` (guard failed, source restored).
- [x] Every validation error is a structured `SketchMindError` with a `path`, and multiple
      errors are returned together rather than one at a time.
- [x] Tests are typechecked in every package. Proven by planting a test-only type error.
- [x] Full gate green.

---

## Outcome

104 tests (76 `shared-types`, 28 `diagram-ast`). Full gate:

| Check | Result |
|---|---|
| `check:layering` | 30 packages, no upward deps, no cycles |
| `lint` | 30/30 |
| `typecheck` | 31/31 |
| `build` | 30/30 |
| `test` | 60/60 |
| Provider-SDK leak grep | clean |

### Three findings worth carrying forward

**Zod's `.default()` does not parse its default.** `StrokeStyleSchema.default({})`
substituted the literal `{}`, so the nested `width: 2` and `durationMs: 400` defaults never
ran — strokes would have reached the renderer with no width. `.prefault({})` parses the
default and fills them in. Caught by a test asserting the defaults were actually present;
it would not have been caught by a test that only asserted the parse succeeded.

**The Phase 1 internal-import lint rule was too broad.** `"**/internal/*"` banned a package
importing its *own* internals — precisely the structure Volume 12 prescribes. Narrowed to
cross-package reaching only (`@sketchmind/*/internal/**` and relative climbs), and re-verified
in both directions: own internals pass, both escape routes still fail.

**Tests were never typechecked.** Every `tsconfig.json` has `include: ["src"]`, so
`tsc --noEmit` skipped `tests/` entirely. Fixed repo-wide via `tsconfig.test.json`
(`scripts/add-test-tsconfig.mjs`), and proven by planting a test-only type error.
