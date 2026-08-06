# `apps/studio` — Vite + Tailwind Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `apps/studio` (`@sketchmind/studio`), a Vite + React 19 + Tailwind CSS web app that reproduces the existing `apps/web` UI, SSE protocol behavior, canvas whiteboard, trace panel, and inspector with full feature parity.

**Architecture:** A lightweight client SPA using Vite and Tailwind v4. It imports `@sketchmind/renderer-konva` directly without SSR wrappers, hooks into `apps/api` via SSE (`useSession`), and registers with workspace layering and client bundle security checks.

**Tech Stack:** React 19, Vite, `@vitejs/plugin-react`, Tailwind CSS v4 (`@tailwindcss/vite`), Vitest, `@testing-library/react`, jsdom, TypeScript.

---

### Task 1: Package Scaffolding & Configuration

**Files:**
- Create: `apps/studio/package.json`
- Create: `apps/studio/tsconfig.json`
- Create: `apps/studio/vite.config.ts`
- Create: `apps/studio/vitest.config.ts`

- [ ] **Step 1: Create `apps/studio/package.json`**

```json
{
  "name": "@sketchmind/studio",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "lint": "eslint src tests",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@sketchmind/renderer-core": "workspace:*",
    "@sketchmind/renderer-konva": "workspace:*",
    "@sketchmind/session-protocol": "workspace:*",
    "@sketchmind/shared-types": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/react": "^16.1.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `apps/studio/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `apps/studio/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    strictPort: true,
  },
});
```

- [ ] **Step 4: Create `apps/studio/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
  },
});
```

- [ ] **Step 5: Run pnpm install to link dependencies**

Run: `pnpm install`
Expected: Dependencies resolved, `node_modules` updated in `apps/studio`.

- [ ] **Step 6: Commit**

Check `.agent/config.yml` for `auto_commit` setting.
If `auto_commit: true`:
```bash
git add apps/studio/package.json apps/studio/tsconfig.json apps/studio/vite.config.ts apps/studio/vitest.config.ts pnpm-lock.yaml
git commit -m "feat(studio): initialize apps/studio package configuration"
```

---

### Task 2: HTML, Theme Styles, Hooks & Application Components

**Files:**
- Create: `apps/studio/index.html`
- Create: `apps/studio/src/index.css`
- Create: `apps/studio/src/hooks/useSession.ts`
- Create: `apps/studio/src/components/Whiteboard.tsx`
- Create: `apps/studio/src/components/Inspector.tsx`
- Create: `apps/studio/src/components/TracePanel.tsx`
- Create: `apps/studio/src/App.tsx`
- Create: `apps/studio/src/main.tsx`

- [ ] **Step 1: Create `apps/studio/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SketchMind</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `apps/studio/src/index.css`**

```css
@import "tailwindcss";

@theme {
  --color-ink: #1f2328;
  --color-muted: #656d76;
  --color-line: #d8dee4;
  --color-surface: #ffffff;
  --color-panel: #f6f8fa;
  --color-danger: #b4232c;
}

:root {
  color-scheme: light;
}

body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
  color: var(--color-ink);
  background-color: var(--color-panel);
}
```

- [ ] **Step 3: Create `apps/studio/src/hooks/useSession.ts`**

```typescript
/**
 * One drawing session, as React state.
 *
 * The whole client side of the protocol is here: start a session, open its
 * stream, fold each event into state, cancel. Everything below is presentation.
 *
 * Events are *validated*, not cast. `decodeServerEvent` returns a
 * `ValidationResult`, and the exhaustive `switch` in `reduce` is only sound
 * because of it -- `JSON.parse` would give the same TypeScript types with none
 * of the guarantee.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { decodeServerEvent, type RuntimeEvent } from "@sketchmind/session-protocol";
import type {
  AgentTraceStep,
  BoundingBox,
  DiagramAST,
  DrawingFrame,
} from "@sketchmind/shared-types";

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:3001";

export type SessionPhase = "idle" | "thinking" | "drawing" | "done" | "failed" | "cancelled";

export interface SessionState {
  readonly phase: SessionPhase;
  readonly sessionId?: string;
  /** Newest last. The trace panel renders these in order. */
  readonly steps: readonly AgentTraceStep[];
  readonly ast?: DiagramAST;
  readonly frame?: DrawingFrame;
  /** Extent of the whole drawing, for fitting the viewport once. */
  readonly bounds?: BoundingBox;
  readonly strokesDrawn: number;
  readonly error?: string;
}

