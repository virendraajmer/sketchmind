# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SketchMind: an AI agent that reasons about a diagram request and draws it stroke-by-stroke,
like a human at a whiteboard. Pipeline: NL intent → visual plan → shape graph → diagram AST →
constraint graph → layout model → stroke AST → rendered canvas (Konva/SVG). Two agent loci share
one loop: a server agent (drives the pipeline) and a client agent (drives the rendered canvas),
both built on `agent-core`.

Full design lives in `docs/SketchMind_Volume_*.md` (01–18). The authoritative build order and
day-to-day decisions are in `docs/superpowers/plans/2026-08-05-sketchmind-implementation-plan.md`
— check its "Global Constraints" and "Package Map" sections before making cross-package changes.

## Commands

pnpm workspace + turbo, run from repo root:

```
pnpm build              # turbo run build (all packages, dependency-ordered)
pnpm lint               # check:layering + turbo run lint (eslint)
pnpm check:layering     # node scripts/check-layering.mjs — dependency-direction check only
pnpm typecheck          # turbo run typecheck
pnpm test               # turbo run test (vitest, per package)
pnpm dev                # turbo run dev --parallel (apps/studio + apps/api)
```

Per-package, from that package's directory (or `pnpm --filter @sketchmind/<name> run <script>`):

```
pnpm test                                   # vitest run
pnpm exec vitest run <file>                 # single test file
pnpm exec vitest run -t "<test name>"       # single test by name
```

`apps/api`: `pnpm dev` runs `tsx watch --env-file=.env src/server.ts`. `apps/studio`: `pnpm dev` runs
Vite on :5173. `apps/web` (Next.js) was removed once `apps/studio` reached parity.

Scaffolding a new package: `node scripts/scaffold-package.mjs <name> "<responsibility>"` (never
overwrites; `--all` scaffolds the full Phase 1 set). See `.claude/skills/scaffold-package/` for
the full workflow including layer registration.

## Architecture

**Monorepo layout:** `apps/` (studio, api — consume packages, no reusable logic), `packages/`
(everything else), `tests/` (root-level contract/integration/system tests only — unit tests live
in each package's own `tests/`), `docs/`, `scripts/` (CI + repo automation), `tools/` (dev-only,
unpublished generators), `configs/` (centralized config, injected via DI — packages never read
`process.env` directly, except `llm-provider-azure-openai`).

**One-way dependency layering**, enforced by `scripts/check-layering.mjs` (not eslint —
package-level layering isn't visible to `import/no-cycle`, and reading manifests is ~1000x
faster than full TS resolution):

```
apps (studio, api)
  → agent-orchestrator (ai-orchestrator)
  → tools (agent-tools-reasoning, agent-tools-geometry, agent-tools-canvas)
  → agent (agent-core, agent-memory, agent-vision)
  → core (intent-analyzer, visual-planner, shape-intelligence, diagram-reasoner, diagram-ast,
          constraint-engine, layout-engine, stroke-planner, stroke-runtime, primitive-sdk,
          plugin-sdk, export-engine, session-protocol)
  → renderer (renderer-core, renderer-konva, renderer-svg)
  → provider (llm-provider, llm-provider-azure-openai, llm-provider-anthropic)
  → foundation (shared-types, utilities)
```

A package may depend on its own layer or anything below; never upward. New packages must be added
to the `LAYERS` list in `scripts/check-layering.mjs` or CI fails. Shared models live only in
`shared-types` — never duplicated elsewhere. Within a package, only `src/index.ts` (the public
API) is importable from outside; `src/internal/**` is private and eslint-enforced.

Note `tools` sits **above** `agent`, which reads backwards against the plan's "Applications → Agent
→ Tools → Core" until you notice that chain is call flow, not imports. `agent-core` deliberately
knows nothing about any tool package; every tool package needs `defineTool` from it.

**The four pipeline models stay separate** and never blur: Diagram AST (semantic, no coordinates),
Constraint Graph (relationships), Layout Model (the *only* model allowed numeric geometry), Stroke
AST (drawing sequence). No AI component ever outputs coordinates, SVG, or Konva commands directly
— only structured JSON validated against a schema before use.

**LLM independence is a hard, CI-enforced requirement.** All model access goes through the
`LLMProvider` interface in `packages/llm-provider`; provider SDKs (`openai`, `@azure/*`,
`@anthropic-ai/*`, `@google/*`) are physically un-importable outside `packages/llm-provider-*` via
an eslint `no-restricted-imports` rule. Callers branch on capability flags, never provider name.
Adding a provider means one new `llm-provider-*` package plus one config value — nothing else
changes. Two adapters (`llm-provider-azure-openai`, `llm-provider-anthropic`) exist specifically to
prove the abstraction isn't secretly shaped around one vendor.

