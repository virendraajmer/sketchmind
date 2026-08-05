# SketchMind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build SketchMind — an agentic technical sketch engine where an AI agent, given any natural-language request, reasons out what an object *is*, and draws it on a whiteboard stroke by stroke like a teacher — with a web frontend for real testing, autonomous agents on both server and client, and a fully swappable LLM layer (Azure OpenAI / AI Foundry first).

**Architecture:** Two agent loops wrapped around one strictly deterministic pipeline.

```
                         ┌──────────────── apps/web (browser) ────────────────┐
                         │  Client Agent  ──tools──▶  Canvas / Stroke Runtime │
                         └──────────▲──────────────────────┬──────────────────┘
                                    │  session protocol     │  (LLM calls proxied —
                                    │  (SSE / WebSocket)    │   no keys in browser)
                         ┌──────────┴──────────────────────▼──────────────────┐
                         │                 apps/api (server)                  │
                         │  Server Agent ──tools──▶ deterministic pipeline:   │
                         │                                                    │
                         │   NL → Intent → VisualPlan → ShapeGraph →          │
                         │   DiagramAST → ConstraintGraph → LayoutModel →     │
                         │   StrokeAST → Renderer                             │
                         └──────────────────────┬─────────────────────────────┘
                                                │
                                       LLMProvider interface
                                                │
                            ┌───────────────────┼───────────────────┐
                      Azure OpenAI          Anthropic            Gemini / local
                      (AI Foundry)          (adapter)            (adapter)
```

The LLM only ever produces structured JSON reasoning (Intent, Visual Plan, Shape Graph, Diagram AST) and tool calls. It never emits coordinates, SVG, canvas/Konva commands, or geometry. Everything from the Constraint Engine onward is deterministic. Renderers know nothing about AI or layout.

