# SketchMind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build SketchMind — an AI-native Technical Sketch Engine that turns a natural-language request into a reasoned, semantically-modeled, constraint-laid-out, and stroke-by-stroke animated whiteboard drawing — as a TypeScript monorepo, in 8 runnable phases.

**Architecture:** Strict pipeline of independent, contract-bound packages: `Natural Language → Intent → Visual Plan → Shape Graph → Diagram AST → Constraint Graph → Layout Model → Stroke AST → Renderer`. AI (LLM) only ever produces structured JSON reasoning (Intent, Visual Plan, Shape Graph, Diagram AST); it never emits coordinates, SVG, canvas/Konva commands, or geometry. Everything from the Constraint Engine onward is deterministic software. Renderers are pluggable and know nothing about AI or layout.

**Tech Stack:** TypeScript monorepo (Node.js), package manager + workspaces (pnpm recommended), Turborepo-style incremental builds, Vitest/Jest for testing, Zod (or similar) for runtime schema validation, Konva as the first renderer backend, Next.js-based `playground` app for manual verification. (Confirmed by `.gitignore` entries for `node_modules`, `*.tsbuildinfo`, `.next`.)

## Global Constraints

These apply to every phase and every task below — do not restate them per task, but do not violate them either.

- Monorepo layout is exactly: `apps/`, `packages/`, `examples/`, `docs/`, `tools/`, `scripts/`, `tests/`, `configs/` (Volume 11).
- Dependency direction is one-way: `Applications → Orchestrator → Core Packages → Renderer Packages → External Libraries`. Packages never depend upward. No circular dependencies (Volume 11).
- Shared models (`IntentModel`, `VisualPlan`, `DiagramAST`, `ShapeGraph`, `ConstraintGraph`, `LayoutModel`, `StrokeAST`, `RuntimeEvent`) live **only** in `packages/shared-types`. No package redefines or duplicates them (Volume 11, 12).
- Every package exposes a versioned public API only (interfaces, input/output models, events, errors, config) — no cross-package imports of internal modules (Volume 12).
- Four internal models must stay separate and are never merged into one object: Diagram AST (semantic), Constraint Model (relationships), Layout Model (geometry), Stroke AST (drawing sequence) (Volume 02).
- AI components (Intent Analyzer, Visual Planner, Shape Intelligence, Diagram Reasoner) must never output coordinates, SVG, canvas commands, or Konva commands — structured JSON with stable IDs only (Volume 03, 10, 13, 15).
- Every pipeline stage output must pass a validation gate before the next stage runs; invalid output halts the pipeline (Volume 09, 17).
- Multi-LLM provider support (OpenAI, Anthropic, Gemini, local) via a single provider adapter interface; no provider-specific code outside `packages/ai-orchestrator`'s provider adapters (Volume 03, 09, 15).
- Renderers must never call LLMs, compute layout, or mutate the Stroke AST — pure execution/paint layer (Volume 08).
- MVP scope is: single renderer (Konva), one LLM provider wired live (others stubbed via the adapter interface), a small primitive set, animated drawing, replay, undo/redo, export. Explicitly deferred: collaboration, marketplace, multi-renderer, remote plugin registries, cloud sync (Volume 18).
- Every package ships with unit tests, and root-level `tests/` holds contract/integration/system tests (Volume 11, 17).

---

## Scope Note (read before executing)

This spec spans 8 independent subsystems (repo scaffolding, shared models, AI reasoning, layout/constraints, stroke engine, rendering, plugin SDK, end-to-end orchestration). Per `writing-plans` guidance, a spec this size should really be split into one detailed sub-plan per phase, written immediately before that phase starts — not all up front, because later phases depend on interfaces only Phase 1–2 will concretely settle (exact Zod schemas, exact event names, exact package names beyond what the docs already fix).

So this document does two things:
1. **Phase 1** below is a fully detailed, bite-sized, TDD-ready plan — start here.
2. **Phases 2–8** are specified as a firm roadmap: exact packages, responsibilities, inputs/outputs, and acceptance criteria per Volumes 02–18 — enough to scope and sequence work, but each should get its own `writing-plans` pass (producing `docs/superpowers/plans/YYYY-MM-DD-phase-N-<name>.md`) once the prior phase's interfaces are real code, not spec prose. Trying to pre-write bite-sized code steps for phases 4–8 today would mean inventing schema details the docs deliberately leave to implementation — that code would likely be thrown away once Phase 1–3 settle real types.

Recommended cadence: finish a phase → run `superpowers:writing-plans` again for the next phase, using the actual interfaces just built as the "Interfaces: Consumes" input.

---

## Phase 1 — Repository Foundation

**Maps to:** Volume 11 (Repository Structure), Volume 18 Phase 1.

