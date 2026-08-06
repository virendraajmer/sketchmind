# @sketchmind/renderer-core

The renderer SDK (Volume 08): adapter contract, layer model, viewport,
hit-testing, registry — plus everything about rendering that is not
backend-specific.

The split against the backends is the load-bearing decision. "Core defines
interfaces, backends do the work" produces two backends that quietly disagree
about geometry and a pixel-diff test that can only cover one of them. So core
owns the layer model, the viewport transform, jitter synthesis, tone resolution,
hit-testing, and stroke→geometry conversion; a backend contributes only how to
put an already-computed polyline on its surface. See
`docs/superpowers/plans/2026-08-05-phase-8-renderer.md` D-1.

Consequences worth knowing:

- **Jitter lives here**, seeded from the stroke id (D-3). Phase 7 emits exact
  points so exports and vision critique can recover true geometry; the shake is
  synthesised at render time and is identical on every backend.
- **`RenderFrame` is declared here, not imported from `stroke-runtime`** (D-2).
  `renderer` sits below `core`, so importing it would be an upward dependency.
  The two shapes are kept in step by `tests/render-pipeline.test.ts`.
- **Hit-testing is geometric, not delegated** (D-4). Phase 11 needs the Diagram
  AST object id, which no canvas hit graph knows.
- **The viewport is the only place pixels enter the system.** A pointer event
  must go through `viewport().toWorld()` before anything semantic reads it.

`BaseRendererAdapter` implements the whole contract except mount, unmount,
paint, and capture — which is why `renderer-konva` is small and `renderer-svg`
is smaller.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

This package may depend only on its own layer or below — in practice only
`shared-types`, which is what structurally prevents a renderer from calling an
LLM or computing a layout. Direction is enforced by `scripts/check-layering.mjs`;
run `pnpm run check:layering`.