**Tech Stack:** TypeScript monorepo (pnpm workspaces + Turborepo), Vitest, Zod for runtime schema validation, Konva as first renderer backend, Next.js for `apps/web`, Node/Fastify for `apps/api`, Azure OpenAI via AI Foundry as first LLM provider (`openai` npm SDK's `AzureOpenAI` client), SSE or WebSocket for agent/pipeline streaming.

## Global Constraints

These apply to every phase. Do not restate per task; do not violate.

**Structure & dependencies**
- Monorepo layout: `apps/`, `packages/`, `examples/`, `docs/`, `tools/`, `scripts/`, `tests/`, `configs/` (Volume 11).
- One-way dependency direction: `Applications → Agents → Orchestrator → Core Packages → Renderer Packages → External Libraries`. Never depend upward. No cycles (Volume 11).
- Shared models live **only** in `packages/shared-types`. No package redefines or duplicates them (Volume 11, 12).
- Every package exposes a versioned public API only — no cross-package imports of internals (Volume 12).
- The four models stay separate, never merged: Diagram AST (semantic), Constraint Model (relationships), Layout Model (geometry), Stroke AST (drawing sequence) (Volume 02).

**AI boundaries**
- No AI component — agent or pipeline stage — may output coordinates, SVG, canvas commands, or Konva commands. Structured JSON with stable IDs only (Volume 03, 10, 13, 15).
- `LayoutModel` is the **only** model in the entire system permitted to contain numeric geometry.
- Every pipeline stage output passes a validation gate before the next stage runs; invalid output halts the pipeline (Volume 09, 17).
- Never trust raw LLM output — schema-validate everything (Volume 17).

**LLM independence (hard requirement)**
- All model access goes through the `LLMProvider` interface in `packages/llm-provider`. No provider-specific types, SDK imports, or config leak into any other package — including the agent packages.
- Adding a new provider means adding one `packages/llm-provider-*` package and one config entry. Nothing else changes.
- Providers declare capabilities (`structuredOutput`, `toolCalling`, `streaming`, `parallelToolCalls`); callers branch on capability flags, never on provider name.
- Azure OpenAI (AI Foundry) is the first live adapter. At least one second adapter must exist (even if stubbed) at all times to prove the abstraction holds.

**Security**
- LLM credentials (Azure keys, Entra tokens) exist only on the server. The client agent's model calls proxy through `apps/api`. No provider SDK is ever bundled into browser code.
- Client-agent tool calls are validated and authorized server-side where they have server effects; the browser is never trusted.

**Agents**
- Both agents share one agent loop implementation (`packages/agent-core`) and one tool-definition format. Server and client differ only in which tools they are given.
- Every agent run is bounded: max steps, max tokens, wall-clock timeout, and a cancellation token. No unbounded loops.
- Every agent step is traced (thought, tool, args, result, duration, tokens) and streamable to the UI.

**MVP scope** (Volume 18)
- Required: single renderer (Konva), Azure OpenAI live, basic primitives, animated drawing, replay, undo/redo, export, web UI, both agents.
- Deferred: collaboration, marketplace, multi-renderer in production, remote plugin registries, cloud sync.

**Testing** — every package ships unit tests; root `tests/` holds contract/integration/system tests (Volume 11, 17).

---

## Scope Note (read before executing)

This spec spans many independent subsystems. Per `writing-plans` guidance, each phase should get its own detailed sub-plan written *immediately before that phase starts* — not all up front, because later phases depend on interfaces only earlier phases will concretely settle.

So this document does two things:

1. **Phase 1** is a fully detailed, bite-sized, TDD-ready plan — start here.
2. **Phases 2–12** are a firm roadmap: exact packages, responsibilities, inputs/outputs, and acceptance criteria — enough to scope and sequence, but each gets its own `writing-plans` pass (producing `docs/superpowers/plans/YYYY-MM-DD-phase-N-<name>.md`) once the prior phase's interfaces are real code rather than spec prose.

Phase ordering deliberately front-loads a **working vertical slice** (Phases 1–8: you can type a request in a browser and watch it draw) *before* the agentic sophistication (Phases 9–10). This follows Volume 18's "prefer a small working vertical slice over a partially implemented architecture" — and it's the honest sequence, because the agents wrap a pipeline that must already work.

---

## Package Map

Beyond Volume 11's list, this plan adds packages for LLM independence, the agent layer, and the client/server protocol. Every addition follows the same contract rules.

| Package | Responsibility | Phase |
|---|---|---|
| `shared-types` | All shared models + Zod schemas. Depends on nothing. | 1–2 |
| `utilities` | Cross-cutting helpers (ids, result types, logging shims). | 1 |
| **`llm-provider`** | **`LLMProvider` interface, capability flags, retry/repair, provider registry. Zero SDK imports.** | 3 |
| **`llm-provider-azure-openai`** | **Azure OpenAI / AI Foundry adapter. The only place Azure types exist.** | 3 |
| **`llm-provider-anthropic`** | **Second adapter (proves the abstraction). May be minimal.** | 3 |
| `intent-analyzer` | NL → `IntentModel`. | 4 |
| `visual-planner` | `IntentModel` → `VisualPlan`. | 4 |
| `shape-intelligence` | `VisualPlan` → `ShapeGraph` + primitive discovery/generation/learning. | 4 |
| `diagram-reasoner` | `ShapeGraph` → `DiagramAST`. | 4 |
| `diagram-ast` | AST builder API, validator, versioning, serialization. | 2 |
| `constraint-engine` | `DiagramAST` → `ConstraintGraph`. | 5 |
| `layout-engine` | `ConstraintGraph` → `LayoutModel`. Solver, collision, labels, routing. | 5 |
| `stroke-planner` | `LayoutModel` → `StrokeAST` + optimizer. Human drawing rules. | 6 |
| `stroke-runtime` | Playback: play/pause/seek/replay/undo/redo. Renderer-independent. | 6 |
| `renderer-core` | Adapter contract, layer model, viewport, hit-testing, registry. | 7 |
| `renderer-konva` | First concrete backend. | 7 |
| `renderer-svg` | Skeleton only in MVP (proves the SDK is backend-agnostic). | 7 |
| **`session-protocol`** | **Typed client↔server message contract: events + commands + agent traces.** | 8 |
| **`agent-core`** | **Provider-agnostic agent loop, tool registry, step budget, tracing, cancellation. Shared by both agents.** | 9 |
| **`agent-tools-server`** | **Server tool surface: pipeline stages, registry search, primitive generation, validation, layout critique.** | 9 |
| **`agent-tools-canvas`** | **Client tool surface over renderer + stroke-runtime: highlight, zoom, annotate, pause, erase, redraw, select.** | 10 |
| **`client-agent`** | **Browser agent: `agent-core` + canvas tools + proxied LLM calls.** | 10 |
| `ai-orchestrator` | Pipeline execution, state, checkpoints, caching, event bus. | 12 |
| `primitive-sdk` | Manifest schema, validation, primitive registry. | 11 |
| `plugin-sdk` | Plugin loading for subject packs, primitives, renderers, strategies, exporters. | 11 |
| `export-engine` | PNG/SVG/PDF/JSON/replay-package export. | 7, 12 |

**Apps**

| App | Responsibility | Phase |
|---|---|---|
| **`apps/web`** | **Next.js frontend: prompt input, live whiteboard canvas, playback controls, agent trace panel, diagram inspector.** | 8 |
| **`apps/api`** | **Fastify server: hosts orchestrator + server agent, streams to client, proxies client-agent LLM calls.** | 8 |

---

## Phase 1 — Repository Foundation

**Maps to:** Volume 11, Volume 18 Phase 1.

**Deliverable:** the monorepo builds, lints, and tests with real skeletons for every package and both apps, wired with correct one-way dependencies, before any business logic exists.

### File Structure

```
sketchmind/
├── package.json                  # workspace root: build/lint/test/typecheck
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── turbo.json
├── .eslintrc.cjs
├── .prettierrc
├── vitest.workspace.ts
├── .env.example                  # Azure OpenAI config keys, no secrets
├── apps/
│   ├── web/                      # Next.js frontend
│   └── api/                      # Fastify server
├── packages/                     # 24 packages per the Package Map above
├── examples/  docs/  tools/  scripts/  tests/  configs/
```

Every `packages/<name>/` gets the same skeleton:

```
packages/<name>/
├── package.json          # name: "@sketchmind/<name>"
├── tsconfig.json         # extends ../../tsconfig.base.json
├── src/
│   ├── index.ts          # public API surface only
│   └── internal/         # implementation, never imported cross-package
├── tests/index.test.ts
└── README.md             # purpose, public API, examples (Volume 11)
```

### Task 1: Workspace root and tooling

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `turbo.json`, `.eslintrc.cjs`, `.prettierrc`, `vitest.workspace.ts`

**Interfaces:**
- Produces: root `build`, `lint`, `test`, `typecheck` scripts that every later task and phase uses to verify work.

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
    "typecheck": "turbo run typecheck",
    "dev": "turbo run dev --parallel"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.5.0",
    "eslint": "^9.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "eslint-plugin-import": "^2.29.0",
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
          { "group": ["**/internal/*"], "message": "Import a package's public API only (Volume 12)." },
          { "group": ["openai", "@azure/*", "@anthropic-ai/*", "@google/*"],
            "message": "Provider SDKs may only be imported inside packages/llm-provider-* (Global Constraints: LLM independence)." }
        ]
      }
    ]
  },
  overrides: [
    {
      files: ["packages/llm-provider-*/**"],
      rules: { "no-restricted-imports": "off" }
    }
  ]
};
```

The second `no-restricted-imports` group is the mechanical enforcement of LLM independence — provider SDKs are physically un-importable outside their adapter package. This is what makes "swap any LLM anytime" a guarantee rather than an intention.

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

**Files:**
- Create: `packages/shared-types/{package.json,tsconfig.json,src/index.ts,tests/index.test.ts,README.md}`

**Interfaces:**
- Consumes: nothing (leaf package).
- Produces: `PACKAGE_NAME` / `PACKAGE_VERSION` constants proving the package resolves as a workspace dependency. Real models arrive in Phase 2 — this task only proves skeleton, build, and test wiring.

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

- [ ] **Step 3: Write the package skeleton**

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

Canonical home for every model shared across SketchMind packages
(IntentModel, VisualPlan, VIL, ShapeGraph, DiagramAST, ConstraintGraph,
LayoutModel, StrokeAST, RuntimeEvent, AgentTrace). No other package may
redefine these (Volume 11 §Shared Types, Volume 12).
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

**Files:**
- Create: the same 5-file skeleton for every other package in the Package Map — `utilities`, `llm-provider`, `llm-provider-azure-openai`, `llm-provider-anthropic`, `intent-analyzer`, `visual-planner`, `shape-intelligence`, `diagram-reasoner`, `diagram-ast`, `constraint-engine`, `layout-engine`, `stroke-planner`, `stroke-runtime`, `renderer-core`, `renderer-konva`, `renderer-svg`, `session-protocol`, `agent-core`, `agent-tools-server`, `agent-tools-canvas`, `client-agent`, `ai-orchestrator`, `primitive-sdk`, `plugin-sdk`, `export-engine`.

**Interfaces:**
- Consumes: `@sketchmind/shared-types` as `workspace:*` in each package.
- Produces: `PACKAGE_NAME` / `PACKAGE_VERSION` per package, so later phases build on packages that already compile, test, and lint.

- [ ] **Step 1: Write the failing test for one representative package (`llm-provider`)**

`packages/llm-provider/tests/index.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/index";