**Deliverable:** `sketchmind/` builds, lints, and tests successfully with empty-but-real package skeletons for every package named in Volume 11, wired together with correct one-way dependencies, before any business logic is written.

### File Structure

```
sketchmind/
├── package.json                  # workspace root, scripts: build/lint/test
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── turbo.json
├── .eslintrc.cjs
├── .prettierrc
├── vitest.workspace.ts
├── apps/
│   └── playground/                # Next.js app, consumes packages, no business logic
├── packages/
│   ├── shared-types/
│   ├── ai-orchestrator/
│   ├── intent-analyzer/
│   ├── visual-planner/
│   ├── diagram-reasoner/
│   ├── shape-intelligence/
│   ├── diagram-ast/
│   ├── constraint-engine/
│   ├── layout-engine/
│   ├── stroke-planner/
│   ├── stroke-runtime/
│   ├── renderer-core/
│   ├── renderer-konva/
│   ├── renderer-svg/
│   ├── primitive-sdk/
│   ├── plugin-sdk/
│   ├── export-engine/
│   └── utilities/
├── examples/
├── docs/                          # already exists (Volumes 01-18)
├── tools/
├── scripts/
├── tests/                         # root-level contract/integration/system tests
└── configs/
```

Each `packages/<name>/` gets the same internal skeleton:

```
packages/<name>/
├── package.json          # name: "@sketchmind/<name>"
├── tsconfig.json          # extends ../../tsconfig.base.json
├── src/
│   ├── index.ts           # public API surface only
│   └── internal/          # implementation, never imported by other packages
├── tests/
│   └── index.test.ts
└── README.md              # purpose, public API, examples (Volume 11)
```

### Task 1: Workspace root and tooling

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `turbo.json`, `.eslintrc.cjs`, `.prettierrc`, `vitest.workspace.ts`

**Interfaces:**
- Produces: root `build`, `lint`, `test`, `typecheck` scripts that every later task and phase relies on to verify their work.

- [ ] **Step 1: Write root `package.json`**

