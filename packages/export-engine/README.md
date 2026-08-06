# @sketchmind/export-engine

Export to PNG, SVG, JSON, and replay packages (Volume 08 §Export).

Two of these need a surface and go through `RendererAdapter`; the other two are
pure serialisation of the Stroke AST and need no renderer in the process at all,
which is what lets `apps/api` export a diagram nobody is watching.

- `exportPNG(adapter)` — delegates to `captureImage`, so the pixels a user is
  looking at are the pixels they get. Refuses a renderer with no raster output,
  naming it.
- `exportSVG(adapter)` — same, for vector backends.
- `exportJSON(ast)` — the Stroke AST itself; the format Phase 12's checkpoints
  and caches read.
- `exportReplayPackage(ast, { adapter, now })` — a self-contained replay, with
  an optional still. A failed capture is not an export failure: a replay package
  without a thumbnail still replays.

PDF is Phase 12's, and deliberately absent rather than stubbed — it needs a
vector backend that can page, and listing it would put a format in
`RendererCapabilities` that no renderer honours.

This package sits in `core`, one layer above `renderer`, so it depends on
`renderer-core` — the contract — and never on a specific backend. See
`docs/superpowers/plans/2026-08-05-phase-8-renderer.md` D-6.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

This package may depend only on its own layer or below. Direction is enforced
by `scripts/check-layering.mjs`; run `pnpm run check:layering`.
