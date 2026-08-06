# @sketchmind/stroke-runtime

Playback: play, pause, seek, replay, undo, redo. Renderer-independent execution state.

The runtime owns no timers. It is a pure function of (strokes, timeMs) driven by
`advance(deltaMs)`, which the caller pumps from `requestAnimationFrame`, a server
tick, or a fixed step in a test — which is what makes playback deterministic and
keeps a `core`-layer package from assuming a browser exists.

`frame()` is the renderer's entry point: strokes already complete, plus the one
in flight with its pen path traversed so far. Editing (`insertStroke`,
`deleteStroke`, `moveStroke`, `replaceStroke`, `reorderStroke`, `appendStrokes`)
rebuilds the timeline and clamps the playhead. `undo()` is a whiteboard eraser —
it removes the last stroke, not the last command — see
`docs/superpowers/plans/2026-08-05-phase-7-stroke-engine.md` D-9.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

This package may depend only on its own layer or below. Direction is enforced
by `scripts/check-layering.mjs`; run `pnpm run check:layering`.