const IDLE: SessionState = { phase: "idle", steps: [], strokesDrawn: 0 };

function reduce(state: SessionState, event: RuntimeEvent): SessionState {
  switch (event.type) {
    case "SessionStarted":
      return { ...IDLE, phase: "thinking", sessionId: event.sessionId };

    case "AgentStep":
      return {
        ...state,
        steps: [
          ...state.steps,
          {
            stepId: event.stepId,
            locus: event.locus,
            ...(event.thought === undefined ? {} : { thought: event.thought }),
            ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
            ...(event.toolArgs === undefined ? {} : { toolArgs: event.toolArgs }),
            ...(event.toolResult === undefined ? {} : { toolResult: event.toolResult }),
            ...(event.error === undefined ? {} : { error: event.error }),
            tokensIn: event.tokensIn ?? 0,
            tokensOut: event.tokensOut ?? 0,
            durationMs: event.durationMs ?? 0,
            timestamp: event.at,
          },
        ],
      };

    case "DiagramASTReady":
      return { ...state, ast: event.ast };

    case "FrameUpdate":
      return {
        ...state,
        phase: "drawing",
        frame: event.frame,
        bounds: state.bounds ?? event.bounds,
      };

    case "StrokeCompleted":
      return { ...state, strokesDrawn: state.strokesDrawn + 1 };

    case "SessionCompleted":
      return { ...state, phase: "done" };

    case "SessionFailed":
      return { ...state, phase: "failed", error: event.error.message };

    case "SessionCancelled":
      return { ...state, phase: "cancelled" };

    case "StageStarted":
    case "StageCompleted":
    case "StrokeStarted":
    case "PlaybackPaused":
    case "PlaybackResumed":
    case "VisionCritique":
      return state;
  }
}

export interface Session {
  readonly state: SessionState;
  start: (userInput: string) => Promise<void>;
  cancel: () => Promise<void>;
}

export function useSession(): Session {
  const [state, setState] = useState<SessionState>(IDLE);
  const source = useRef<EventSource | null>(null);
  const sessionId = useRef<string | undefined>(undefined);

  const close = useCallback(() => {
    source.current?.close();
    source.current = null;
  }, []);

  useEffect(() => close, [close]);

  const start = useCallback(
    async (userInput: string) => {
      close();
      setState({ ...IDLE, phase: "thinking" });

      const response = await fetch(`${API}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userInput }),
      });

      if (!response.ok) {
        setState({ ...IDLE, phase: "failed", error: `The server refused the request (${response.status}).` });
        return;
      }

      const { sessionId: id } = (await response.json()) as { sessionId: string };
      sessionId.current = id;

      const stream = new EventSource(`${API}/api/sessions/${id}/stream`);
      source.current = stream;

      stream.onmessage = (message: MessageEvent<string>) => {
        const decoded = decodeServerEvent(`data: ${message.data}\n\n`);
        if (!decoded.ok) return;
        setState((current) => reduce(current, decoded.value));
        if (TERMINAL.has(decoded.value.type)) close();
      };

      stream.onerror = () => {
        if (stream.readyState === EventSource.CLOSED) {
          setState((current) =>
            current.phase === "done" || current.phase === "cancelled"
              ? current
              : { ...current, phase: "failed", error: "The connection to the server was lost." },
          );
        }
      };
    },
    [close],
  );

  const cancel = useCallback(async () => {
    const id = sessionId.current;
    if (!id) return;
    await fetch(`${API}/api/sessions/${id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "cancelled by the viewer" }),
    });
  }, []);

  return { state, start, cancel };
}

const TERMINAL = new Set<RuntimeEvent["type"]>([
  "SessionCompleted",
  "SessionFailed",
  "SessionCancelled",
]);
```

- [ ] **Step 4: Create `apps/studio/src/components/Whiteboard.tsx`**

```typescript
import { useEffect, useRef } from "react";
import { createKonvaRenderer } from "@sketchmind/renderer-konva";
import type { RendererAdapter } from "@sketchmind/renderer-core";
import type { BoundingBox, DrawingFrame } from "@sketchmind/shared-types";

