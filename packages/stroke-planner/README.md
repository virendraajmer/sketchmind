# @sketchmind/stroke-planner

LayoutModel to StrokeAST plus optimizer. Applies human drawing rules.

`planStrokes(ast, layout, options?)` orders the drawing in five phases — outline,
detail, connector, annotation, label — and within each by the layout's own
`zIndex`. Order is decided semantically, never by nearest-neighbour over
coordinates, so a layout nudge cannot reshuffle the sequence. Points are exact:
`style.jitter` travels as intent for the renderer to seed from `stroke.id`.

Shapes come from a generator registry (`box`, `disc`, `freeform`, plus whatever
`registerStrokeGenerator` adds) rather than a built-in shape table — see
`docs/superpowers/plans/2026-08-05-phase-7-stroke-engine.md` D-4.

`freeform` is how anything outside that table gets drawn (AD-5). Pass the run's
shapes as `options.freeforms` and an object that resolves to one — by
`properties.freeformId`, or by its own `type`/`name` matching the shape's — is
drawn with it instead of falling back to a box. The shape's unit box is fitted
into the layout node without distorting its `aspectRatio`, and every
sub-primitive is sampled into an explicit pen path, because a renderer backend
strokes a polyline and would otherwise draw a curve as straight segments.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

This package may depend only on its own layer or below. Direction is enforced
by `scripts/check-layering.mjs`; run `pnpm run check:layering`.