```json
{
  "name": "sketchmind",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "build": "turbo run build",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.5.0",
    "eslint": "^9.0.0",
    "prettier": "^3.3.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Write `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "composite": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 4: Write `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["build"] },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

- [ ] **Step 5: Write `.eslintrc.cjs`**

```js
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "import"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  rules: {
    "import/no-cycle": "error",
    "no-restricted-imports": [
      "error",
      { "patterns": ["**/internal/*"] }
    ]
  }
};
```

The `no-restricted-imports` rule against `**/internal/*` is the enforcement mechanism for "packages must never depend on another package's internal implementation" (Global Constraints).

- [ ] **Step 6: Write `.prettierrc`**

```json
{ "semi": true, "singleQuote": false, "printWidth": 100 }
```

- [ ] **Step 7: Write `vitest.workspace.ts`**

```ts
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*",
  "apps/*"
]);
```

- [ ] **Step 8: Install dependencies and verify workspace resolves**

Run: `pnpm install`
Expected: lockfile created, no errors (workspace has no member packages yet, so this just validates root tooling).

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json turbo.json .eslintrc.cjs .prettierrc vitest.workspace.ts pnpm-lock.yaml
git commit -m "chore: scaffold monorepo tooling (pnpm + turbo + eslint + vitest)"
```

### Task 2: `shared-types` package (first package, no dependencies)

**Files:**
- Create: `packages/shared-types/package.json`, `packages/shared-types/tsconfig.json`, `packages/shared-types/src/index.ts`, `packages/shared-types/tests/index.test.ts`, `packages/shared-types/README.md`

**Interfaces:**
- Consumes: nothing (leaf package, Global Constraints dependency direction).
- Produces: `PACKAGE_NAME` and `PACKAGE_VERSION` constants that Task 3's contract test imports to prove the package resolves as a workspace dependency. Real shared models (`IntentModel`, `DiagramAST`, etc.) are added in Phase 2 Task — this task only proves the package skeleton, build, and test wiring work end-to-end.

- [ ] **Step 1: Write the failing test**

`packages/shared-types/tests/index.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/index";

describe("shared-types package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/shared-types");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/shared-types test`
Expected: FAIL — `src/index.ts` does not exist / exports not found.

- [ ] **Step 3: Write package skeleton**

`packages/shared-types/package.json`

```json
{
  "name": "@sketchmind/shared-types",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "eslint src",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

`packages/shared-types/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/shared-types/src/index.ts`

```ts
export const PACKAGE_NAME = "@sketchmind/shared-types";
export const PACKAGE_VERSION = "0.0.1";
```

`packages/shared-types/README.md`

```markdown
# @sketchmind/shared-types

Purpose: canonical home for every model shared across SketchMind packages
(IntentModel, VisualPlan, DiagramAST, ShapeGraph, ConstraintGraph,
LayoutModel, StrokeAST, RuntimeEvent). No other package may redefine
these models (see Volume 11 §Shared Types, Volume 12).

Public API: see `src/index.ts`.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sketchmind/shared-types test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared-types
git commit -m "feat(shared-types): scaffold package skeleton"
```

### Task 3: Remaining 16 package skeletons

**Files:**
- Create: for each of `ai-orchestrator`, `intent-analyzer`, `visual-planner`, `diagram-reasoner`, `shape-intelligence`, `diagram-ast`, `constraint-engine`, `layout-engine`, `stroke-planner`, `stroke-runtime`, `renderer-core`, `renderer-konva`, `renderer-svg`, `primitive-sdk`, `plugin-sdk`, `export-engine`, `utilities` — the same 5-file skeleton as Task 2, with `@sketchmind/<name>` substituted.
- Test: `packages/<name>/tests/index.test.ts` per package.

**Interfaces:**
- Consumes: `@sketchmind/shared-types` (Task 2) as a `workspace:*` dependency in every package's `package.json` — this is what later phases will replace with real imports of shared models.
- Produces: for every package, `PACKAGE_NAME`/`PACKAGE_VERSION` constants (same shape as Task 2), so Phase 2+ plans can rely on every package already building, testing, and lint-passing before real logic is added.

- [ ] **Step 1: Write the failing test for one representative package (`ai-orchestrator`)**

`packages/ai-orchestrator/tests/index.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/index";

describe("ai-orchestrator package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/ai-orchestrator");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});
```

Repeat the identical pattern (swap the package name string) for each of the other 15 packages listed above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -r test`
Expected: FAIL for all 16 new packages — no `src/index.ts` yet, and most don't have `package.json` yet either.

- [ ] **Step 3: Scaffold each package**

For each package `<name>` in the list, create the same four files as Task 2 Step 3, with `@sketchmind/<name>` substituted for the package name in `package.json` and `src/index.ts`, and this dependency added to `package.json`:

```json
"dependencies": {
  "@sketchmind/shared-types": "workspace:*"
}
```

`packages/<name>/tsconfig.json` is identical to Task 2's, extending `../../tsconfig.base.json`.

`packages/<name>/README.md` should state the package's Volume-defined purpose one line each (pull the one-line responsibility from Volume 11's package list, e.g. `ai-orchestrator`: "Execute pipeline, manage state, coordinate agents" from Volume 12).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -r test`
Expected: PASS for all 17 packages (Task 2's `shared-types` + these 16).

- [ ] **Step 5: Verify dependency direction has no cycles**

Run: `pnpm -r exec -- pnpm ls --depth=0` and manually confirm no package other than the 4 that legitimately sit above core (per Global Constraints ordering: `ai-orchestrator` may depend on the AI/engine packages; `renderer-konva`/`renderer-svg` depend on `renderer-core`; nothing depends on `ai-orchestrator`). Run `pnpm --filter '*' lint` to confirm the `import/no-cycle` rule reports nothing (there are no cross-imports yet, so this should pass trivially — this step exists to prove the lint rule is wired for Phase 2+ to catch real violations).

Expected: no cycle errors.

- [ ] **Step 6: Commit**

```bash
git add packages
git commit -m "feat: scaffold remaining 16 package skeletons"
```

### Task 4: `playground` app skeleton

**Files:**
- Create: `apps/playground/package.json`, `apps/playground/tsconfig.json`, `apps/playground/next.config.mjs`, `apps/playground/app/page.tsx`, `apps/playground/tests/page.test.tsx`

**Interfaces:**
- Consumes: `@sketchmind/shared-types` `PACKAGE_NAME` (Task 2) — proves an `apps/*` workspace member can import a `packages/*` workspace member, validating the `Applications → Core Packages` dependency direction end to end.
- Produces: a running Next.js dev server at `apps/playground`, which later phases use to manually drive `superpowers:run` checks against real pipeline output.

- [ ] **Step 1: Write the failing test**

`apps/playground/tests/page.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Page from "../app/page";

describe("playground home page", () => {
  it("renders the shared-types package name", () => {
    render(<Page />);
    expect(screen.getByText("@sketchmind/shared-types")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter playground test`
Expected: FAIL — `apps/playground` doesn't exist yet.

- [ ] **Step 3: Scaffold the app**

`apps/playground/package.json`

```json
{
  "name": "playground",
  "private": true,
  "version": "0.0.1",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "test": "vitest run",
    "lint": "eslint app",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@sketchmind/shared-types": "workspace:*",
    "next": "^14.2.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "jsdom": "^24.0.0"
  }
}
```

`apps/playground/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "preserve", "noEmit": true },
  "include": ["app"]
}
```

`apps/playground/next.config.mjs`

```js
/** @type {import('next').NextConfig} */
export default {};
```

`apps/playground/app/page.tsx`

```tsx
import { PACKAGE_NAME } from "@sketchmind/shared-types";

