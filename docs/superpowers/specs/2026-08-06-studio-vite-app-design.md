# `apps/studio` — Vite + Tailwind web app

**Date:** 2026-08-06
**Status:** approved, pending implementation plan

## Why

`apps/web` is Next.js 15 + React 19. The user does not want Next.js going forward and wants a
Vite + Tailwind CSS implementation instead. This is a feature-for-feature parity rebuild, not a
redesign: same UI, same behavior, same protocol contract with `apps/api`, new build tooling.

`apps/web` stays untouched and keeps running. Deleting it is an explicit follow-up, scoped for
after `apps/studio` reaches parity and is confirmed working — not part of this spec.

## Scope

In scope:
- A new app, `apps/studio` (package `@sketchmind/studio`), built with Vite + React 19 + Tailwind
  CSS, reproducing the current `apps/web` UI and behavior exactly: the prompt bar, the whiteboard
  canvas, the live agent trace panel, and the diagram inspector, driven by the same SSE session
  protocol against `apps/api`.
- Registering the new package in the layering check and (if needed) the client-bundle-leak check.

Out of scope:
- Any visual redesign or new features.
- Deleting or modifying `apps/web`.
- Changing `apps/api` (its CORS default already matches what `apps/studio`'s dev server will use).

## Package layout

```
apps/studio/
  index.html
  vite.config.ts        # react() + tailwindcss() plugins, dev server on :3000
  tsconfig.json          # extends ../../tsconfig.base.json, Bundler resolution, jsx: react-jsx
  package.json
  src/
    main.tsx             # ReactDOM.createRoot bootstrap — replaces layout.tsx + Next's root
    App.tsx              # replaces page.tsx
    index.css            # @import "tailwindcss"; + @theme tokens for the existing palette
    components/
      Whiteboard.tsx
      Inspector.tsx
      TracePanel.tsx
    hooks/
      useSession.ts
  tests/
    App.test.tsx
```

`apps/web` is left exactly as it is.

## Dependencies

Same runtime dependencies as `apps/web`: `@sketchmind/renderer-core`, `@sketchmind/renderer-konva`,
`@sketchmind/session-protocol`, `@sketchmind/shared-types`, `react`, `react-dom`. New build-tool
dependencies: `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`. Test tooling is
unchanged: `vitest`, `jsdom`, `@testing-library/react`, `@vitejs/plugin-react` — `apps/web` already
runs vitest for its tests today, so this tooling is not new to the workspace.

## Behavioral parity — component by component

- **`hooks/useSession.ts`** — direct port of `apps/web/app/useSession.ts`: same reducer over
  `RuntimeEvent`, same `EventSource`/SSE handling, same `decodeServerEvent` validation, same
  start/cancel API calls to `apps/api`. Only change: `process.env["NEXT_PUBLIC_API_URL"]` becomes
  `import.meta.env.VITE_API_URL`, defaulting to `http://localhost:3001` as before.

- **`components/Whiteboard.tsx`** — same Konva bridge: a mount ref, an effect that owns the
  `RendererAdapter`'s lifetime via `createKonvaRenderer`, `renderFrame`/`fitToContent` on frame and
  bounds changes. **Simplification**: Next's `dynamic(() => import("./Whiteboard"), { ssr: false })`
  wrapper in `page.tsx` existed only because Next server-renders by default and importing Konva
  there would drag in `node-canvas`. Vite's dev/build output is a pure client SPA with no server
  render step, so that wrapper — and the loading-placeholder div it required — is dropped.
  `Whiteboard` becomes a plain top-level import in `App.tsx`.

- **`components/Inspector.tsx`**, **`components/TracePanel.tsx`** — logic unchanged. The `"use
  client"` directives at the top of every current component are Next-only and are dropped; they
  have no meaning under Vite.

- **`App.tsx`** — same structure as `page.tsx`: prompt form, status line, three-panel layout
  (whiteboard, trace, inspector), same disabled/busy state logic.

- **`main.tsx`** — replaces `layout.tsx`'s `<html>/<body>` shell and Next's implicit page mount
  with an explicit `ReactDOM.createRoot(...).render(<App />)`. Page `<title>` moves to `index.html`.

## Styling

`globals.css`'s hand-written classes (`.top`, `.panels`, `.side`, `.step`, `.trace`, etc.) are
replaced by Tailwind utility classes written directly in JSX, reproducing the same layout: header
bar with inline form, a two-column grid (canvas + 380px side rail spanning two rows), side panels
capped at `46vh` with scroll, and the same single-column collapse under 1100px width.

The five CSS custom properties currently in `:root` (`--ink`, `--muted`, `--line`, `--surface`,
`--panel`, `--danger`) move into `src/index.css` as Tailwind v4 `@theme` tokens, so the same named
colors are available as utility classes (e.g. `text-ink`, `border-line`, `bg-panel`) instead of
inline `var(...)` references.

## Dev server / API wiring

Vite's dev server is configured for port 3000, matching `apps/api`'s default
`SKETCHMIND_WEB_ORIGIN` (`http://localhost:3000`) — no `apps/api` config changes needed, since only
one of `apps/web` / `apps/studio` runs at a time in normal use. `VITE_API_URL` defaults to
`http://localhost:3001`, same default `apps/web` uses today.

## Testing

Same setup `apps/web` already uses — vitest + jsdom + `@testing-library/react` — this is not new
tooling to the workspace, just a new consumer of it. `tests/App.test.tsx` is a direct port of
`apps/web/tests/page.test.tsx`: the same `FakeEventSource`-driven scenarios (session start, agent
steps arriving live, diagram-ready, stroke counts, completion/failure/cancellation, malformed-event
handling, busy-state button disabling), asserting against `App` instead of `Page`. The
`vi.mock("../app/Whiteboard", …)` stub may or may not be needed under Vite/jsdom — verified
empirically during implementation rather than assumed.

## Workspace wiring

- **`scripts/check-layering.mjs`**: add `@sketchmind/studio` to the `app` layer's `members` array
  alongside `@sketchmind/web`.
- **`pnpm-workspace.yaml`**: no change — `apps/*` glob already covers it.
- **`turbo.json`**: no change — `outputs: ["dist/**", ".next/**"]` already covers Vite's `dist/`
  build output.
- **Root `lint`/`typecheck`**: no change — eslint's `import/resolver` project glob
  (`apps/*/tsconfig.json`) and turbo's package graph pick up any workspace package automatically.
- **`scripts/check-client-bundle.mjs`**: currently hardcodes `apps/web/.next/static` as its scan
  target. This check enforces a hard architectural invariant (no LLM credentials or provider SDKs
  reach the browser bundle), so parity requires it to also cover `apps/studio`. It will be
  generalized to accept a target directory as a CLI argument, and a corresponding root script added
  so both apps' bundles are checked while both exist (e.g. `check:bundle` runs it against
  `apps/web/.next/static` and `apps/studio/dist` in sequence).

## Non-goals / explicit follow-ups

- Deleting `apps/web` — tracked as a future task once `apps/studio` is confirmed at parity.
- Any UI/UX redesign — this spec is a tooling migration only.
