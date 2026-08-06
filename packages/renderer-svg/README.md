# @sketchmind/renderer-svg

The SVG rendering backend — the one that proves the SDK is backend-agnostic
rather than Konva with extra steps.

It is a working renderer, not a stub. A second backend that does not run proves
nothing about an abstraction, which is exactly why `llm-provider-anthropic`
exists one layer down. It is under 200 lines only because Phase 8 D-1 left it
nothing to do but emit `<path>` elements — see
`docs/superpowers/plans/2026-08-05-phase-8-renderer.md` D-10.

It needs no canvas, no DOM and no native module, so it renders server-side and
in any test environment, and `toSVG()` returns a text document you can diff. The
viewport travels as a `transform` attribute rather than being baked into the
points, so the paths stay in layout coordinates.

`captureImage` returns `image/svg+xml` bytes rather than rasterising, and
`capabilities.raster` is `false` — a caller that specifically needs pixels asks
the registry for `raster: true` and will not be handed this backend.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

This package may depend only on its own layer or below. Direction is enforced
by `scripts/check-layering.mjs`; run `pnpm run check:layering`.