export default function Page() {
  return <main>{PACKAGE_NAME}</main>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter playground test`
Expected: PASS

- [ ] **Step 5: Verify dev server boots**

Run: `pnpm --filter playground dev` (background), then check `http://localhost:3000` renders `@sketchmind/shared-types`. Stop the dev server after confirming.

- [ ] **Step 6: Commit**

```bash
git add apps/playground
git commit -m "feat(playground): scaffold Next.js app consuming shared-types"
```

### Task 5: Root-level `tests/`, `configs/`, `tools/`, `scripts/`, `examples/` placeholders

**Files:**
- Create: `tests/README.md`, `configs/README.md`, `tools/README.md`, `scripts/README.md`, `examples/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: directories that Phase 2+ plans will populate (`tests/` for cross-package contract/integration/system tests per Volume 17; `configs/` for centralized AI-provider/renderer/feature-flag config per Volume 11; `examples/` for sample Diagram ASTs used in snapshot tests per Volume 17).

- [ ] **Step 1: Write each README stating the directory's purpose**

`tests/README.md`

```markdown
# tests/

Root-level contract, integration, and end-to-end tests that span multiple
packages. Package-local unit tests live in `packages/<name>/tests/`
(Volume 11 §Testing Strategy, Volume 17).
```

`configs/README.md`

```markdown
# configs/

Centralized configuration: AI provider selection, renderer selection,
feature flags, logging, cache, plugin registry. No package should read
config from global state directly — config is injected (Volume 11
§Configuration, Volume 12 §Configuration).
```

`tools/README.md`

```markdown
# tools/

Internal developer tooling (codegen, schema generators, migration
scripts) that isn't published as a package.
```

`scripts/README.md`

```markdown
# scripts/

One-off and CI automation scripts (release, changelog, benchmark
runners).
```

`examples/README.md`

```markdown
# examples/

Sample Diagram ASTs, Stroke ASTs, and rendered outputs used as fixtures
for snapshot and regression tests (Volume 17 §Snapshot Testing).
```

- [ ] **Step 2: Verify no build/test impact**

Run: `pnpm -r build && pnpm -r test`
Expected: PASS (unchanged — these are docs-only additions).

- [ ] **Step 3: Commit**

```bash
git add tests/README.md configs/README.md tools/README.md scripts/README.md examples/README.md
git commit -m "docs: add purpose READMEs for root-level directories"
```

### Task 6: CI quality gate

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root `build`/`lint`/`test`/`typecheck` scripts (Task 1).
- Produces: a CI gate that every subsequent phase's PRs must pass — this is the automated form of Volume 17's "Continuous Quality Gates" (all unit tests pass, no schema violations, reject builds that fail validation).

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  quality-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint
      - run: pnpm run typecheck
      - run: pnpm run build
      - run: pnpm run test
```

- [ ] **Step 2: Verify locally**

Run: `pnpm install --frozen-lockfile && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test`
Expected: all four commands PASS, mirroring what CI will run.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add lint/typecheck/build/test quality gate"
```

### Phase 1 Acceptance Criteria

- [ ] `pnpm install` succeeds from a clean clone.
- [ ] `pnpm run build` builds all 17 packages + `playground` with no errors.
- [ ] `pnpm run lint` passes, and the `import/no-cycle` / `no-restricted-imports` rules are active.
- [ ] `pnpm run test` passes for all packages.
- [ ] `apps/playground` boots via `pnpm --filter playground dev` and renders a value imported from `@sketchmind/shared-types`.
- [ ] CI workflow runs the same four commands and passes on push.
- [ ] Every `packages/*` directory has the skeleton from Volume 11 (`package.json`, `tsconfig.json`, `src/index.ts`, `tests/`, `README.md`).

This matches Volume 18 Phase 1's deliverable: "Repository builds successfully."

---

## Phase 2 — Core Models

**Maps to:** Volume 04 (Diagram AST), Volume 13 (VIL), Volume 14 (Shape Graph & Constraint Grammar), Volume 12 (Package Contracts), Volume 18 Phase 2.

**Deliverable:** "Models compile and validate" — every shared model type exists in `@sketchmind/shared-types` with a runtime validator, and downstream packages can import and construct them.

**Packages touched:** `shared-types` (models + Zod schemas), `diagram-ast` (builder API + validator per Volume 04 Deliverables), `shape-intelligence` (Shape Graph schema per Volume 14).

**Models to implement (each as a TS type + Zod schema in `shared-types`, per Volume 12 §Common Models):**
- `IntentModel` (Volume 03: intent, domain, diagram category)
- `VisualPlan` (Volume 03: objects, labels, highlights, animations, level of detail — no geometry)
- `VIL` document (Volume 13: version, intent, subject, context, objects, relationships, annotations, emphasis, metadata)
- `ShapeGraph` (Volume 10, 14: nodes, edges, no geometry; node = id/type/category/role/metadata/behaviors/anchors/constraints)
- `DiagramAST` (Volume 04: id, version, subject, title, objects, relationships, groups, annotations, metadata; object = id/type/name/category/properties/anchors/behaviors/labels/children)
- `ConstraintGraph` (Volume 05: nodes = objects, edges = constraints; constraint types: position/alignment/containment/connectivity/distribution/rotation/orientation/spacing/scaling/visibility)
- `LayoutModel` (Volume 05: coordinates, dimensions, rotation, bounding boxes, connector paths — the *only* model allowed to contain geometry, per Global Constraints)
- `StrokeAST` (Volume 06: id/type/target object/order/dependencies/style/timing/metadata per stroke; stroke types: line/curve/arc/circle/ellipse/rectangle/polygon/freehand/arrow/text/hatch/erase)
- `RuntimeEvent` union (Volume 09, 12, 16: PipelineStarted/StageStarted/StageCompleted/ValidationFailed/StrokeStarted/StrokeCompleted/RenderingFinished/SessionStarted/SessionCompleted/SessionFailed/PlaybackPaused, etc.)

**Validation layer:** every model gets a `validate<Model>(input: unknown): Result<Model, ValidationError[]>` function per Volume 04 §Validation Rules / Volume 17. `ValidationError` shape (per Volume 12 §Error Contracts): `{ code, message, package, stage, recoverable }`.

**Diagram AST builder API:** fluent/programmatic builder in `diagram-ast` package per Volume 04 Deliverables item 5, so Phase 3's Diagram Reasoner doesn't hand-construct raw objects.

**Acceptance criteria:**
- [ ] Every model above exists as an exported TS type + Zod schema in `@sketchmind/shared-types`, and nowhere else (enforces "no duplicate models across packages").
- [ ] `diagram-ast` exposes `buildDiagramAST(...)` and `validateDiagramAST(...)`; round-tripping a hand-built AST through both produces no errors.
- [ ] `shape-intelligence` exposes `validateShapeGraph(...)` implementing Volume 14 §Validation (connected graph, valid constraints, required nodes/anchors).
- [ ] Contract tests in root `tests/` prove: an AST with a duplicate id fails validation; an AST with an orphan object fails validation; a Shape Graph with an unknown constraint type fails validation — matching Volume 04 §Validation Rules and Volume 14 §Validation.
- [ ] No model contains geometry except `LayoutModel` (a static test/lint rule asserting no `x`/`y`/`width`/`height`/`rotation` fields exist on `DiagramAST`, `ShapeGraph`, or `ConstraintGraph` types is worth adding here).

**Before starting:** run `superpowers:writing-plans` again to turn the model list above into bite-sized TDD tasks per model, now that Phase 1's real package skeletons exist to build against.

---

## Phase 3 — AI Layer

**Maps to:** Volume 03 (AI Reasoning Engine), Volume 10 (Shape Intelligence Engine), Volume 15 (Prompt Contracts), Volume 09 (Orchestration, partial), Volume 18 Phase 3.

**Deliverable:** "Natural language → Diagram AST" — a real, working (if minimal) path from a text request through one live LLM provider to a validated `DiagramAST`.

**Packages touched:** `intent-analyzer`, `visual-planner`, `shape-intelligence`, `diagram-reasoner`, `ai-orchestrator` (provider adapters + prompt repository only — full orchestration is Phase 8).

**Agent contracts to implement (exact input/output per Volume 12 §Core Package Contracts and Volume 15 §Agent Contracts):**
- `intent-analyzer`: `analyze(text: string): IntentModel` — never returns graphics.
- `visual-planner`: `plan(intent: IntentModel): VisualPlan` — decides what should appear only.
- `shape-intelligence`: `reason(plan: VisualPlan): ShapeGraph` (+ any newly generated `PrimitiveDefinition`s per Volume 10 §Primitive Generation) — reasons about structure only; must first attempt primitive discovery against the registry before generating new primitives (Volume 10 §Primitive Discovery).
- `diagram-reasoner`: `compose(graph: ShapeGraph): DiagramAST` — must not produce coordinates.

**Prompt repository (`ai-orchestrator`, per Volume 15 Deliverables):** one versioned prompt module per agent above, each following the Standard Prompt Template (System Instructions, Agent Objective, Allowed Inputs, Expected Output, Forbidden Output, Completion Rules) and shipping few-shot examples (minimum, complex, invalid, recovery) per Volume 15 §Few-shot Examples.

**Provider abstraction:** a single `LLMProvider` interface in `ai-orchestrator` with one concrete adapter wired live for the MVP (pick one of OpenAI/Anthropic/Gemini) and stub adapters for the others satisfying the same interface, so swapping providers later requires no changes outside the adapter (Volume 03 §Multi-LLM Support, Volume 09 §Provider Abstraction).

**Retry strategy:** retry only AI stages, only on schema-invalid / missing-fields / empty-response / provider-timeout (Volume 15 §Retry Strategy) — implement as a wrapper around each agent call, not inside the agents themselves.

**Acceptance criteria:**
- [ ] Given `"Draw a movable pulley."`, the pipeline `intent-analyzer → visual-planner → shape-intelligence → diagram-reasoner` produces a `DiagramAST` containing at minimum the objects listed in Volume 01/02/03's worked example (ceiling, fixed pulley, movable pulley, rope, load) and passes `validateDiagramAST` from Phase 2.
- [ ] Every agent's output is validated against its Zod schema before being passed to the next agent; a deliberately malformed provider response triggers exactly one retry then a structured, recoverable error (Volume 15 §Retry Strategy, Volume 12 §Error Contracts).
- [ ] No agent output contains an `x`, `y`, `svg`, or `canvasCommand` field (automated schema-level check, enforcing Volume 03/13/15's "AI never produces geometry" rule).
- [ ] Swapping the wired provider adapter for a stub adapter (same interface) does not require changes to `intent-analyzer`, `visual-planner`, `shape-intelligence`, or `diagram-reasoner`.

**Before starting:** write a dedicated Phase 3 plan; it will need real decisions this document intentionally defers — which LLM provider is "live" for MVP, and the exact prompt text for each agent (Volume 15 leaves prompt content to implementation, only the contract).

---

## Phase 4 — Layout Engine

**Maps to:** Volume 05 (Constraint Engine & Layout Solver), Volume 18 Phase 4.

**Deliverable:** "Diagram AST → Layout Model" — deterministic, geometry-producing, no AI involved.

**Packages touched:** `constraint-engine`, `layout-engine`.

**Pipeline:** `DiagramAST → (constraint-engine) → ConstraintGraph → (layout-engine) → LayoutModel`.

**`constraint-engine` responsibilities (Volume 05 §Constraint Engine Responsibilities):** derive constraints (above/below/inside/outside/attachedTo/connectedTo/wrapsAround/centeredOn/alignedWith/parallelTo/perpendicularTo) from `DiagramAST.relationships`; produce zero geometry.

**`layout-engine` responsibilities (Volume 05 §Layout Solver Responsibilities, §Layout Strategies):** consume `ConstraintGraph`, produce `LayoutModel` (position/size/rotation/bounding box/connection points per object). Implement at least 2 layout strategies for MVP (e.g. Hierarchical + Grid) selected by diagram type, with the strategy interface open for the rest (Radial/Tree/Flow/Circular/Force-directed/Manual override) to be added later without touching the engine core.

**Sub-systems required by acceptance criteria below:** collision detection (object/label/connector overlap → auto-resolve), label placement (avoid overlaps, stay near target, readable), connector routing (straight minimum for MVP; orthogonal/curved/smart-avoidance are extensible, not required for MVP per Volume 05 + Volume 18 MVP Scope).

**Acceptance criteria:**
- [ ] Feeding the pulley `DiagramAST` from Phase 3 through `constraint-engine` then `layout-engine` produces a `LayoutModel` where no two objects' bounding boxes overlap and every object referenced in a relationship has a computed position (Volume 05 §Validation).
- [ ] The same `DiagramAST` input always produces the same `LayoutModel` output (determinism — Volume 05 Design Goals, Volume 02 §Expected Behavior).
- [ ] Layout strategy selection is driven by diagram type/metadata, not hardcoded per call site.
- [ ] `LayoutModel` is the only model in the system with numeric coordinates (cross-checked against the Phase 2 no-geometry-elsewhere rule).

---

## Phase 5 — Stroke Engine

**Maps to:** Volume 06 (Stroke Engine & Human Drawing Simulation), Volume 18 Phase 5.

**Deliverable:** "Layout Model → Animated Stroke AST" — a natural, human-like drawing order with playback control, still renderer-independent.

**Packages touched:** `stroke-planner`, `stroke-runtime`.

**`stroke-planner` responsibilities (Volume 06 §Stroke Planner, §Human Drawing Rules):** convert `LayoutModel` into an ordered `StrokeAST` following: large outlines before detail, labels last, connected objects drawn continuously, no unnatural pen jumps, predictable ordering. Then a **Stroke Optimizer** pass (Volume 06 §Stroke Optimizer) merges compatible strokes and removes redundancy without changing semantic meaning.

**`stroke-runtime` responsibilities (Volume 06 §Stroke Runtime, §Playback State from Volume 16):** play/pause/resume/seek/replay/undo/redo/cancel, backed by a timeline model supporting delay/duration/speed/pause/dependency per stroke (Volume 06 §Stroke Timing). Support incremental/progressive rendering hooks (Volume 06 §Incremental Rendering) even though no renderer is wired until Phase 6.

**Editing API (Volume 06 §Editing):** insert/delete/move/replace/reorder stroke, all deterministic.

**Acceptance criteria:**
- [ ] The pulley `LayoutModel` from Phase 4 produces a `StrokeAST` whose order matches the documented example shape (ceiling → pulleys → rope → load → force arrow → labels last), or an equivalently justified natural order if the object set differs.
- [ ] `stroke-runtime` can play, pause mid-sequence, resume, and replay the same `StrokeAST` deterministically (same strokes, same order, same timing) across runs.
- [ ] Undo removes exactly the last applied stroke and redo restores it, with no side effects on unrelated strokes.
- [ ] The Stroke Optimizer never changes which objects exist or their relationships — only stroke count/grouping (verify by diffing the pre/post-optimization object coverage, not just stroke count).

---

## Phase 6 — Renderer

**Maps to:** Volume 08 (Renderer SDK & Multi-Backend Rendering), Volume 18 Phase 6.

**Deliverable:** "Animated whiteboard rendering" — the first real pixels, via Konva, driven purely by `stroke-runtime` playback events.

**Packages touched:** `renderer-core` (SDK/adapter contract, layer manager, viewport, hit-testing, registry — backend agnostic), `renderer-konva` (first concrete backend).

**`renderer-core` responsibilities (Volume 08 §Renderer Adapter, §Layer Model, §Viewport, §Hit Testing):** define the adapter interface (`initialize/destroy/drawStroke/eraseStroke/updateStroke/renderFrame/resizeViewport/export`) and layer model (Background/Grid/Shapes/Connectors/Labels/Highlights/Animations/Debug) that every backend implements identically.

**`renderer-konva` responsibilities:** implement the `renderer-core` adapter interface against Konva; must reject any responsibility outside Volume 08's "must NOT" list (no AI calls, no layout computation, no Stroke AST mutation, no business rules).

**Export (MVP subset per Volume 18 MVP Scope "Export"):** PNG at minimum; SVG/PDF/JSON/replay-package are extensible follow-ons per Volume 08 §Export, not required to close this phase.

**Acceptance criteria:**
- [ ] `renderer-konva` correctly initializes, draws every stroke from the Phase 5 pulley `StrokeAST` in order, and matches a checked-in reference PNG within a defined pixel-diff tolerance (Volume 17 §Snapshot Testing "Final Render").
- [ ] Play/pause/resume from `stroke-runtime` visibly starts/stops/continues progressive drawing in `apps/playground`.
- [ ] `renderer-konva` contains zero imports from `ai-orchestrator`, `intent-analyzer`, `visual-planner`, `shape-intelligence`, `diagram-reasoner`, `constraint-engine`, or `layout-engine` (lint-enforced via the dependency-direction rule from Phase 1).
- [ ] Export to PNG produces a file; re-importing/inspecting it confirms all drawn objects are present.
- [ ] Manually verified in `apps/playground` per the `run` skill: start the dev server, drive a real request through the pipeline, and watch it draw.

---

## Phase 7 — Plugin System

**Maps to:** Volume 07 (Educational Primitive SDK & Plugin System), Volume 18 Phase 7.

**Deliverable:** "External primitives load without modifying the core."

**Packages touched:** `primitive-sdk`, `plugin-sdk`.

**`primitive-sdk` responsibilities (Volume 07 §Primitive Package, §Manifest, §Primitive Registry):** manifest schema (id/name/version/category/author/license/dependencies/supportedRenderers/supportedBehaviors), package validation pipeline (manifest/schema/anchors/behaviors/constraints/examples — invalid primitives must not load), and a registry (register/resolve versions/discover/validate dependencies/load).

**`plugin-sdk` responsibilities (Volume 07 §Plugin System, §Subject Packs):** generic plugin loading (register/discover/lazy-load/hot-reload where feasible) for the plugin categories Volume 07 lists — subject packs, primitive packs, renderers, layout strategies, stroke generators, exporters — all communicating through public interfaces only.

**Acceptance criteria:**
- [ ] A hand-authored example primitive package (e.g. "Gear", per Volume 10's worked example) registers via `primitive-sdk` without any change to `diagram-ast`, `constraint-engine`, `layout-engine`, `stroke-planner`, or any renderer package.
- [ ] `shape-intelligence`'s primitive-discovery step (Phase 3) finds and reuses the example primitive instead of generating a new one when the same concept is requested twice — proving Volume 10 §Primitive Discovery's "search registry before generating" rule actually closes the loop with the SDK built here.
- [ ] An intentionally invalid primitive package (missing required anchor) is rejected at load time with a structured error, never reaching the registry.
- [ ] `renderer-konva` (Phase 6) can be loaded through the same `plugin-sdk` registration path used for the example primitive, proving the plugin mechanism is renderer-agnostic as required (Volume 07 "Do not couple plugins to renderer implementations").

---

## Phase 8 — End-to-End Integration

**Maps to:** Volume 09 (AI Drawing Pipeline & Orchestration, full), Volume 16 (Runtime State Management), Volume 17 (Testing/QA, system-level), Volume 18 Phase 8.

**Deliverable:** the full pipeline — `AI → Layout → Stroke → Renderer` — connected end to end through `ai-orchestrator`, driven by real runtime state, observable, and validated.

**Packages touched:** `ai-orchestrator` (now the full orchestrator, not just provider adapters/prompts from Phase 3), all packages as integration participants.

**Work not covered by earlier phases, now required (Volume 09, 16):**
- Pipeline Orchestrator running the full 9-stage sequence (Volume 09 §Pipeline Stages) with a validation gate after every stage (Volume 09 §Validation Gates) — this is the first point where Phase 2's validators, Phase 3's agents, Phase 4's engines, Phase 5's stroke engine, and Phase 6's renderer are all invoked in one call.
- Session / Execution Context / Pipeline State / Drawing State / Playback State / Renderer State as distinct, non-merged runtime models (Volume 16 §Core Runtime Models), each serializable.
- Checkpointing after Intent Analysis, Diagram AST, Layout Model, Stroke AST, with resume-from-latest-valid-checkpoint (Volume 16 §Checkpoints).
- Typed event bus streaming stage/stroke/session lifecycle events end to end (Volume 09 §Streaming, Volume 16 §Event Bus) — this is what `apps/playground` subscribes to for live progress UI.
- Cancellation that stops AI stages and rendering and releases resources without corrupting state (Volume 16 §Cancellation).
- Caching (Intent Analysis, Diagram AST, Primitive Resolution, Layout, Stroke AST) keyed by model version (Volume 09 §Caching).
- Observability: stage duration, token usage, cache hits, retry count, validation failures, rendering time/FPS, memory (Volume 09 §Observability, Volume 16 §Observability) exposed through public interfaces.

**Acceptance criteria — this is the MVP finish line (Volume 18 §Acceptance Criteria, §Definition of Done):**
- [ ] A single call — `"Explain a movable pulley."` into `ai-orchestrator` — produces a valid `DiagramAST`, computes layout, animates the drawing in `apps/playground` via `renderer-konva`, and completes without manual intervention.
- [ ] The same request replayed from a checkpoint (e.g. resuming after Diagram AST) produces an equivalent final render.
- [ ] Undo/redo works against the live orchestrated session, not just the isolated `stroke-runtime` unit tests from Phase 5.
- [ ] Export (PNG at minimum) works from the orchestrated session.
- [ ] Cancelling mid-pipeline stops AI calls and rendering promptly and leaves no dangling session state.
- [ ] All package unit tests, root-level contract tests, and a new root-level system test for this full flow pass in CI (Volume 17 §Continuous Quality Gates).
- [ ] Benchmarks (AI latency, layout time, stroke generation time, render time/FPS) are collected and within whatever thresholds the team sets, per Volume 17 §Performance Benchmarks.

---

## Self-Review Notes

- **Spec coverage:** every Volume 01–18 concept maps to at least one phase/task above; Volume 01 (product vision) and Volume 02 (architecture) are covered as the framing/global constraints rather than a standalone phase, since they define principles enforced throughout, not a deliverable of their own.
- **Deferred-by-design gaps:** Phases 2–8 intentionally stop short of bite-sized code steps (see Scope Note) — this is not an oversight, it's because the docs themselves leave exact schema field types, prompt text, and provider choice to implementation, and pre-committing those now would likely be thrown away.
- **Type consistency:** package names, model names (`IntentModel`, `VisualPlan`, `VIL`, `ShapeGraph`, `DiagramAST`, `ConstraintGraph`, `LayoutModel`, `StrokeAST`, `RuntimeEvent`), and stage order are used identically across all phases and match Volume 12 §Common Models exactly.