export interface WhiteboardProps {
  readonly frame?: DrawingFrame;
  readonly bounds?: BoundingBox;
  readonly width?: number;
  readonly height?: number;
}

export default function Whiteboard({
  frame,
  bounds,
  width = 900,
  height = 600,
}: WhiteboardProps): React.JSX.Element {
  const mount = useRef<HTMLDivElement>(null);
  const adapter = useRef<RendererAdapter | null>(null);

  useEffect(() => {
    if (!mount.current) return;

    const created = createKonvaRenderer({
      size: { width, height },
      container: mount.current,
    });
    if (!created.ok) return;

    adapter.current = created.value;
    return () => {
      adapter.current?.destroy();
      adapter.current = null;
    };
  }, [width, height]);

  useEffect(() => {
    if (adapter.current && bounds) adapter.current.fitToContent(bounds);
  }, [bounds]);

  useEffect(() => {
    if (adapter.current && frame) adapter.current.renderFrame(frame);
  }, [frame]);

  return (
    <div
      ref={mount}
      className="bg-surface border border-line rounded-lg overflow-hidden"
      style={{ width, height }}
    />
  );
}
```

- [ ] **Step 5: Create `apps/studio/src/components/Inspector.tsx`**

```typescript
import type { DiagramAST, DiagramObject } from "@sketchmind/shared-types";