describe("llm-provider package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/llm-provider");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});
```

Repeat this exact pattern for every remaining package, swapping only the package-name string.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -r test`
Expected: FAIL for every new package — no `src/index.ts` yet.

- [ ] **Step 3: Scaffold each package**

For each package `<name>`, create the four files from Task 2 Step 3 with `@sketchmind/<name>` substituted, plus this dependency:

```json
"dependencies": { "@sketchmind/shared-types": "workspace:*" }
```

Each `README.md` states that package's one-line responsibility, copied from the Package Map table above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -r test`
Expected: PASS for all packages.

- [ ] **Step 5: Verify no dependency cycles and that provider-SDK lockdown is active**

Run: `pnpm run lint`
Expected: no `import/no-cycle` errors.

Then verify the guard rail actually bites — temporarily add `import OpenAI from "openai";` to `packages/agent-core/src/index.ts` and run `pnpm --filter @sketchmind/agent-core lint`.
Expected: FAIL with the "Provider SDKs may only be imported inside packages/llm-provider-*" message. **Remove the temporary import afterward.** This proves the LLM-independence constraint is mechanically enforced, not just documented.

- [ ] **Step 6: Commit**

```bash
git add packages
git commit -m "feat: scaffold remaining package skeletons"
```

### Task 4: `apps/api` skeleton

**Files:**
- Create: `apps/api/{package.json,tsconfig.json,src/server.ts,src/routes/health.ts,tests/health.test.ts}`, `.env.example`

**Interfaces:**
- Consumes: `@sketchmind/shared-types`.
- Produces: a running Fastify server with `GET /health`, and the `.env.example` contract that Phase 3's Azure adapter reads.

- [ ] **Step 1: Write the failing test**

