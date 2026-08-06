# SketchMind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build SketchMind — a fully autonomous agentic sketch engine. A user asks for anything; an AI agent reasons out what it is, draws it on a whiteboard stroke by stroke like a teacher, looks at what it drew, fixes what's wrong, and remembers what it learned. Web frontend for real use. Agents on both server and client, both free to act. LLM fully swappable (Azure OpenAI / AI Foundry first).

**Architecture:** One agent brain, two tool surfaces, wrapped around a deterministic geometry/rendering core.

```
        ┌─────────────────── apps/web (browser) ────────────────────┐
        │  Session Agent (client locus)                             │
        │     └─ canvas tools ─▶ Renderer + Stroke Runtime          │
        └──────────▲───────────────────────────┬────────────────────┘
                   │ session protocol (SSE)     │ LLM calls proxied
                   │ shared session memory      │ (no keys in browser)
        ┌──────────┴───────────────────────────▼────────────────────┐
        │                    apps/api (server)                      │
        │  Session Agent (server locus)                             │
        │     └─ reasoning tools ─▶ intent · plan · shape · AST     │
        │     └─ geometry tools  ─▶ constraints · layout · strokes  │
        │     └─ vision tools    ─▶ render · SEE · critique · fix   │
        │     └─ memory tools    ─▶ recall · learn · register       │
        └───────────────────────────┬───────────────────────────────┘
                                    │
                          LLMProvider interface
                                    │
              ┌─────────────────────┼─────────────────────┐
        Azure OpenAI            Anthropic            Gemini / local
        (AI Foundry)            (adapter)              (adapter)
```

The LLM produces structured JSON reasoning and tool calls only — never coordinates, SVG, or canvas commands. Geometry, layout, stroke planning, and rendering stay deterministic. The agent *drives* that machinery through tools; it does not replace it.