function ObjectNode({ object }: { object: DiagramObject }): React.JSX.Element {
  return (
    <li>
      <span>{object.name}</span> <span className="text-muted font-mono text-xs">{object.type}</span>
      {object.labels.length > 0 ? (
        <span className="text-muted">“{object.labels.map((label) => label.text).join("”, “")}”</span>
      ) : null}
      {object.children.length > 0 ? (
        <ul className="m-0 pl-[18px]">
          {object.children.map((child) => (
            <ObjectNode key={child.id} object={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function Inspector({ ast }: { ast?: DiagramAST }): React.JSX.Element {
  if (!ast) return <p className="m-0 text-muted">No diagram yet.</p>;

  return (
    <div>
      <h3 className="m-0 text-[15px] font-bold">{ast.title}</h3>
      <p className="mt-[2px] mb-[10px] text-muted">
        {ast.subject} · {ast.category}
      </p>

      <ul className="m-0 pl-[18px]">
        {ast.objects.map((object) => (
          <ObjectNode key={object.id} object={object} />
        ))}
      </ul>

      {ast.relationships.length > 0 ? (
        <ul className="mt-[10px] mb-0 pl-[18px] text-muted">
          {ast.relationships.map((relationship) => (
            <li key={relationship.id}>
              {relationship.from} <em>{relationship.type}</em> {relationship.to}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Create `apps/studio/src/components/TracePanel.tsx`**

```typescript
import type { AgentTraceStep } from "@sketchmind/shared-types";

const MAX_RESULT_CHARS = 400;

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text;
}

export function TracePanel({ steps }: { steps: readonly AgentTraceStep[] }): React.JSX.Element {
  if (steps.length === 0) {
    return <p className="m-0 text-muted">No steps yet.</p>;
  }

  return (
    <ol className="m-0 p-0 list-none flex flex-col gap-2">
      {steps.map((step) => (
        <li
          key={step.stepId}
          className={`border rounded-md p-2 ${step.error ? "border-danger" : "border-line"}`}
        >
          <header className="flex justify-between gap-2">
            <span className="font-mono font-semibold">{step.toolName ?? "answered"}</span>
            <span className="text-muted tabular-nums">
              {Math.round(step.durationMs)}ms · {step.tokensIn}/{step.tokensOut} tok
            </span>
          </header>

          {step.thought ? <p className="mt-[6px] mb-0">{step.thought}</p> : null}

          {step.toolArgs ? (
            <pre className="mt-[6px] mb-0 p-[6px] bg-panel rounded font-mono text-xs whitespace-pre-wrap break-words">
              {preview(step.toolArgs)}
            </pre>
          ) : null}

          {step.error ? (
            <p className="mt-[6px] mb-0 text-danger">
              {step.error.code}: {step.error.message}
            </p>
          ) : step.toolResult === undefined ? null : (
            <pre className="mt-[6px] mb-0 p-[6px] bg-panel rounded font-mono text-xs whitespace-pre-wrap break-words">
              {preview(step.toolResult)}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 7: Create `apps/studio/src/App.tsx`**

```typescript
import { useState, type FormEvent } from "react";
import Whiteboard from "./components/Whiteboard";
import { Inspector } from "./components/Inspector";
import { TracePanel } from "./components/TracePanel";
import { useSession } from "./hooks/useSession";

const BUSY = new Set(["thinking", "drawing"]);

export default function App(): React.JSX.Element {
  const [prompt, setPrompt] = useState("Draw a movable pulley");
  const { state, start, cancel } = useSession();
  const busy = BUSY.has(state.phase);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!busy && prompt.trim()) void start(prompt.trim());
  };

  return (
    <main className="p-4 flex flex-col gap-4 min-h-screen">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="m-0 text-[18px] tracking-tight font-bold">SketchMind</h1>
        <form onSubmit={submit} className="flex gap-2 flex-1 flex-shrink flex-grow basis-[420px]">
          <input
            aria-label="What should I draw?"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Draw a movable pulley"
            disabled={busy}
            className="flex-1 px-[10px] py-[7px] border border-line rounded-md bg-surface font-inherit disabled:opacity-45"
          />
          <button
            type="submit"
            disabled={busy || prompt.trim() === ""}
            className="px-[14px] py-[7px] border border-line rounded-md bg-surface font-inherit cursor-pointer disabled:opacity-45 disabled:cursor-default"
          >
            Draw
          </button>
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={!busy}
            className="px-[14px] py-[7px] border border-line rounded-md bg-surface font-inherit cursor-pointer disabled:opacity-45 disabled:cursor-default"
          >
            Cancel
          </button>
        </form>
        <p className="m-0 text-muted" role="status">
          {STATUS[state.phase]}
          {state.strokesDrawn > 0 ? ` · ${state.strokesDrawn} strokes` : ""}
        </p>
        {state.error ? <p className="m-0 text-danger">{state.error}</p> : null}
      </header>

      <div className="grid grid-cols-1 min-[1100px]:grid-cols-[minmax(0,1fr)_380px] grid-rows-[auto_auto] gap-4 items-start">
        <section className="min-[1100px]:row-span-2">
          <Whiteboard
            {...(state.frame ? { frame: state.frame } : {})}
            {...(state.bounds ? { bounds: state.bounds } : {})}
          />
        </section>

        <section className="bg-surface border border-line rounded-lg p-3 max-h-[46vh] overflow-auto">
          <h2 className="mt-0 mb-2 text-xs uppercase tracking-wider text-muted font-bold">
            Agent trace
          </h2>
          <TracePanel steps={state.steps} />
        </section>

        <section className="bg-surface border border-line rounded-lg p-3 max-h-[46vh] overflow-auto">
          <h2 className="mt-0 mb-2 text-xs uppercase tracking-wider text-muted font-bold">
            Diagram
          </h2>
          <Inspector {...(state.ast ? { ast: state.ast } : {})} />
        </section>
      </div>
    </main>
  );
}

const STATUS: Record<string, string> = {
  idle: "Ready.",
  thinking: "Thinking…",
  drawing: "Drawing…",
  done: "Done.",
  failed: "Failed.",
  cancelled: "Cancelled.",
};
```

- [ ] **Step 8: Create `apps/studio/src/main.tsx`**

```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
```

- [ ] **Step 9: Run typecheck on `apps/studio`**

Run: `pnpm --filter @sketchmind/studio typecheck`
Expected: Passes with no errors.

- [ ] **Step 10: Commit**

Check `.agent/config.yml` for `auto_commit` setting.
If `auto_commit: true`:
```bash
git add apps/studio/index.html apps/studio/src
git commit -m "feat(studio): add App components, useSession hook and Tailwind styles"
```

---

### Task 3: Unit and Integration Tests

**Files:**
- Create: `apps/studio/tests/App.test.tsx`

- [ ] **Step 1: Create `apps/studio/tests/App.test.tsx`**

```typescript
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { encodeServerEvent } from "@sketchmind/session-protocol";
import type { RuntimeEvent } from "@sketchmind/shared-types";
import App from "../src/App";

vi.mock("../src/components/Whiteboard", () => ({
  default: () => <div data-testid="board" />,
}));

class FakeEventSource {
  static last: FakeEventSource | undefined;
  static readonly CLOSED = 2;

  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  deliver(event: RuntimeEvent): void {
    const data = encodeServerEvent(event)
      .split("\n")
      .find((line) => line.startsWith("data:"))!
      .slice("data:".length)
      .trim();
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

const AST = {
  id: "pulley_system",
  version: "1.0",
  subject: "movable pulley",
  title: "Movable Pulley",
  category: "schematic",
  objects: [
    {
      id: "pulley",
      type: "pulley",
      name: "Pulley",
      category: "mechanical",
      anchors: [{ name: "rim" }],
      behaviors: [],
      labels: [{ id: "l1", text: "Pulley" }],
      children: [],
    },
  ],
  relationships: [],
  groups: [],
  annotations: [],
  metadata: { tags: [] },
} as unknown as Extract<RuntimeEvent, { type: "DiagramASTReady" }>["ast"];

const event = <T extends RuntimeEvent["type"]>(
  type: T,
  extra: object = {},
): RuntimeEvent => ({ type, sessionId: "s1", at: "2026-08-06T00:00:00.000Z", ...extra }) as RuntimeEvent;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  FakeEventSource.last = undefined;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ sessionId: "s1" }), { status: 202 })),
  );
});

async function startDrawing(): Promise<FakeEventSource> {
  render(<App />);
  await act(async () => {
    screen.getByRole("button", { name: "Draw" }).click();
  });
  await waitFor(() => expect(FakeEventSource.last).toBeDefined());
  return FakeEventSource.last!;
}

describe("studio app page", () => {
  it("renders the app title", () => {
    render(<App />);
    expect(screen.getByText("SketchMind")).toBeTruthy();
  });

  it("starts idle with nothing to show", () => {
    render(<App />);
    expect(screen.getByRole("status").textContent).toContain("Ready");
    expect(screen.getByText("No steps yet.")).toBeTruthy();
    expect(screen.getByText("No diagram yet.")).toBeTruthy();
  });

  it("opens a stream for the session the server minted", async () => {
    const stream = await startDrawing();
    expect(stream.url).toContain("/api/sessions/s1/stream");
    expect(screen.getByRole("status").textContent).toContain("Thinking");
  });

  it("shows each agent step with its tool and cost as it arrives", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "Draw a movable pulley" }));
      stream.deliver(
        event("AgentStep", {
          stepId: "s1-1",
          locus: "server",
          toolName: "compose_diagram_ast",
          durationMs: 812,
          tokensIn: 120,
          tokensOut: 40,
        }),
      );
    });

    expect(screen.getByText("compose_diagram_ast")).toBeTruthy();
    expect(screen.getByText(/812ms/)).toBeTruthy();
    expect(screen.getByText(/120\/40 tok/)).toBeTruthy();
  });

  it("shows a failed step's error rather than swallowing it", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
      stream.deliver(
        event("AgentStep", {
          stepId: "s1-1",
          locus: "server",
          toolName: "solve_layout",
          error: {
            code: "GEOMETRY_MISSING_INPUT",
            message: "No constraint graph yet.",
            package: "@sketchmind/agent-tools-geometry",
            stage: "layout",
            recoverable: true,
          },
        }),
      );
    });

    expect(screen.getByText(/GEOMETRY_MISSING_INPUT/)).toBeTruthy();
  });

  it("fills the inspector as soon as the diagram exists", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
      stream.deliver(event("DiagramASTReady", { ast: AST }));
    });

    expect(screen.getByText("Movable Pulley")).toBeTruthy();
    expect(screen.getByText("Pulley")).toBeTruthy();
    expect(screen.queryByText("No diagram yet.")).toBeNull();
  });

  it("counts strokes as they complete", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
      stream.deliver(event("StrokeCompleted", { strokeId: "st1" }));
      stream.deliver(event("StrokeCompleted", { strokeId: "st2" }));
    });

    expect(screen.getByRole("status").textContent).toContain("2 strokes");
  });

  it("closes the stream once the session ends", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
      stream.deliver(event("SessionCompleted", { durationMs: 4200 }));
    });

    expect(screen.getByRole("status").textContent).toContain("Done");
    expect(stream.closed).toBe(true);
  });

  it("surfaces a failure with the server's own reason", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
      stream.deliver(
        event("SessionFailed", {
          error: {
            code: "SESSION_NO_STROKES",
            message: "The agent finished without planning any strokes.",
            package: "@sketchmind/api",
            stage: "stroke",
            recoverable: true,
          },
        }),
      );
    });

    expect(screen.getByText(/without planning any strokes/)).toBeTruthy();
  });

  it("ignores a frame that is not a valid event, rather than rendering garbage", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
      stream.onmessage?.(new MessageEvent("message", { data: '{"type":"Nope"}' }));
    });

    expect(screen.getByRole("status").textContent).toContain("Thinking");
  });

  it("cancels the session the server told it about", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
    });

    await act(async () => {
      screen.getByRole("button", { name: "Cancel" }).click();
    });

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.at(-1)?.[0]).toContain("/api/sessions/s1/cancel");
  });

  it("disables Draw while a session is running, and Cancel while it is not", async () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);

    await act(async () => {
      screen.getByRole("button", { name: "Draw" }).click();
    });
    expect(screen.getByRole("button", { name: "Draw" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", false);
  });
});
```

- [ ] **Step 2: Run tests for `apps/studio`**

Run: `pnpm --filter @sketchmind/studio test`
Expected: 12 tests pass.

- [ ] **Step 3: Commit**

Check `.agent/config.yml` for `auto_commit` setting.
If `auto_commit: true`:
```bash
git add apps/studio/tests
git commit -m "test(studio): add App component integration tests with FakeEventSource"
```

---

### Task 4: Workspace Layering and Client Bundle Checks

**Files:**
- Modify: `scripts/check-layering.mjs`
- Modify: `scripts/check-client-bundle.mjs`
- Modify: `package.json`

- [ ] **Step 1: Modify `scripts/check-layering.mjs`**

Add `"@sketchmind/studio"` to the `app` layer members:
```javascript
const LAYERS = [
  { name: "app", members: ["@sketchmind/web", "@sketchmind/studio", "@sketchmind/api"] },
  // ...
];
```

- [ ] **Step 2: Modify `scripts/check-client-bundle.mjs`**

Generalize bundle path scanning to accept directories passed as CLI arguments:
```javascript
const targetDirs = process.argv.slice(2);
const BUNDLES = targetDirs.length > 0 ? targetDirs : ["apps/web/.next/static"];
```
Loop through `BUNDLES` in the scan logic.

- [ ] **Step 3: Update `package.json` `check:bundle` script**

Update `"check:bundle"` script to scan existing client output directories:
`"check:bundle": "node scripts/check-client-bundle.mjs apps/web/.next/static apps/studio/dist"`

- [ ] **Step 4: Verify layering check**

Run: `pnpm check:layering`
Expected: `Layering OK: ... package(s), no upward dependencies, no cycles.`

- [ ] **Step 5: Commit**

Check `.agent/config.yml` for `auto_commit` setting.
If `auto_commit: true`:
```bash
git add scripts/check-layering.mjs scripts/check-client-bundle.mjs package.json
git commit -m "chore(workspace): register @sketchmind/studio in layering and client bundle checks"
```

---

### Task 5: Full Build, Verification and Security Scan

- [ ] **Step 1: Build the entire workspace**

Run: `pnpm build`
Expected: All packages including `apps/studio` build cleanly to `apps/studio/dist`.

- [ ] **Step 2: Run workspace linting**

Run: `pnpm lint`
Expected: Layering check passes and eslint passes with zero errors.

- [ ] **Step 3: Run workspace typechecking**

Run: `pnpm typecheck`
Expected: TypeScript check passes with zero errors.

- [ ] **Step 4: Run workspace tests**

Run: `pnpm test`
Expected: All tests in workspace pass including `apps/studio`.

- [ ] **Step 5: Run client bundle verification**

Run: `pnpm check:bundle`
Expected: `Client bundle clean: ... file(s), no provider credentials or SDKs.`

- [ ] **Step 6: Commit**

Check `.agent/config.yml` for `auto_commit` setting.
If `auto_commit: true`:
```bash
git add .
git commit -m "chore(studio): verify build, tests, and security bundle checks"
```
