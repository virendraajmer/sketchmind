# @sketchmind/renderer-konva

The Konva rendering backend — the first real pixels in the system.

```ts
const adapter = createKonvaRenderer({ size, container }); // in a useEffect
adapter.fitToContent(ast.bounds);
// per animation frame:
runtime.advance(delta);
adapter.renderFrame(runtime.frame());
```

`renderFrame` is an idempotent diff, not a rebuild: strokes newly complete are
materialised once, the in-flight stroke's node is repointed in place, and a
stroke that disappears (undo, seek backwards) is destroyed. Rendering the same
frame twice leaves an identical scene, which is what makes it safe to drive from
React. See `docs/superpowers/plans/2026-08-05-phase-8-renderer.md` D-7.

It is small because Phase 8 D-1 put the layer model, viewport, jitter, tone
resolution and hit-testing in `renderer-core`; this package only knows Konva's
API. Volume 08's eight logical layers are `Konva.Group`s inside one
`Konva.Layer`, not eight canvases — groups give the independent visibility and
z-order the layer model asks for without exceeding Konva's own guidance on
layer count.

`paint` calls `draw`, not `batchDraw`: batching defers to
`requestAnimationFrame`, which would leave the hit graph and the exported bitmap
describing a frame that has not happened yet. There is nothing to batch anyway —
the caller owns the frame loop.

## Testing

Konva runs headless under Node against `node-canvas`, so the suite asserts real
PNG bytes and real `getIntersection` rather than a screenshot someone eyeballs
(D-9). The backend shim lives in `tests/support/headless.ts` and is wired
through `setupFiles`; `src/` has no idea Node exists, and `canvas` is a
devDependency that never reaches a bundle.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

This package may depend only on its own layer or below — `renderer-core`,
`shared-types`, and Konva itself. Nothing from AI, agent, constraint, layout or
stroke packages is reachable, which is a CI-checked fact rather than a habit.
Direction is enforced by `scripts/check-layering.mjs`; run
`pnpm run check:layering`.