**Tech Stack:** TypeScript monorepo (pnpm 10 workspaces + Turborepo), Vitest, Zod, Konva renderer, Next.js `apps/web`, Fastify `apps/api`, Azure OpenAI via AI Foundry (`openai` SDK's `AzureOpenAI` client), SSE streaming. Verified locally: Node 22.18, pnpm 10.27, git 2.47.

---

## Architectural Decisions (deviations from Volumes 01–18)

The requirement docs describe a **fixed linear pipeline with halting validation gates**. That design predates practical tool-calling agents and actively fights the goal of a fully autonomous system. The following decisions supersede the docs where they conflict. Everything not listed here still follows the volumes.

### AD-1 — Pipeline stages become agent tools, not a fixed chain

**Docs say** (V09): nine stages execute in strict order, every time.
**Change:** every stage is exposed as a tool the agent may call, skip, reorder, or repeat. The agent chooses depth based on the request.
**Why:** "Draw a circle" does not need Intent Analysis → Visual Planning → Shape Reasoning → Diagram Composition as four separate LLM round trips. That's four times the latency, four times the cost, and three extra chances to drift. A capable model composes a trivial AST in one call. Meanwhile "draw a hydraulic press" genuinely needs all four *plus* iteration. Fixed depth serves neither.
**Kept from docs:** the stages themselves, their contracts, and their single responsibilities. They're excellent decomposition — just wrong as a mandatory sequence.

### AD-2 — Validation failures are observations, not halts

**Docs say** (V09, V17): "Invalid output must stop the pipeline."
**Change:** validation errors return to the agent as structured tool results it can act on. Only genuinely unrecoverable conditions (provider auth failure, corrupt runtime state) halt.
**Why:** halting is right for a dumb pipeline and wrong for an agent. "Your AST has an orphan object at `rope_2`" is *exactly* the feedback an agent can fix in one step. Throwing it away and failing the request wastes the most useful signal in the system. This is the single biggest robustness win available.

### AD-3 — The agent sees what it drew (vision self-correction)

**Docs say:** nothing. No volume mentions the agent observing rendered output.
**Change:** the agent critiques its own drawing and fixes it — rope not meeting the pulley, label overlapping a component, diagram unbalanced.
**Why:** constraint solvers catch overlap; they cannot catch "this doesn't look like a pulley system." A system that can draw anything but can't tell whether it worked isn't autonomous — it's just fast.

**Revised 2026-08-05 — two tiers, image tier off by default.**

Self-correction splits into two independent tiers, and only the first ships enabled:

| Tier | Input | Cost | Default |
|---|---|---|---|
| **Geometric critique** | `LayoutModel` + `StrokeAST` as JSON | Zero tokens, ~ms, deterministic | **On** |
| **Visual critique** | Rendered PNG | Tokens + latency per round | **Off** |

The geometric tier is pure software reading the models the pipeline already produced: label/object overlap, out-of-bounds elements, connector crossings, endpoints that don't meet their anchors, degenerate sizes, unbalanced whitespace. It emits the same structured `fix proposals` the visual tier would, so the agent's repair loop is identical either way. It is deterministic, free, and catches most of what actually goes wrong.

The visual tier catches the residue — "this doesn't read as a pulley system" — which no amount of geometry inspection can see. It stays behind `AZURE_OPENAI_VISION_DEPLOYMENT`, blank by default, and is switched on without code changes when the token and latency cost is worth paying.

This is a deliberate ordering, not a cut: build the free tier first, measure what still slips through, then decide whether the paid tier earns its cost on real output.

### AD-4 — One session agent with two tool surfaces, not two agents

**Docs say:** N/A (agents weren't in scope).
**Change:** a single agent identity with shared session memory. Tools are annotated with an execution *locus* (`server` | `client`); the transport routes accordingly. The browser hosts the same `agent-core` loop.
**Why:** two agents with separate brains have to negotiate, and they will disagree about diagram state. One agent that happens to have hands in two places has no such problem. Interaction-latency tools (highlight, zoom, select) execute locally without a round trip; reasoning-heavy turns proxy to the server.

### AD-5 — Freeform composition alongside registered primitives

**Docs say** (V07, V10): everything is a versioned primitive package with manifest, anchors, behaviors, constraints, examples.
**Change:** add a freeform path where the agent composes from geometric sub-primitives (arc, polyline, curve, ellipse) with constraints — no manifest ceremony. Promotion to a full registered primitive happens only when a shape proves reusable.
**Why:** the docs' primitive system is genuinely good for *recurring* objects. But requiring a full package for every one-off would stall "draw a nephron" on registration bureaucracy. "Draw anything" needs an escape hatch. Promote-on-reuse gets both.

### AD-6 — Determinism redefined honestly

**Docs say** (V02): "The same request should always produce equivalent diagrams."
**Change:** determinism is guaranteed for the deterministic half — the same `DiagramAST` always yields the same layout, strokes, and pixels. Agent *reasoning* is not deterministic, and pretending otherwise is a lie. Practical repeatability comes from caching: a repeated request reuses the cached AST.
**Why:** an autonomous agent exploring a solution space is inherently non-deterministic. The docs' requirement is unachievable as literally stated; this resolves it without weakening the part that actually matters for testing (snapshot tests target the deterministic stages).

### AD-7 — Persistent agent memory with semantic recall

**Docs say** (V10): primitives are "learned" and stored.
**Change:** make this real — a persisted store with vector/semantic search over learned primitives and past sessions, exposed as `recall` / `learn` tools.
**Why:** V10's learning loop is the mechanism by which the system gets better at "anything" over time, but the docs leave it as an aspiration. Without semantic recall, "draw a nephron" won't match a stored "kidney nephron unit" and the system relearns forever.

### AD-8 — Client agent: full autonomy, hard safety rails

**Per your direction:** no permission prompts, no capability allowlist, no escalation gates. The client agent annotates, erases, redraws, re-lays-out, invents components, and extends diagrams on its own initiative.
**Retained:** step budget, token budget, wall-clock timeout, cancellation token, and full step tracing. These bound *cost and liveness*, never *decisions*. An agent that cannot be cancelled or observed isn't autonomous — it's unowned, and it will eventually cost you money at 3am.

### AD-9 — Azure OpenAI: target the v1 API surface, no `api-version`

**Docs said:** verify the API version at implementation time; assumed `AzureOpenAI` client + `api-version` query param, chat-completions shaped.
**What the deployment settled it:** the Azure AI Foundry playground sample for the live deployment (`gpt-5.6-luna`) uses the stock `OpenAI` client with a `baseURL` ending `/openai/v1`, no `api-version` anywhere, and calls the Responses API (`client.responses.create` / `.stream`) rather than Chat Completions. This is Azure's v1 API surface, GA since August 2025.
**Change:** `llm-provider-azure-openai` never models `api-version` — not as a required field, not as an optional one left blank. `AZURE_OPENAI_API_VERSION` does not exist in `.env.example`; the config surface is `AZURE_OPENAI_BASE_URL` (normalized up to `/openai/v1`, accepting the bare resource endpoint the portal shows) + `AZURE_OPENAI_DEPLOYMENT` + one credential (API key or Entra, never both). Auth uses `getBearerTokenProvider(new DefaultAzureCredential(), "https://ai.azure.com/.default")` passed as `apiKey` — the v1 client refreshes the token itself, so `AzureOpenAI` is no longer needed for the Entra path either.
**Why:** a variable that must be left empty is a variable someone eventually fills in wrongly. Building against the sample the deployment actually emits, rather than the docs' assumption, is also why Phase 3 added `llm-provider-anthropic` in the same phase instead of deferring it — a second provider is what proves the interface in `types.ts` isn't secretly Azure-shaped (see `docs/superpowers/plans/2026-08-05-phase-3-llm-provider.md`, D-1–D-10).

---

## Global Constraints

Apply to every phase. Do not restate per task; do not violate.

**Structure & dependencies**
- Monorepo: `apps/`, `packages/`, `examples/`, `docs/`, `tools/`, `scripts/`, `tests/`, `configs/` (V11).
- One-way dependencies: `Applications → Agent → Tools → Core Packages → Renderer → External`. Never upward. No cycles.
- Shared models live **only** in `packages/shared-types`.
- Public APIs only across package boundaries; `internal/` is private (V12).
- The four models stay separate: Diagram AST (semantic), Constraint Graph (relationships), Layout Model (geometry), Stroke AST (drawing sequence) (V02).

**AI boundaries**
- No AI component outputs coordinates, SVG, canvas, or Konva commands. Structured JSON + tool calls only (V03, V13, V15).
- `LayoutModel` is the **only** model permitted numeric geometry.
- All LLM output is schema-validated before use — never trusted raw (V17).

**LLM independence (hard requirement)**
- All model access goes through `LLMProvider` in `packages/llm-provider`. No provider SDK, type, or config leaks anywhere else — including agent packages.
- New provider = one new `packages/llm-provider-*` + one config value. Nothing else changes.
- Callers branch on **capability flags**, never provider name.
- Azure OpenAI is first; a second adapter must always exist to prove the abstraction.

**Security**
- LLM credentials exist only on the server. Client agent LLM turns proxy through `apps/api`. No provider SDK in any browser bundle — CI-enforced.
- Client tool calls with server-side effects are validated and authorized server-side. Full autonomy is not the same as trusting the wire.

**Agents**
- Both loci share one loop (`agent-core`) and one tool-definition format.
- Every run bounded: max steps, max tokens, wall-clock timeout, cancellation token (AD-8).
- Every step traced (thought, tool, args, result, duration, tokens) and streamed to the UI.

**Testing** — every package ships unit tests; root `tests/` holds contract/integration/system tests (V11, V17).

---

## Scope Note

**Phase 1** below is fully detailed and bite-sized — start there. **Phases 2–12** are a firm roadmap with exact packages, responsibilities, and acceptance criteria; each gets its own `writing-plans` pass immediately before it starts, once the prior phase's interfaces are real code rather than spec prose.

Ordering front-loads a **working vertical slice at Phase 9** — type in a browser, watch it draw, with a real agent driving. Vision self-correction and full client autonomy build on top, because both need something that already draws.

---

## Package Map

| Package | Responsibility | Phase |
|---|---|---|
| `shared-types` | All shared models + Zod schemas. Depends on nothing. | 1–2 |
| `utilities` | Ids, Result types, logging shims. | 1 |
| `llm-provider` | `LLMProvider` interface, capability flags, structured-output fallback, retry. Zero SDK imports. | 3 |
| `llm-provider-azure-openai` | Azure / AI Foundry adapter. Only place Azure types exist. | 3 |
| `llm-provider-anthropic` | Second adapter, proves the abstraction. | 3 |
| **`agent-core`** | **Agent loop, tool registry, budgets, cancellation, tracing. Shared by both loci (AD-4).** | 4 |
| **`agent-memory`** | **Session memory + persisted learned-primitive store with semantic recall (AD-7).** | 4 |
| `intent-analyzer` | NL → `IntentModel`. Exposed as a tool. | 5 |
| `visual-planner` | `IntentModel` → `VisualPlan`. Tool. | 5 |
| `shape-intelligence` | `VisualPlan` → `ShapeGraph`, primitive discovery/generation. Tool. | 5 |
| `diagram-reasoner` | `ShapeGraph` → `DiagramAST`. Tool. | 5 |
| `diagram-ast` | Builder, validator, versioning, serialization. | 2 |
| `agent-tools-reasoning` | Wraps the four above as agent tools (AD-1). | 5 |
| `constraint-engine` | `DiagramAST` → `ConstraintGraph`. | 6 |
| `layout-engine` | `ConstraintGraph` → `LayoutModel`. Solver, collision, labels, routing. | 6 |
| `stroke-planner` | `LayoutModel` → `StrokeAST` + optimizer. Human drawing rules. | 7 |
| `stroke-runtime` | Playback: play/pause/seek/replay/undo/redo. Renderer-independent. | 7 |
| `renderer-core` | Adapter contract, layers, viewport, hit-testing, registry. | 8 |
| `renderer-konva` | First concrete backend. | 8 |
| `renderer-svg` | Skeleton — proves backend-agnosticism. | 8 |
| `export-engine` | PNG/SVG/PDF/JSON/replay export. | 8, 12 |
| `session-protocol` | Typed client↔server events, commands, agent traces. | 9 |
| `agent-tools-geometry` | Layout/stroke/render stages as tools. | 9 |
| **`agent-vision`** | **Canvas capture → multimodal critique → fix proposals (AD-3).** | 10 |
| `agent-tools-canvas` | Client tool surface: highlight, zoom, annotate, erase, redraw, select. | 11 |
| `primitive-sdk` | Manifest schema, validation, registry, freeform→registered promotion (AD-5). | 12 |
| `plugin-sdk` | Plugin loading: subject packs, primitives, renderers, strategies, exporters. | 12 |
| `ai-orchestrator` | Session lifecycle, checkpoints, caching, event bus, observability. | 12 |

**Apps:** `apps/web` (Next.js frontend + client agent locus), `apps/api` (Fastify server + server agent locus + LLM proxy).

---

## Phase 1 — Repository Foundation

**Deliverable:** monorepo builds, lints, and tests with real skeletons for every package and both apps, correct one-way dependencies, before any business logic.

### File Structure

```
sketchmind/
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  turbo.json
├── .eslintrc.cjs  .prettierrc  vitest.workspace.ts  .env.example
├── apps/{web,api}/
├── packages/            # 26 packages per the Package Map
└── examples/ docs/ tools/ scripts/ tests/ configs/
```

Every package: `package.json`, `tsconfig.json`, `src/index.ts` (public API), `src/internal/` (private), `tests/`, `README.md`.

### Task 1: Workspace root and tooling

**Files:** Create `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `turbo.json`, `.eslintrc.cjs`, `.prettierrc`, `vitest.workspace.ts`

**Interfaces:**
- Produces: root `build`, `lint`, `test`, `typecheck`, `dev` scripts used by every later task and phase to verify work.

- [ ] **Step 1: Write root `package.json`**

```json
{
  "name": "sketchmind",
  "private": true,
  "packageManager": "pnpm@10.27.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "dev": "turbo run dev --parallel"
  },
  "devDependencies": {
    "turbo": "^2.3.0",
    "typescript": "^5.7.0",
    "eslint": "^9.17.0",
    "@typescript-eslint/parser": "^8.18.0",
    "@typescript-eslint/eslint-plugin": "^8.18.0",
    "eslint-plugin-import": "^2.31.0",
    "prettier": "^3.4.0",
    "vitest": "^2.1.0"
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

Turbo 2.x renamed `pipeline` to `tasks`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "test": { "dependsOn": ["build"] },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

- [ ] **Step 5: Write `.eslintrc.cjs`**

```js
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "import"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  rules: {
    "import/no-cycle": "error",
    "no-restricted-imports": [
      "error",
      {
        "patterns": [
          {
            "group": ["**/internal/*"],
            "message": "Import a package's public API only (V12)."
          },
          {
            "group": ["openai", "@azure/*", "@anthropic-ai/*", "@google/*"],
            "message": "Provider SDKs may only be imported inside packages/llm-provider-* (Global Constraints: LLM independence)."
          }
        ]
      }
    ]
  },
  overrides: [
    { files: ["packages/llm-provider-*/**"], rules: { "no-restricted-imports": "off" } }
  ]
};
```

The second pattern group is the mechanical enforcement of LLM independence — provider SDKs become physically un-importable outside their adapter. This is what makes "swap any LLM anytime" a guarantee rather than an intention.

- [ ] **Step 6: Write `.prettierrc`**

```json
{ "semi": true, "singleQuote": false, "printWidth": 100 }
```

- [ ] **Step 7: Write `vitest.workspace.ts`**

```ts
import { defineWorkspace } from "vitest/config";

export default defineWorkspace(["packages/*", "apps/*"]);
```

- [ ] **Step 8: Install and verify**

Run: `pnpm install`
Expected: lockfile created, no errors.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json turbo.json .eslintrc.cjs .prettierrc vitest.workspace.ts pnpm-lock.yaml
git commit -m "chore: scaffold monorepo tooling (pnpm + turbo + eslint + vitest)"
```

### Task 2: `shared-types` package (leaf, no dependencies)

**Files:** Create `packages/shared-types/{package.json,tsconfig.json,src/index.ts,tests/index.test.ts,README.md}`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces: `PACKAGE_NAME` / `PACKAGE_VERSION` proving workspace resolution. Real models arrive in Phase 2; this task proves skeleton, build, and test wiring only.

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
Expected: FAIL — `src/index.ts` does not exist.

- [ ] **Step 3: Write the skeleton**

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

Canonical home for every model shared across SketchMind (IntentModel,
VisualPlan, VIL, ShapeGraph, DiagramAST, ConstraintGraph, LayoutModel,
StrokeAST, RuntimeEvent, AgentTrace, ToolDefinition). No other package
may redefine these (V11 §Shared Types, V12).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sketchmind/shared-types test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared-types
git commit -m "feat(shared-types): scaffold package skeleton"
```

### Task 3: Remaining package skeletons

**Files:** Create the same 5-file skeleton for `utilities`, `llm-provider`, `llm-provider-azure-openai`, `llm-provider-anthropic`, `agent-core`, `agent-memory`, `agent-vision`, `agent-tools-reasoning`, `agent-tools-geometry`, `agent-tools-canvas`, `intent-analyzer`, `visual-planner`, `shape-intelligence`, `diagram-reasoner`, `diagram-ast`, `constraint-engine`, `layout-engine`, `stroke-planner`, `stroke-runtime`, `renderer-core`, `renderer-konva`, `renderer-svg`, `export-engine`, `session-protocol`, `primitive-sdk`, `plugin-sdk`, `ai-orchestrator`.

**Interfaces:**
- Consumes: `@sketchmind/shared-types` as `workspace:*`.
- Produces: `PACKAGE_NAME` / `PACKAGE_VERSION` per package, so later phases build on packages that already compile, test, and lint.

- [ ] **Step 1: Write the failing test for one representative package (`agent-core`)**

`packages/agent-core/tests/index.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/index";

describe("agent-core package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/agent-core");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});
```

Repeat verbatim for every remaining package, swapping only the name string.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -r test`
Expected: FAIL for every new package — no `src/index.ts` yet.

- [ ] **Step 3: Scaffold each package**

For each `<name>`, create the four files from Task 2 Step 3 with `@sketchmind/<name>` substituted, plus:

```json
"dependencies": { "@sketchmind/shared-types": "workspace:*" }
```

Each `README.md` states that package's one-line responsibility from the Package Map table.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -r test`
Expected: PASS for all packages.

- [ ] **Step 5: Prove the LLM-independence guard actually bites**

Run: `pnpm run lint`
Expected: no cycle errors.

Then temporarily add `import OpenAI from "openai";` to `packages/agent-core/src/index.ts` and run `pnpm --filter @sketchmind/agent-core lint`.
Expected: FAIL with "Provider SDKs may only be imported inside packages/llm-provider-*". **Remove the temporary import afterward.**

A constraint you haven't watched fail is a constraint you don't have.

- [ ] **Step 6: Commit**

```bash
git add packages
git commit -m "feat: scaffold remaining package skeletons"
```

### Task 4: `apps/api` skeleton

**Files:** Create `apps/api/{package.json,tsconfig.json,src/server.ts,src/routes/health.ts,tests/health.test.ts}`, `.env.example`

**Interfaces:**
- Consumes: `@sketchmind/shared-types`.
- Produces: a running Fastify server with `GET /health`, and the `.env.example` contract Phase 3's Azure adapter reads.

- [ ] **Step 1: Write the failing test**

`apps/api/tests/health.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server";

describe("api health endpoint", () => {
  it("returns ok", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/api test`
Expected: FAIL — `apps/api` does not exist.

- [ ] **Step 3: Scaffold the server**

`apps/api/package.json`

```json
{
  "name": "@sketchmind/api",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "lint": "eslint src",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@sketchmind/shared-types": "workspace:*",
    "fastify": "^5.2.0"
  },
  "devDependencies": { "tsx": "^4.19.0" }
}
```

`apps/api/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`apps/api/src/routes/health.ts`

```ts
import type { FastifyInstance } from "fastify";
import { PACKAGE_VERSION } from "@sketchmind/shared-types";

export function registerHealth(app: FastifyInstance): void {
  app.get("/health", async () => ({ status: "ok", sharedTypes: PACKAGE_VERSION }));
}
```

`apps/api/src/server.ts`

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { registerHealth } from "./routes/health";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  registerHealth(app);
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = buildServer();
  app.listen({ port: Number(process.env.PORT ?? 3001) });
}
```

- [ ] **Step 4: Write `.env.example` (repo root)**

```bash
# ---- Azure OpenAI (AI Foundry) ----
# The ONLY provider config read by packages/llm-provider-azure-openai.
AZURE_OPENAI_ENDPOINT=https://<your-resource>.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=<your-deployment-name>
AZURE_OPENAI_API_VERSION=<verify current GA version at implementation time>

# Multimodal deployment for vision self-correction (AD-3).
# May be the same deployment if it supports image input.
AZURE_OPENAI_VISION_DEPLOYMENT=<your-vision-capable-deployment>

# Auth: EITHER an API key OR Entra ID (managed identity).
# Prefer Entra ID in deployed environments; key is fine for local dev.
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_USE_ENTRA_ID=false

# ---- Provider selection ----
# Changing this value is the ONLY change needed to swap LLM.
SKETCHMIND_LLM_PROVIDER=azure-openai

# ---- Agent budgets (AD-8: bounds cost/liveness, never decisions) ----
SKETCHMIND_AGENT_MAX_STEPS=40
SKETCHMIND_AGENT_MAX_TOKENS=200000
SKETCHMIND_AGENT_TIMEOUT_MS=180000

# ---- Server ----
PORT=3001
```

Confirm `.env` is gitignored — it already is (`.env`, `.env.*`, `!.env.example`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @sketchmind/api test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api .env.example
git commit -m "feat(api): scaffold Fastify server with health route"
```

### Task 5: `apps/web` skeleton

**Files:** Create `apps/web/{package.json,tsconfig.json,next.config.mjs,app/layout.tsx,app/page.tsx,tests/page.test.tsx}`

**Interfaces:**
- Consumes: `@sketchmind/shared-types` — proves `apps/* → packages/*` direction end to end.
- Produces: the frontend shell Phase 9 grows into the whiteboard UI.

- [ ] **Step 1: Write the failing test**

`apps/web/tests/page.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Page from "../app/page";

describe("web home page", () => {
  it("renders the app title", () => {
    render(<Page />);
    expect(screen.getByText("SketchMind")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/web test`
Expected: FAIL — `apps/web` does not exist.

- [ ] **Step 3: Scaffold the app**

`apps/web/package.json`

```json
{
  "name": "@sketchmind/web",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "test": "vitest run",
    "lint": "eslint app",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@sketchmind/shared-types": "workspace:*",
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.1.0",
    "jsdom": "^25.0.0"
  }
}
```

`apps/web/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "preserve", "noEmit": true },
  "include": ["app"]
}
```

`apps/web/next.config.mjs`

```js
/** @type {import('next').NextConfig} */
export default { transpilePackages: ["@sketchmind/shared-types"] };
```

`apps/web/app/layout.tsx`

```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`apps/web/app/page.tsx`

```tsx
export default function Page() {
  return (
    <main>
      <h1>SketchMind</h1>
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sketchmind/web test`
Expected: PASS

- [ ] **Step 5: Verify both apps boot together**

Run: `pnpm run dev`
Expected: web on `http://localhost:3000` renders "SketchMind"; api on `http://localhost:3001/health` returns `{"status":"ok",...}`. Stop both after confirming.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): scaffold Next.js frontend shell"
```

### Task 6: Root directory placeholders and CI

**Files:** Create `tests/README.md`, `configs/README.md`, `tools/README.md`, `scripts/README.md`, `examples/README.md`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root scripts from Task 1.
- Produces: the automated quality gate every later phase's PRs must pass (V17).

- [ ] **Step 1: Write the directory READMEs**

`tests/` — root-level contract, integration, and system tests spanning packages; unit tests live in `packages/<name>/tests/`.
`configs/` — centralized config: provider selection, renderer selection, feature flags, agent budgets, logging, cache, plugins. Injected, never read from global state.
`tools/` — internal dev tooling (codegen, schema generators, migrations).
`scripts/` — CI and one-off automation.
`examples/` — sample Diagram ASTs, Stroke ASTs, reference renders used as snapshot fixtures.

- [ ] **Step 2: Write the CI workflow**

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
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint
      - run: pnpm run typecheck
      - run: pnpm run build
      - run: pnpm run test
```

- [ ] **Step 3: Verify locally**

Run: `pnpm install --frozen-lockfile && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test`
Expected: all PASS, mirroring CI.

- [ ] **Step 4: Commit**

```bash
git add tests/README.md configs/README.md tools/README.md scripts/README.md examples/README.md .github/workflows/ci.yml
git commit -m "chore: add directory READMEs and CI quality gate"
```

### Phase 1 Acceptance Criteria

- [ ] `pnpm install` succeeds from a clean clone.
- [ ] `pnpm run build` builds all packages + both apps.
- [ ] `pnpm run lint` passes, with `import/no-cycle` and the provider-SDK restriction **proven to fail when violated** (Task 3 Step 5).
- [ ] `pnpm run test` passes everywhere.
- [ ] `pnpm run dev` boots web (:3000) and api (:3001) together.
- [ ] `.env.example` documents the full Azure contract; no secrets committed.
- [ ] CI runs the same four commands and passes.

---

## Phase 2 — Core Models ✅ COMPLETE

> Detailed plan and outcome: `2026-08-05-phase-2-core-models.md`.
> 104 tests; full gate green. Two deviations landed: `ToolDefinition` split into
> `ToolSpec` (here) + handler (Phase 4 `agent-core`), to preserve layering; and VIL and
> the Diagram AST share one 14-type relationship vocabulary rather than two.

**Deliverable:** models compile and validate.
**Packages:** `shared-types`, `diagram-ast`, `utilities`.

| Model | Source | Notes |
|---|---|---|
| `IntentModel` | V03 | intent, domain, category, complexity, teaching objective |
| `VisualPlan` | V03 | objects, labels, highlights, animations, detail level — no geometry |
| `VIL` | V13 | version, intent, subject, context, objects, relationships, annotations, emphasis, metadata |
| `ShapeGraph` | V10, V14 | nodes + edges; node = id/type/category/role/metadata/behaviors/anchors/constraints |
| `DiagramAST` | V04 | id, version, subject, title, objects, relationships, groups, annotations, metadata |
| `ConstraintGraph` | V05, V14 | 15 constraint types |
| `LayoutModel` | V05 | **only model with geometry** |
| `StrokeAST` | V06 | 12 stroke types; per stroke id/type/target/order/deps/style/timing/metadata |
| `RuntimeEvent` | V09, V16 | discriminated union of lifecycle events |
| `SketchMindError` | V12 | `{ code, message, package, stage, recoverable }` |
| `AgentTrace` | AD-8 | `{ stepId, locus, thought?, toolName?, toolArgs?, toolResult?, tokens, durationMs, timestamp }` |
| `ToolDefinition` | AD-1/AD-4 | `{ name, description, argsSchema (Zod), locus: "server"\|"client", handler }` |
| `FreeformShape` | AD-5 | geometric sub-primitive composition, no manifest |

**Acceptance:**
- [ ] Every model exists as type + Zod schema in `shared-types` and nowhere else.
- [ ] `diagram-ast` exposes `buildDiagramAST` / `validateDiagramAST`; hand-built ASTs round-trip.
- [ ] Contract tests: duplicate id fails, orphan object fails, unknown constraint type fails.
- [ ] Automated test asserts no geometry fields on `DiagramAST`, `ShapeGraph`, `VisualPlan`, `ConstraintGraph`.
- [ ] Validation errors are **structured and machine-readable** — they become agent observations in Phase 4 (AD-2).

---

## Phase 3 — LLM Provider Abstraction + Azure OpenAI ✅ COMPLETE

**Deliverable:** a live Azure call returning schema-valid JSON through an interface that knows nothing about Azure.
**Packages:** `llm-provider`, `llm-provider-azure-openai`, `llm-provider-anthropic`.

**Deviations from this section, both recorded as AD-9 and detailed in
`docs/superpowers/plans/2026-08-05-phase-3-llm-provider.md`:**
- No `api-version` anywhere, stock `OpenAI` client (not `AzureOpenAI`), Responses API instead of
  Chat Completions — the live deployment's own playground sample settled this; see AD-9 above.
- `llm-provider-anthropic` was built in this phase, not deferred, specifically to prove
  `LLMProvider` isn't Azure-shaped: `completeStructured` reaches a validated value by forced tool
  call rather than native `response_format`, behind an identical signature, verified by running the
  same exported contract suite against both adapters with zero test-code changes.
- A latent Phase 1 defect was found and fixed while wiring this phase's `node` scripts:
  `tsconfig.base.json` used `moduleResolution: "Bundler"`, which emits relative imports with no
  `.js` extension — invisible under Vitest (it resolves through its own bundler) but fatal to
  `node dist/index.js` outside one. Switched the base config to `NodeNext`/`NodeNext` (with
  `apps/web` overriding back to `Bundler`, which Next.js requires), and ran a one-time codemod
  (`scripts/add-import-extensions.mjs`) adding `.js` to every relative import/export across
  `packages/*` and `apps/api`.

```ts
export interface LLMCapabilities {
  structuredOutput: boolean;
  toolCalling: boolean;
  parallelToolCalls: boolean;
  streaming: boolean;
  vision: boolean;              // AD-3
  maxContextTokens: number;
}

export interface LLMProvider {
  readonly id: string;
  readonly capabilities: LLMCapabilities;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResponse<T>>;
  completeWithTools(req: ToolRequest): Promise<ToolResponse>;   // AD-1
  completeWithImages(req: VisionRequest): Promise<CompletionResponse>; // AD-3
  stream(req: CompletionRequest): AsyncIterable<CompletionChunk>;
}
```

`completeStructured` takes a Zod schema and either uses native structured output or falls back to prompt-injected schema + parse-and-repair, per capability flag. Callers never know which. That's what lets a weaker local model drop in later untouched.

**Azure specifics:** `openai` SDK's `AzureOpenAI` client (the standalone `@azure/openai` package is legacy — verify current guidance at implementation time). Config strictly from `.env`. Both API-key and Entra ID / `DefaultAzureCredential` auth. Structured-output capability set from config/probe, not hardcoded — AI Foundry support varies by model and API version. Map Azure errors to `SketchMindError`: 429 + `Retry-After` retryable, content-filter **not** retryable, deployment-not-found fatal. Never log user content at info level.

**Acceptance:**
- [x] Live integration test (skipped without Azure env) returns an object matching a Zod schema
      (`IntentModelSchema`, not a toy) — `llm-provider-azure-openai/tests/live.test.ts`.
- [x] The same test passes against an in-memory fake provider with **zero test-code changes** — one
      exported `describeProviderContract`, run against `FakeProvider` (native and repair paths) and
      against both real adapters over stubbed transports.
- [x] `SKETCHMIND_LLM_PROVIDER=anthropic` switches adapters with no code change —
      `llm-provider-azure-openai/tests/registry-switch.test.ts`.
- [x] No `openai`/`@azure/*`/`@anthropic-ai/*` source hits outside `packages/llm-provider-*`
      (lint-enforced + grep).
- [x] A provider with `structuredOutput: false` still returns schema-valid objects via repair
      fallback — asserted for both adapters.
- [x] 429 retries with backoff honoring `Retry-After`; content-filter fails fast; 404
      deployment-not-found is fatal — all asserted with stubbed transports, no network.
- [x] `completeWithImages` refuses before reading `req.images` while `vision: false` — asserted with
      a getter that records access, for both adapters and the fake (D-10).
- [x] No prompt/output text in any log call — asserted with a canary string, for both adapters (D-7).

**Test counts:** `llm-provider` 135 passing · `llm-provider-azure-openai` 56 passing / 3 skipped
(live, no Azure env in this environment) · `llm-provider-anthropic` 49 passing.

---

## Phase 4 — Agent Core & Memory ✅ COMPLETE

**Deliverable:** a working agent loop with tools, budgets, tracing, and persistent memory — the spine everything else plugs into (AD-1, AD-4, AD-7, AD-8).
**Packages:** `agent-core`, `agent-memory`.

> Detailed plan and outcome: `2026-08-05-phase-4-agent-core-memory.md`.
> 94 new tests across `agent-core`/`agent-memory`, plus a `llm-provider` amendment and the repo's
> first use of the root `tests/` workspace. One deviation, recorded there as Phase 4's own D-1:
> Phase 3's `Message` type had no way to carry a tool's result back to the model, invisible until an
> actual loop tried to run more than one step. `Message` became a discriminated union
> (`UserMessage | AssistantMessage | ToolResultMessage`); both adapters' translations differ sharply
> (Azure: flat sibling `function_call`/`function_call_output` items; Anthropic: `tool_use` nested in
> the assistant turn, `tool_result` batches merged into one user turn, and it rejects anything else
> outright), which is exactly the kind of gap only a real second adapter surfaces.

**`agent-core`:** loop is `observe → reason → select tool(s) → execute → observe → …` until goal or budget exhausted. Provides tool registry with Zod-typed args, parallel tool calls where the provider supports it, step/token/time budgets, cancellation token, structured `AgentTrace` per step, and **tool failure as observation, not crash** (AD-2). Depends on `llm-provider` — never a concrete provider.

**`agent-memory`:** session working memory (what's been drawn, what the user asked, what failed) plus a persisted learned-primitive store with semantic recall. Tools: `recall(query)`, `learn(primitive)`, `forget(id)`. Pluggable backend — start with local file + embedding index; swappable for a vector DB later.

**Acceptance:**
- [x] A toy agent with 2 fake tools completes a multi-step goal and emits a full trace.
- [x] A tool that throws produces an observation the agent recovers from — the run does not fail (AD-2).
- [x] Exceeding step/token/time budget terminates cleanly with a partial result, never a hang.
- [x] Cancellation mid-run stops within one step boundary and releases resources.
- [x] `recall` returns a semantically similar stored primitive for a differently-worded query ("nephron" matches a stored "kidney nephron unit") — AD-7. Default recall tier is lexical (token + trigram hashing, zero tokens, deterministic); a real `EmbeddingProvider` is a documented, tested drop-in for the synonym cases the lexical tier cannot reach.
- [x] The loop runs identically against fake and Azure providers — extended to Anthropic as well, all three via one test body (`tests/agent-loop-providers.test.ts`).

---

## Phase 5 — Reasoning Tools

**Deliverable:** natural language → validated `DiagramAST`, with the agent choosing how much reasoning to apply (AD-1).
**Packages:** `intent-analyzer`, `visual-planner`, `shape-intelligence`, `diagram-reasoner`, `agent-tools-reasoning`.

Each stage keeps its V12/V15 contract but is exposed as a tool: `analyze_intent`, `plan_visual`, `build_shape_graph`, `compose_diagram_ast`, `validate_diagram`, plus `search_primitives` / `generate_primitive` / `compose_freeform` (AD-5). Prompts live as versioned data files following V15's Standard Prompt Template with few-shot examples, isolated from application code.

**Acceptance:**
- [x] "Draw a movable pulley" produces a valid `DiagramAST` with ceiling, fixed pulley, movable pulley, rope, load.
- [x] "Draw a circle" completes with **fewer tool calls** than the pulley — proving adaptive depth (AD-1). One reasoning round trip against four.
- [x] A deliberately malformed AST returns structured errors the agent fixes on a subsequent step (AD-2), verifiable in the trace — `AST_ORPHAN_OBJECT` naming `rope_2`, run continues, recheck passes.
- [x] `search_primitives` is consulted before `generate_primitive` (V10). Enforced inside `generatePrimitive`, so no code path generates without having searched.
- [x] No agent output contains `x`, `y`, `svg`, or `canvasCommand` fields. Checked at runtime on every tool result, not only in the schemas — the open `metadata`/`properties` bags are where geometry would otherwise hide.
- [x] All tools unit-tested against the fake provider — no network in the default suite.

**Discovered during implementation:** the `LAYERS` order had `tools` below `agent`, which made every
tool package's `defineTool` import an upward dependency. The plan's "Applications → Agent → Tools →
Core" chain is call flow, not imports; `agent-core` deliberately imports no tool package. `tools` now
sits above `agent`. See `docs/superpowers/plans/2026-08-05-phase-5-reasoning-tools.md` (D-1–D-10).

---

## Phase 6 — Layout Engine

**Deliverable:** `DiagramAST` → `LayoutModel`. Deterministic, no AI.
**Packages:** `constraint-engine`, `layout-engine`.

`constraint-engine` derives constraints (above/below/inside/outside/attachedTo/connectedTo/wrapsAround/centeredOn/alignedWith/parallelTo/perpendicularTo) from AST relationships; zero geometry. `layout-engine` solves to `LayoutModel` with 2 MVP strategies (Hierarchical + Grid) behind a strategy interface, plus collision detection, label placement, and straight connector routing.

**Acceptance:**
- [ ] Pulley AST yields non-overlapping bounding boxes with every referenced object positioned.
- [ ] Identical input always yields identical output (AD-6 — determinism holds here).
- [ ] Strategy selection driven by diagram metadata, not hardcoded at call sites.
- [ ] `LayoutModel` remains the only model with coordinates.

---

## Phase 7 — Stroke Engine

**Deliverable:** `LayoutModel` → animated `StrokeAST`. Renderer-independent.
**Packages:** `stroke-planner`, `stroke-runtime`.

`stroke-planner` orders strokes per V06 human drawing rules — outlines first, detail after, labels last, connected objects continuous, no unnatural pen jumps — then optimizes without changing semantics. `stroke-runtime` provides play/pause/resume/seek/replay/undo/redo/cancel over a timeline, progressive-rendering hooks, and the editing API (insert/delete/move/replace/reorder).

**Acceptance:** (complete — see `2026-08-05-phase-7-stroke-engine.md`)
- [x] Pulley layout yields natural order (ceiling → pulleys → rope → load → arrow → labels last).
- [x] Play, pause mid-sequence, resume, replay are deterministic across runs.
- [x] Undo removes exactly the last stroke; redo restores it; no side effects.
- [x] Optimizer never changes which objects exist — verified by object-coverage diff, not stroke count.

---

## Phase 8 — Renderer

**Deliverable:** first real pixels via Konva, driven purely by `stroke-runtime`.
**Packages:** `renderer-core`, `renderer-konva`, `renderer-svg` (skeleton), `export-engine` (PNG).

`renderer-core` defines the adapter interface (`initialize/destroy/drawStroke/eraseStroke/updateStroke/renderFrame/resizeViewport/export/captureImage`), layer model, viewport, hit-testing, registry. `captureImage` is added for AD-3 — vision self-correction needs the canvas as an image.

**Acceptance:** (complete — see `2026-08-05-phase-8-renderer.md`)
- [x] Konva draws the pulley `StrokeAST` in order, matching a reference PNG within pixel-diff tolerance
      (text excluded from the baseline; label rendering asserted structurally — D-8).
- [x] Play/pause/resume visibly controls progressive drawing — asserted as decoded ink coverage.
- [x] `renderer-konva` imports nothing from AI, agent, constraint, or layout packages (`check-layering.mjs`,
      plus a direct manifest assertion).
- [x] PNG export contains all drawn objects — verified per object by decoding the PNG.
- [x] Hit-testing returns the correct object id on click, cross-checked against Konva's own hit graph.
- [x] `captureImage` returns a usable image buffer — decoded and checked non-blank.

---

## Phase 9 — Web App, Protocol & Live Agent

**Deliverable:** **the vertical slice.** Type in a browser, watch an agent draw it live.
**Packages/apps:** `session-protocol`, `agent-tools-geometry`, `apps/api`, `apps/web`.

`session-protocol` — server→client events (`SessionStarted`, `AgentStep`, `StrokeGenerated`, `DiagramASTReady`, `SessionCompleted`, `SessionFailed`) and client→server commands (`StartSession`, `CancelSession`, `AgentToolProxy`, `FollowUpRequest`). SSE for streaming; transport-agnostic so WebSocket is a drop-in later.

`apps/api` routes: `POST /api/sessions`, `GET /api/sessions/:id/stream` (SSE), `POST /api/sessions/:id/cancel`, `POST /api/agent/llm` (**client-agent LLM proxy — why Azure keys never reach the browser**).

`apps/web`: prompt input, whiteboard canvas mounting `renderer-konva`, playback controls, **agent trace panel** (live thought/tool/args/result/timing/tokens — your main debugging surface), diagram inspector.

**Acceptance:**
- [ ] "Draw a movable pulley" typed in the browser draws it live, stroke by stroke.
- [ ] Trace panel shows every agent step with timing as it happens.
- [ ] Cancel mid-draw stops promptly, no dangling session.
- [ ] Inspector shows a valid Diagram AST.
- [ ] **No Azure credential, endpoint, or provider SDK in any browser bundle** — verified by inspecting the built client bundle, enforced in CI.
- [ ] Manually verified via the `run` skill.

---

## Phase 10 — Vision Self-Correction

**Deliverable:** the agent inspects its own drawing and fixes it (AD-3).
**Packages:** `agent-vision`.

Two critique sources feeding one repair loop. Both emit the same structured fix proposals — `move_object`, `resize_object`, `reposition_label`, `add_missing_component`, `redraw_object` — so the agent's repair path does not care which produced them. Bounded by a correction-round budget so it converges instead of oscillating.

**10a — Geometric critique (default on, zero token cost).**
Deterministic inspection of `LayoutModel` + `StrokeAST`: object/label overlap, out-of-bounds elements, connector crossings, connector endpoints not meeting their declared anchors, degenerate or zero sizes, severe whitespace imbalance. Pure software over models the pipeline already built — no model call, no image, no added latency.

**10b — Visual critique (default off).**
`captureImage` → multimodal critique against the original request. Gated on `AZURE_OPENAI_VISION_DEPLOYMENT` being set and the provider reporting `vision: true`. Blank means the tier never runs and nothing fails.

**Acceptance:**
- [ ] A seeded diagram with an obviously misplaced component (rope not meeting the pulley) is detected and corrected by **10a alone** — verified by comparing before/after `LayoutModel`.
- [ ] A correct diagram passes critique **without** spurious changes (no oscillation on good output).
- [ ] Correction rounds are budget-capped; the loop always terminates.
- [ ] With `AZURE_OPENAI_VISION_DEPLOYMENT` blank, the full pipeline runs end to end with 10a only — no image is ever encoded, sent, or logged. Asserted by a test, not by configuration alone.
- [ ] Setting the variable enables 10b with **no code change**.
- [ ] Critique findings appear in the trace panel, tagged with which tier produced them.

---

## Phase 11 — Client Agent Full Autonomy

**Deliverable:** an agent in the browser that acts freely on the board (AD-4, AD-8).
**Packages:** `agent-tools-canvas`, client locus in `apps/web`.

Tools over the rendered diagram: `highlight_object`, `clear_highlights`, `zoom_to`, `fit_to_content`, `annotate`, `pause_playback`, `resume_playback`, `set_speed`, `erase_object`, `redraw_object`, `move_object`, `relayout_region`, `select_object`, `query_diagram`, `extend_diagram`. All operate through `renderer-core` and `stroke-runtime` public APIs — never Konva directly.

**Full autonomy per AD-8:** no permission prompts, no confirmation gates, no escalation approvals. The agent annotates, erases, redraws, re-lays-out, invents components, and extends diagrams on its own judgment. It decides locally whether a request needs local action or a server turn; nothing forces it to ask.

**Acceptance:**
- [ ] Clicking a component makes the agent highlight, zoom, and explain it — no full redraw, no prompt.
- [ ] "Now show the effort direction" is handled by adding components **without** restarting the session (verified: no new session in the network log).
- [ ] The agent independently fixes a label it judges badly placed, with no user request.
- [ ] Client and server steps share one trace panel, distinguished by `locus`.
- [ ] Budgets enforced; a runaway loop terminates and reports.
- [ ] Browser bundle contains no provider SDK and no credentials (CI check).

---

## Phase 12 — Learning, Plugins & Hardening

**Deliverable:** the system gets better with use, and everything is observable and recoverable.
**Packages:** `primitive-sdk`, `plugin-sdk`, `ai-orchestrator`, `export-engine`.

**Learning loop (AD-5, AD-7):** freeform shapes that recur get promoted to registered primitives — manifest, anchors, behaviors, constraints, validation. `plugin-sdk` loads subject packs, primitive packs, renderers, layout strategies, stroke generators, exporters through public interfaces only.

**Hardening:** session/execution/pipeline/drawing/playback/renderer state as distinct serializable models (V16); checkpoints after intent, AST, layout, strokes with resume-from-latest-valid; caching keyed by model version **and provider id** (an Azure-derived cache entry must never be served to a different provider); cancellation stopping agents, AI, and rendering; observability for stage duration, tokens, cache hits, retries, validation failures, render FPS, memory.

**MVP acceptance — the finish line:**
- [ ] "Explain a movable pulley" in `apps/web` produces a valid AST, layout, live animated drawing, vision self-correction, and both agent traces — no manual intervention.
- [ ] The same concept requested twice generates a primitive once and **recalls** it the second time, measurably faster (AD-7).
- [ ] Resuming from a checkpoint produces an equivalent final render.
- [ ] Undo/redo, replay, and PNG export all work against the live session.
- [ ] Cancelling mid-pipeline stops everything promptly with no dangling state.
- [ ] **Switching `SKETCHMIND_LLM_PROVIDER` runs the identical flow with zero code changes** — LLM independence proven end to end.
- [ ] Ten varied requests across different domains (physics, biology, CS, mechanical) each produce a recognizable, non-overlapping diagram — the real "draw anything" test.
- [ ] All unit, contract, and full-flow system tests pass in CI.
- [ ] Benchmarks collected and within agreed thresholds.

---

## Self-Review Notes

- **Spec coverage:** every Volume 01–18 concept maps to a phase, except where explicitly superseded in Architectural Decisions with stated rationale.
- **Requirement coverage:** LLM independence → Phase 3 + lint enforcement + Phase 12 proof; Azure OpenAI → Phase 3; web frontend → Phase 9; server agent → Phases 4–5; client agent full autonomy → Phase 11 (AD-8); "draw anything" → AD-5 freeform + AD-7 learning + Phase 12's ten-domain test.
- **Deferred by design:** Phases 2–12 stop short of bite-sized steps (see Scope Note) — exact schema fields, prompt text, and tool signatures depend on earlier phases' real code.
- **Open items for implementation time:** current Azure API version and structured-output/vision support for your specific AI Foundry deployments (Phase 3); embedding model for `agent-memory` recall (Phase 4); convergence heuristics for vision correction rounds (Phase 10).
- **Toolchain verified locally:** Node 22.18.0, pnpm 10.27.0, git 2.47.1 — versions in Phase 1 match.