**Agent loci:** both the server agent and client agent share one loop (`agent-core`) and one tool
format. Every run is bounded (max steps, max tokens, wall-clock timeout, cancellation token) and
every step is traced and streamed to the UI. LLM credentials exist only server-side; the client
agent's LLM turns proxy through `apps/api`, and client tool calls with server-side effects are
re-validated and authorized server-side — full autonomy on the client is never trusted on the wire.

**The renderer is a pure execution layer, and `renderer-core` holds most of it.** Backends
(`renderer-konva`, `renderer-svg`) only know how to put an already-computed polyline on a surface;
the layer model, viewport transform, jitter synthesis, tone resolution, hit-testing and
stroke→geometry conversion all live in `renderer-core`, which is what makes the two backends draw
the same picture rather than a similar one. Because `renderer` sits *below* `core`, a backend
cannot import `stroke-runtime`; `RenderFrame` and `DrawingFrame` were hand-written twins for that
reason until Phase 9 put the frame on the wire and both became aliases of `DrawingFrameSchema` in
`shared-types` — `tests/render-pipeline.test.ts` still asserts the assignment, now as a guard
against either package reintroducing a local copy. The viewport is the only place pixels enter the
system: a pointer event goes through `viewport().toWorld()` before anything semantic reads it.

**The session is one agent run, streamed.** `apps/api` registers reasoning, geometry and memory
tools into a single `ToolRegistry` and makes one `runAgent` call across all three — not a reasoning
phase then a geometry phase, because AD-1 means the model decides which stages a request needs.
Each step becomes a `RuntimeEvent` (the same union the stroke runtime emits; `session-protocol`
re-exports it rather than declaring a wire twin) framed as SSE. Events are buffered per session, so
a browser that opens the stream after the agent has started still sees the run from the beginning.
One `AbortController` per session is the whole cancellation story: it reaches the provider call,
every `ToolContext`, and the playback pump.

**Module resolution:** `tsconfig.base.json` uses `NodeNext`/`NodeNext`, not `Bundler` — required
so `dist/` is loadable by plain `node`, not just by a bundler-aware test runner. `apps/studio`
overrides back to `Bundler` because Vite requires it.

**Headless rendering in tests:** Konva rasterises under Node via `konva/canvas-backend` +
`node-canvas`, wired through `setupFiles` in `packages/renderer-konva/vitest.config.ts` and
`tests/vitest.config.ts`. Render assertions therefore decode real PNG bytes. `canvas` is a
devDependency only and is listed in `onlyBuiltDependencies` in `pnpm-workspace.yaml` (pnpm 10 no
longer reads that field from `package.json`).

## Project status

Phases 1–10 complete (repo foundation, core models, LLM provider abstraction, agent-core +
agent-memory, reasoning tools, constraint-engine + layout-engine, stroke-planner + stroke-runtime,
renderer-core + renderer-konva + renderer-svg + export-engine, the vertical slice: session-protocol
+ agent-tools-geometry + `apps/api` + `apps/web`, since replaced by `apps/studio`), and vision
self-correction with geometric and
visual critique tiers and a client-side vision agent). Phase 11 (client agent full autonomy) is next.
See the implementation plan doc for phase-by-phase scope and acceptance criteria before starting new
package work, plus `docs/superpowers/plans/2026-08-05-phase-5-reasoning-tools.md` for the decisions
Phase 5 settled (prompt templates as data, the geometry guard, `ReasoningWorkspace`),
`docs/superpowers/plans/2026-08-05-phase-6-layout-engine.md` for Phase 6's (the `intersects` overlap
exemption, the two-pass box-model solver, why collision resolution needs no ancestor exemption,
perimeter-only anchor resolution), `docs/superpowers/plans/2026-08-05-phase-7-stroke-engine.md` for
Phase 7's (semantic five-phase drawing order rather than nearest-neighbour, the generator registry,
exact points with jitter left to the renderer, the optimizer's object-coverage invariant, a timer-free
runtime), `docs/superpowers/plans/2026-08-05-phase-8-renderer.md` for Phase 8's (core owns everything
that is not backend-specific, `RenderFrame` as a structural contract, jitter seeded from the stroke id,
geometric hit-testing, the idempotent frame diff, a text-free pixel baseline, headless Konva),
`docs/superpowers/plans/2026-08-05-phase-9-web-app.md` for Phase 9's (reusing `RuntimeEvent` as the
wire contract, `DrawingFrame` becoming a real schema, why the geometry tools have no geometry guard
and show the model no geometry, event buffering, one AbortController, the validating LLM proxy, and
`pnpm check:bundle`), and `docs/superpowers/specs/2026-08-06-phase-10-vision-self-correction-design.md`
for Phase 10's (the geometric and visual critique tiers, the three-way vision gating, why the vision
agent belongs on the client and only critique happens server-side, provider-role resolution for
vision-capable models).