`apps/api/tests/health.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server";

describe("api health endpoint", () => {
  it("returns ok with the shared-types version", async () => {
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
    "fastify": "^4.28.0"
  },
  "devDependencies": { "tsx": "^4.16.0" }
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

# Auth: use EITHER an API key OR Entra ID (managed identity / DefaultAzureCredential).
# Prefer Entra ID in deployed environments; key is fine for local dev.
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_USE_ENTRA_ID=false

# ---- Provider selection ----
# Swapping this value is the ONLY change needed to change LLM.
SKETCHMIND_LLM_PROVIDER=azure-openai

# ---- Server ----
PORT=3001
```

Confirm `.env` is gitignored (it already is — `.gitignore` has `.env` and `.env.*` with `!.env.example`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @sketchmind/api test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api .env.example
git commit -m "feat(api): scaffold Fastify server with health route"
```

### Task 5: `apps/web` skeleton

**Files:**
- Create: `apps/web/{package.json,tsconfig.json,next.config.mjs,app/page.tsx,app/layout.tsx,tests/page.test.tsx}`

**Interfaces:**
- Consumes: `@sketchmind/shared-types` — proving `apps/* → packages/*` dependency direction works end to end.
- Produces: the frontend shell that Phase 8 grows into the real whiteboard UI.

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
  return <main><h1>SketchMind</h1></main>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sketchmind/web test`
Expected: PASS

- [ ] **Step 5: Verify both apps boot together**

Run: `pnpm run dev`
Expected: web on `http://localhost:3000` rendering "SketchMind"; api on `http://localhost:3001/health` returning `{"status":"ok",...}`. Stop both after confirming.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): scaffold Next.js frontend shell"
```

### Task 6: Root directory placeholders and CI

**Files:**
- Create: `tests/README.md`, `configs/README.md`, `tools/README.md`, `scripts/README.md`, `examples/README.md`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root `build`/`lint`/`test`/`typecheck` scripts (Task 1).
- Produces: the automated form of Volume 17's "Continuous Quality Gates" that every later phase's PRs must pass.

- [ ] **Step 1: Write the directory READMEs**

`tests/README.md` — root-level contract, integration, and end-to-end tests spanning packages; package-local unit tests live in `packages/<name>/tests/` (Volume 11, 17).

`configs/README.md` — centralized config: LLM provider selection, renderer selection, feature flags, logging, cache, plugin registry. Config is injected, never read from global state (Volume 11, 12).

`tools/README.md` — internal developer tooling (codegen, schema generators, migrations), not published.

`scripts/README.md` — CI and one-off automation (release, changelog, benchmark runners).

`examples/README.md` — sample Diagram ASTs, Stroke ASTs, and rendered outputs used as snapshot/regression fixtures (Volume 17).

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
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint
      - run: pnpm run typecheck
      - run: pnpm run build
      - run: pnpm run test
```

- [ ] **Step 3: Verify locally**

Run: `pnpm install --frozen-lockfile && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test`
Expected: all four PASS, mirroring CI.

- [ ] **Step 4: Commit**

```bash
git add tests/README.md configs/README.md tools/README.md scripts/README.md examples/README.md .github/workflows/ci.yml
git commit -m "chore: add directory READMEs and CI quality gate"
```

### Phase 1 Acceptance Criteria

- [ ] `pnpm install` succeeds from a clean clone.
- [ ] `pnpm run build` builds all packages + both apps with no errors.
- [ ] `pnpm run lint` passes, with `import/no-cycle` and the provider-SDK restriction both active and **proven to fail** when violated (Task 3 Step 5).
- [ ] `pnpm run test` passes for all packages and apps.
- [ ] `pnpm run dev` boots `apps/web` (:3000) and `apps/api` (:3001) together.
- [ ] `.env.example` documents the full Azure OpenAI contract; no secrets are committed.
- [ ] CI runs the same four commands and passes.

Matches Volume 18 Phase 1: "Repository builds successfully."

---

## Phase 2 — Core Models

**Maps to:** Volumes 04, 13, 14, 12; Volume 18 Phase 2.
**Deliverable:** "Models compile and validate."

**Packages:** `shared-types` (types + Zod schemas), `diagram-ast` (builder + validator), `utilities`.

**Models to implement** — each a TS type + Zod schema in `shared-types`:

| Model | Source | Notes |
|---|---|---|
| `IntentModel` | V03 | intent, domain, diagram category, complexity, teaching objective |
| `VisualPlan` | V03 | objects, labels, highlights, animations, level of detail — no geometry |
| `VIL` | V13 | version, intent, subject, context, objects, relationships, annotations, emphasis, metadata |
| `ShapeGraph` | V10, V14 | nodes (id/type/category/role/metadata/behaviors/anchors/constraints) + edges |
| `DiagramAST` | V04 | id, version, subject, title, objects, relationships, groups, annotations, metadata |
| `ConstraintGraph` | V05, V14 | nodes = objects, edges = constraints (15 constraint types from V14) |
| `LayoutModel` | V05 | **the only model with geometry**: coordinates, dimensions, rotation, bboxes, connector paths |
| `StrokeAST` | V06 | per stroke: id/type/target/order/dependencies/style/timing/metadata; 12 stroke types |
| `RuntimeEvent` | V09, V12, V16 | discriminated union of all lifecycle events |
| `SketchMindError` | V12 | `{ code, message, package, stage, recoverable }` |
| **`AgentTrace`** | new | per agent step: `{ stepId, agent: "server"\|"client", thought?, toolName?, toolArgs?, toolResult?, tokens, durationMs, timestamp }` — streamed to the UI |

**Validation layer:** `validate<Model>(input: unknown): Result<Model, SketchMindError[]>` for each (V04, V17).

**Acceptance criteria:**
- [ ] Every model exists as an exported type + Zod schema in `shared-types` and nowhere else.
- [ ] `diagram-ast` exposes `buildDiagramAST(...)` and `validateDiagramAST(...)`; a hand-built AST round-trips cleanly.
- [ ] Contract tests prove: duplicate id fails; orphan object fails; unknown constraint type fails (V04 §Validation Rules, V14 §Validation).
- [ ] An automated test asserts no geometry fields (`x`/`y`/`width`/`height`/`rotation`) exist on `DiagramAST`, `ShapeGraph`, `VisualPlan`, or `ConstraintGraph` — mechanically enforcing the Global Constraint.

---

## Phase 3 — LLM Provider Abstraction + Azure OpenAI

**Maps to:** V03 §Multi-LLM Support, V09 §Provider Abstraction, V15 §Multi-Provider Support. **This is the "plug any LLM anytime" phase.**
**Deliverable:** a live Azure OpenAI call returning schema-valid structured JSON through an interface that knows nothing about Azure.

**Packages:** `llm-provider`, `llm-provider-azure-openai`, `llm-provider-anthropic`.

### The interface (`packages/llm-provider`)

```ts
export interface LLMCapabilities {
  structuredOutput: boolean;   // native JSON-schema-constrained output
  toolCalling: boolean;
  parallelToolCalls: boolean;
  streaming: boolean;
  maxContextTokens: number;
}

export interface LLMProvider {
  readonly id: string;                       // "azure-openai" | "anthropic" | ...
  readonly capabilities: LLMCapabilities;

  complete(req: CompletionRequest): Promise<CompletionResponse>;
  completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResponse<T>>;
  stream(req: CompletionRequest): AsyncIterable<CompletionChunk>;
}
```

`completeStructured` is the workhorse: callers pass a Zod schema, and the provider either uses **native structured output** (when `capabilities.structuredOutput`) or falls back to prompt-injected JSON schema + parse-and-repair. Callers never know which happened. This is what lets a weaker local model drop in later without touching agent or pipeline code.

### Azure OpenAI adapter specifics

- Use the official `openai` npm SDK's `AzureOpenAI` client (the current supported path; the standalone `@azure/openai` package is legacy — **verify current guidance at implementation time**).
- Config strictly from env per `.env.example` (Phase 1 Task 4): endpoint, deployment name, API version.
- Auth: support **both** API key and Entra ID via `DefaultAzureCredential` / managed identity. Entra ID is the production path; key is dev convenience.
- Structured output: use JSON-schema `response_format` where the deployed model and API version support it; set `capabilities.structuredOutput` from an explicit config/probe rather than hardcoding — AI Foundry deployments vary by model and API version.
- Map Azure errors (429 rate limit + `Retry-After`, content filter, deployment-not-found, quota) into `SketchMindError` with correct `recoverable` flags. Content-filter rejections are **not** retryable; 429s are.
- Never log request/response bodies containing user content at info level.

**Acceptance criteria:**
- [ ] A live integration test (skipped unless Azure env vars are present) sends a request and gets back an object matching a supplied Zod schema.
- [ ] The same test passes against a **fake in-memory provider** implementing `LLMProvider`, with zero test-code changes — proving callers are provider-agnostic.
- [ ] `SKETCHMIND_LLM_PROVIDER=anthropic` selects the second adapter with no code change outside config.
- [ ] `grep -r "openai\|azure" packages/ --exclude-dir=llm-provider-azure-openai` returns no source hits outside the adapter (and CI lint enforces it, per Phase 1).
- [ ] A provider with `structuredOutput: false` still returns schema-valid objects via the repair fallback.
- [ ] Rate-limit (429) responses retry with backoff honoring `Retry-After`; content-filter responses fail fast as non-recoverable.

---

## Phase 4 — AI Reasoning Layer

**Maps to:** V03, V10, V15; Volume 18 Phase 3.
**Deliverable:** "Natural language → validated Diagram AST."

**Packages:** `intent-analyzer`, `visual-planner`, `shape-intelligence`, `diagram-reasoner`, plus the prompt repository.

**Agent contracts** (V12, V15) — each takes and returns typed models, all via `LLMProvider.completeStructured`:
- `intent-analyzer.analyze(text) → IntentModel`
- `visual-planner.plan(intent) → VisualPlan`
- `shape-intelligence.reason(plan) → { graph: ShapeGraph, newPrimitives: PrimitiveDefinition[] }` — **must search the primitive registry before generating anything new** (V10 §Primitive Discovery)
- `diagram-reasoner.compose(graph) → DiagramAST`

**Prompt repository:** one versioned prompt module per agent following V15's Standard Prompt Template (System Instructions, Agent Objective, Allowed Inputs, Expected Output, Forbidden Output, Completion Rules), each shipping few-shot examples (minimum, complex, invalid, recovery). Prompts live as data files, isolated from application code (V15).

**Retry:** retry only on schema-invalid / missing-fields / empty-response / provider-timeout (V15). Deterministic stages never retry.

**Acceptance criteria:**
- [ ] `"Draw a movable pulley."` produces a `DiagramAST` containing at minimum ceiling, fixed pulley, movable pulley, rope, load — passing `validateDiagramAST`.
- [ ] Every agent output is schema-validated before the next agent sees it; a deliberately malformed response triggers exactly one retry then a structured recoverable error.
- [ ] No agent output contains `x`, `y`, `svg`, or `canvasCommand` fields (automated check).
- [ ] All four agents run against the fake provider from Phase 3 in unit tests — no network calls in the default test suite.

---

## Phase 5 — Layout Engine

**Maps to:** V05; Volume 18 Phase 4.
**Deliverable:** "Diagram AST → Layout Model." Deterministic, no AI.

**Packages:** `constraint-engine`, `layout-engine`.

- `constraint-engine`: derive constraints (above/below/inside/outside/attachedTo/connectedTo/wrapsAround/centeredOn/alignedWith/parallelTo/perpendicularTo) from `DiagramAST.relationships`. Produces zero geometry.
- `layout-engine`: solve `ConstraintGraph` → `LayoutModel` (position, size, rotation, bbox, connection points). Implement **2 strategies for MVP** (Hierarchical + Grid) behind a strategy interface open for Radial/Tree/Flow/Circular/Force-directed/Manual later. Plus collision detection (object/label/connector overlap → auto-resolve), label placement, and straight connector routing (orthogonal/curved/smart-avoidance deferred).

**Acceptance criteria:**
- [ ] The pulley `DiagramAST` yields a `LayoutModel` with no overlapping bounding boxes and every relationship-referenced object positioned (V05 §Validation).
- [ ] Identical input always yields identical output (determinism — V02, V05).
- [ ] Strategy selection is driven by diagram type/metadata, not hardcoded at call sites.
- [ ] `LayoutModel` remains the only model with numeric coordinates (re-run the Phase 2 check).

---

## Phase 6 — Stroke Engine

**Maps to:** V06; Volume 18 Phase 5.
**Deliverable:** "Layout Model → animated Stroke AST." Still renderer-independent.

**Packages:** `stroke-planner`, `stroke-runtime`.

- `stroke-planner`: `LayoutModel` → ordered `StrokeAST` following V06 §Human Drawing Rules — large outlines first, detail after, labels last, connected objects drawn continuously, no unnatural pen jumps, predictable order. Then a **Stroke Optimizer** pass that merges compatible strokes without changing semantic meaning.
- `stroke-runtime`: play/pause/resume/seek/replay/undo/redo/cancel over a timeline model (delay, duration, speed, pause, dependencies). Exposes progressive-rendering hooks and the editing API (insert/delete/move/replace/reorder), all deterministic.

**Acceptance criteria:**
- [ ] The pulley `LayoutModel` yields a natural stroke order (ceiling → pulleys → rope → load → force arrow → labels last).
- [ ] Play, pause mid-sequence, resume, and replay are deterministic across runs (same strokes, order, timing).
- [ ] Undo removes exactly the last stroke; redo restores it; no side effects elsewhere.
- [ ] The optimizer never changes which objects exist — verified by diffing pre/post object coverage, not stroke count.

---

## Phase 7 — Renderer

**Maps to:** V08; Volume 18 Phase 6.
**Deliverable:** first real pixels, via Konva, driven purely by `stroke-runtime` events.

**Packages:** `renderer-core`, `renderer-konva`, `renderer-svg` (skeleton), `export-engine` (PNG).

- `renderer-core`: adapter interface (`initialize/destroy/drawStroke/eraseStroke/updateStroke/renderFrame/resizeViewport/export`), layer model (Background/Grid/Shapes/Connectors/Labels/Highlights/Animations/Debug), viewport (pan/zoom/fit/center), hit-testing (object/anchor/stroke/region/hover), renderer registry.
- `renderer-konva`: implement the adapter against Konva. Must honor V08's "must NOT" list — no AI calls, no layout computation, no Stroke AST mutation, no business rules.
- `renderer-svg`: skeleton implementing the same interface, enough to prove backend-agnosticism (not production in MVP).

**Acceptance criteria:**
- [ ] `renderer-konva` draws every stroke of the pulley `StrokeAST` in order and matches a checked-in reference PNG within a pixel-diff tolerance (V17 §Snapshot Testing).
- [ ] Play/pause/resume from `stroke-runtime` visibly controls progressive drawing.
- [ ] `renderer-konva` imports nothing from any AI, agent, constraint, or layout package (lint-enforced).
- [ ] PNG export produces a file containing all drawn objects.
- [ ] Hit-testing returns the correct object id when clicking a rendered component — **required for the client agent in Phase 10.**

---

## Phase 8 — Web Application + Streaming Protocol

**Maps to:** V09 §Streaming, V16 §Event Bus; new requirement (frontend for real testing).
**Deliverable:** **the first end-to-end testable slice** — type a request in the browser, watch it draw live.

**Packages/apps:** `session-protocol`, `apps/api`, `apps/web`.

### `session-protocol`

The typed contract between browser and server. Two directions:

- **Server → Client events:** `SessionStarted`, `StageStarted`, `StageCompleted`, `ValidationFailed`, `DiagramASTReady`, `LayoutReady`, `StrokeGenerated`, `AgentStep` (an `AgentTrace`), `SessionCompleted`, `SessionFailed`.
- **Client → Server commands:** `StartSession`, `CancelSession`, `AgentToolProxy` (client agent requesting an LLM turn), `FollowUpRequest`.

Transport: SSE for server→client streaming, plain POST for client→server commands (WebSocket is a drop-in later; the protocol is transport-agnostic by design).

### `apps/api`

Routes: `POST /api/sessions` (start), `GET /api/sessions/:id/stream` (SSE), `POST /api/sessions/:id/cancel`, `POST /api/agent/llm` (**the client-agent LLM proxy — this is why Azure keys never reach the browser**).

### `apps/web`

- Prompt input box
- Whiteboard canvas mounting `renderer-konva`
- Playback controls (play/pause/speed/replay/undo/redo)
- **Agent trace panel** — live view of every agent step (thought, tool, args, result, timing, tokens). This is your primary debugging surface.
- Diagram inspector — the Diagram AST / Layout Model / Stroke AST as inspectable JSON per session

**Acceptance criteria:**
- [ ] Typing "Draw a movable pulley" in the browser draws it on the canvas, live, stroke by stroke.
- [ ] The trace panel shows every pipeline stage with timing as it happens.
- [ ] Cancel mid-draw stops the pipeline promptly and leaves no dangling session.
- [ ] The inspector shows a valid Diagram AST for the drawn diagram.
- [ ] No Azure credential, endpoint, or provider SDK appears in any browser bundle (verify by inspecting the built client bundle).
- [ ] Manually verified via the `run` skill.

---

## Phase 9 — Server-Side Agent

**Maps to:** V09 (orchestration as an agent), V10 (primitive generation/learning); new requirement.
**Deliverable:** the server stops being a fixed assembly line and becomes an agent that can loop, self-check, and revise.

**Packages:** `agent-core`, `agent-tools-server`.

### `agent-core` (shared by both agents)

The loop: `observe → reason (LLM) → select tool → execute → observe → …` until goal or budget exhausted. Provides: tool registry with Zod-typed args, step budget + token budget + wall-clock timeout, cancellation token, structured `AgentTrace` emission per step, error recovery (tool failure → observation, not crash). Depends on `llm-provider` — **never on a specific provider.**

### `agent-tools-server`

The tool surface. Each is a typed, validated function the agent may call:

| Tool | Purpose |
|---|---|
| `analyze_intent` | run Intent Analyzer |
| `plan_visual` | run Visual Planner |
| `search_primitives` | query the registry before inventing anything |
| `generate_primitive` | create + register a new semantic primitive (V10) |
| `build_shape_graph` | run Shape Intelligence |
| `compose_diagram_ast` | run Diagram Reasoner |
| `validate_diagram` | run validators, get structured errors back |
| `compute_layout` | run constraint + layout engines |
| `critique_layout` | inspect the `LayoutModel` for overlaps/crowding/imbalance and report — **lets the agent judge its own output and retry** |
| `plan_strokes` | run Stroke Planner |

The critical capability this unlocks: the agent computes a layout, critiques it, decides the diagram is too sparse or components are mispositioned, and goes *back* to revise the Diagram AST — something the linear pipeline structurally cannot do.

**Acceptance criteria:**
- [ ] The server agent completes the pulley request end to end using tools only, with a full trace.
- [ ] Given a deliberately under-specified request ("draw a pulley thing"), the agent asks `search_primitives`, finds nothing suitable, calls `generate_primitive`, and proceeds — visible in the trace.
- [ ] When `critique_layout` reports overlaps, the agent revises rather than shipping the bad layout (test with a seeded crowded diagram).
- [ ] Step/token/time budgets are enforced — a pathological request terminates cleanly with a partial result, never an infinite loop.
- [ ] The agent runs identically against the fake provider and Azure OpenAI.

---

## Phase 10 — Client-Side Agent

**Maps to:** new requirement.
**Deliverable:** an agent in the browser that acts on the board on its own.

**Packages:** `agent-tools-canvas`, `client-agent`.

### `agent-tools-canvas`

Tools over the already-rendered diagram — the client agent's hands:

| Tool | Purpose |
|---|---|
| `highlight_object` / `clear_highlights` | draw attention to a component |
| `zoom_to` / `fit_to_content` | viewport control |
| `annotate` | add a callout/label to an existing object |
| `pause_playback` / `resume_playback` / `set_speed` | pacing |
| `erase_object` / `redraw_object` | local correction without a full redraw |
| `select_object` / `query_diagram` | read the current Diagram AST + what's on screen |
| `request_server_extension` | ask the server agent to extend the diagram (new components) |

Everything here operates through `renderer-core` and `stroke-runtime` public APIs — the client agent never touches Konva directly.

### `client-agent`

Uses `agent-core` with the canvas tools. Its LLM turns go through `POST /api/agent/llm` — **no keys, no provider SDK in the browser.**

Scenarios it handles autonomously:
- User clicks the rope → agent highlights it, zooms, annotates an explanation.
- User asks a follow-up ("now show the effort direction") → agent decides whether it can annotate locally or must call `request_server_extension`. Annotating an existing diagram instead of redrawing from scratch is the main win.
- Presentation pacing — pause on complex components, highlight in teaching order.
- User says "that label is in the way" → agent moves it locally.

**Acceptance criteria:**
- [ ] Clicking a rendered component triggers the client agent to highlight and explain it, with no full redraw.
- [ ] A follow-up that only needs annotation is handled entirely client-side (verified: no new server session in the network log).
- [ ] A follow-up needing new components correctly escalates via `request_server_extension`.
- [ ] Client agent steps appear in the same trace panel as server steps, distinguished by `agent: "client"`.
- [ ] Client agent budgets are enforced; a runaway loop terminates.
- [ ] The built browser bundle contains no provider SDK and no credentials (automated bundle check in CI).

---

## Phase 11 — Plugin System

**Maps to:** V07; Volume 18 Phase 7.
**Deliverable:** "External primitives load without modifying the core."

**Packages:** `primitive-sdk`, `plugin-sdk`.

- `primitive-sdk`: manifest schema (id/name/version/category/author/license/dependencies/supportedRenderers/supportedBehaviors), validation pipeline (manifest/schema/anchors/behaviors/constraints/examples — invalid primitives must not load), registry (register/resolve versions/discover/validate deps/load).
- `plugin-sdk`: plugin loading for subject packs, primitive packs, renderers, layout strategies, stroke generators, exporters — public interfaces only.

**Acceptance criteria:**
- [ ] A hand-authored example primitive ("Gear") registers with no change to any core package.
- [ ] The Phase 9 `search_primitives` tool finds and reuses it — the same concept requested twice generates a primitive once and reuses it the second time. **This closes V10's learning loop.**
- [ ] An invalid primitive (missing required anchor) is rejected at load with a structured error, never reaching the registry.
- [ ] `renderer-konva` loads through the same plugin path, proving renderer-agnosticism.

---

## Phase 12 — End-to-End Integration & MVP Close

**Maps to:** V09 (full), V16, V17, Volume 18 Phase 8.
**Deliverable:** everything wired, observable, recoverable, benchmarked.

**Packages:** `ai-orchestrator` (now full), all packages as participants.

Work not covered earlier:
- Orchestrator running the full stage sequence with a validation gate after every stage (V09).
- Session / Execution Context / Pipeline State / Drawing State / Playback State / Renderer State as **distinct, non-merged, serializable** models (V16).
- Checkpoints after Intent Analysis, Diagram AST, Layout Model, Stroke AST, with resume-from-latest-valid (V16).
- Caching (intent, AST, primitive resolution, layout, strokes) keyed by model version **and provider id** — a cache entry from Azure must not be served to a different provider (V09).
- Cancellation stopping AI, agents, and rendering, releasing resources, preserving diagnostics (V16).
- Observability: stage duration, token usage, cache hits, retry count, validation failures, render time/FPS, memory (V09, V16).

**MVP acceptance criteria** (Volume 18 §Acceptance Criteria, §Definition of Done):
- [ ] "Explain a movable pulley" typed in `apps/web` produces a valid Diagram AST, computed layout, and live animated drawing, with both agent traces visible — no manual intervention.
- [ ] Resuming from a checkpoint produces an equivalent final render.
- [ ] Undo/redo works against the live orchestrated session.
- [ ] Export (PNG minimum) works from the session.
- [ ] Cancelling mid-pipeline stops AI and rendering promptly with no dangling state.
- [ ] Switching `SKETCHMIND_LLM_PROVIDER` from `azure-openai` to the second adapter runs the same flow with **no code change** — the LLM-independence requirement, proven end to end.
- [ ] All unit, contract, and a new full-flow system test pass in CI.
- [ ] Benchmarks (AI latency, layout time, stroke time, render FPS) collected and within agreed thresholds (V17).

---

## Self-Review Notes

- **Spec coverage:** every Volume 01–18 concept maps to a phase. Volumes 01–02 are framing, enforced through Global Constraints rather than a standalone phase.
- **New requirements coverage:** LLM independence → Phase 3 + two lint-enforced Global Constraints + Phase 12 acceptance test; Azure OpenAI → Phase 3; web frontend → Phase 8; server agent → Phase 9; client agent → Phase 10.
- **Deferred by design:** Phases 2–12 stop short of bite-sized code steps (see Scope Note) — the docs leave exact schema fields, prompt text, and tool signatures to implementation, and pre-committing them now would mean discarding work.
- **Type consistency:** package names, model names, tool names, and stage order are used identically throughout and match Volume 12 §Common Models.
- **Open items flagged for implementation time:** current Azure OpenAI API version and structured-output support for your specific AI Foundry deployment (Phase 3); SSE vs WebSocket final choice (Phase 8); exact critique heuristics for `critique_layout` (Phase 9).
