# Phase 8 — Renderer SDK & Multi-Backend Rendering

**Branch:** `phase-8`
**Packages:** `renderer-core`, `renderer-konva`, `renderer-svg` (skeleton), `export-engine` (PNG)
**Deliverable:** the first real pixels — a `StrokeAST` drawn to a canvas, driven purely by frames a
`stroke-runtime` produces, with nothing about AI, layout or constraints reachable from the renderer
(Volume 08).

Phase 7 ended with a drawing sequence and a timer-free runtime that can say, for any millisecond,
"these strokes are done, this one is `n%` through". This phase is the other half of that sentence:
turning it into something you can look at.

---

## Design decisions

### D-1. `renderer-core` owns everything that is not backend-specific

The tempting split is "core defines interfaces, backends do the work". That produces two backends
that disagree — Konva rounding a corner one way, SVG another — and a pixel-diff test that can only
ever cover one of them.

So the split is the opposite one: `renderer-core` owns the layer model, the viewport transform,
jitter synthesis (D-3), tone→colour resolution, hit-testing (D-4), and stroke→display-geometry
conversion. A backend contributes exactly one thing: *how do I put this already-computed polyline on
my surface*. `renderer-konva` is ~300 lines because everything upstream of `Konva.Line` already
happened in core.

The practical payoff is testability: the majority of renderer behaviour is asserted in plain Node
with no canvas at all, and the two backends are provably drawing the same geometry
(`tests/renderer-backends.test.ts` compares their resolved display strokes point for point).

### D-2. The renderer never imports `stroke-runtime` — the frame is a structural contract

`renderer` sits *below* `core` in the layering (`scripts/check-layering.mjs`), so
`renderer-konva` importing `stroke-runtime` is an upward dependency and a CI failure. It is also the
acceptance criterion: "imports nothing from AI, agent, constraint, or layout packages."

But progressive drawing is *defined* by `DrawingFrame`. The resolution is that `renderer-core`
declares its own `RenderFrame` — the same shape, arrived at independently — and the coupling is
policed by a root-level contract test that assigns a real `DrawingFrame` from a real runtime to a
`RenderFrame` and lets the compiler check it. If Phase 9 changes one, the test stops compiling.

This is deliberate duplication of a *type*, not of a model: `Stroke` itself still comes from
`shared-types`, so no geometry is redefined.

### D-3. Jitter is synthesised in `renderer-core`, seeded from the stroke id

Phase 7 D-5 pushed this here explicitly: the planner emits exact points so exports and vision
critique can recover true geometry, and "the renderer is responsible for applying `style.jitter`,
seeded from `stroke.id`, or the drawing will look plotted rather than hand-drawn."

It lives in core rather than in each backend for the reason in D-1 — a pixel-diff reference is
worthless if SVG and Konva shake differently. `hashStrokeId` is FNV-1a over the id, feeding a
mulberry32 PRNG; displacement is perpendicular to the local path direction, amplitude
`jitter * width`, and interior points are displaced while endpoints are pinned so joins stay closed.
A closed path's first and last point are the same vertex and receive the same displacement, so
rectangles stay rectangles.

Determinism is a property of the id, not of call order: rendering stroke 40 first produces exactly
the points it would have had rendered last. That is what makes replay, seek-backwards and undo/redo
visually stable, and it is asserted rather than assumed.

### D-4. Hit-testing is geometric in `renderer-core`, not delegated to the backend

Volume 08 says "implementation is renderer specific", and for a *canvas* hit graph that is true.
It is the wrong call here for three reasons. Phase 11 needs the **object id** — a Diagram AST fact
that no canvas knows; a backend hit graph only sees nodes we happened to register, so a stroke that
is mid-flight or on a hidden layer answers wrongly; and `renderer-svg` has no hit graph at all,
which would leave the criterion untestable on the one backend that runs anywhere.

So `hitTest(strokes, point, options)` in core does point→polyline distance in world space and
returns `{ objectId, strokeId, layer, distance, kind }`, nearest first, topmost layer winning ties.
Backends may override; Konva does not. Konva's own `getIntersection` is used in the test suite as an
independent cross-check that core's answer matches what the pixels actually show — which is a
stronger assertion than either alone.

### D-5. Layer assignment is a pure function of the stroke

Volume 08's eight logical layers (`background`, `grid`, `shapes`, `connectors`, `labels`,
`highlights`, `animations`, `debug`) are a rendering concern, but *which* layer a stroke belongs on
is decided by what the stroke is, and Phase 7 already stamped that in `metadata.phase`:
`connector` → `connectors`, `label`/`annotation` → `labels`, everything else → `shapes`.
`highlights`, `animations` and `debug` exist and stay empty until Phase 11's canvas tools own them —
declared now because adding a layer later reshuffles z-order for every diagram already rendered.

Layers are independently refreshable (Volume 08 §Layer Model) and independently visible, which is
what lets the pixel-diff baseline exclude text (D-8) without a second rendering path.

### D-6. `captureImage` returns bytes; `export-engine` decides formats

The adapter contract gets `captureImage()` (AD-3, needed by Phase 10's vision critique) returning
`{ mimeType, width, height, data: Uint8Array }` — raw bytes, not a data URL, because a base64 string
is 33% larger and Phase 10 is going to put this in a request body.

`export-engine` sits in `core`, one layer above `renderer`, so it may depend on `renderer-core` and
does: `exportPNG` delegates to `captureImage`, `exportSVG` to `adapter.export("svg")`, while
`exportJSON` and `exportReplayPackage` need no adapter at all because they serialise the Stroke AST.
That division is the whole reason `export-engine` is a separate package from the renderers — format
policy is not backend policy.

### D-7. Progressive drawing is an idempotent diff, not a rebuild

`renderFrame(frame)` reconciles against the previous frame: strokes newly in `completed` are
materialised once, the in-progress stroke's node has its points updated in place, and a stroke that
disappears (undo, seek backwards) is destroyed. Nothing is rebuilt that did not change, which is
what makes 60fps playback plausible, and calling `renderFrame` twice with the same frame leaves an
identical scene — the property that makes the renderer safe to drive from React in Phase 9.

Seeking backwards is the interesting case and it falls out for free: the frame is a pure function of
time, so a smaller `completed` set simply means nodes get destroyed.

### D-8. The pixel-diff baseline excludes text

"Matching a reference PNG within pixel-diff tolerance" is the right criterion and font rasterisation
is the thing that makes it flaky — the same `Konva.Text` renders differently across OS font stacks,
and a committed baseline that fails on someone else's machine gets deleted within a week.

So the baseline renders with the `labels` layer hidden, and label rendering is asserted structurally
instead (every label stroke produces a text node at the right point with the right string). The diff
itself is per-channel with a tolerance and a max-differing-pixel ratio, so anti-aliasing differences
do not fail the build while a stroke drawn in the wrong place does.

The baseline lives at `tests/fixtures/pulley-baseline.png` and is regenerated by deleting it and
re-running `pnpm --filter @sketchmind/tests test` — the test writes a fresh one and warns on stderr
that it did. The regeneration path is the *same code path* as the assertion, deliberately, because
a baseline produced by a separate script is a baseline nobody can reproduce.

### D-9. Konva runs headless in tests via a backend shim, and `canvas` is a devDependency only

Konva 10 splits its rendering backend out (`konva/canvas-backend`), so importing that module for its
side effects before `konva` makes the whole library work under Node against `node-canvas` —
verified: real PNG bytes, working `getIntersection`. That is what turns every Phase 8 criterion into
an automated test instead of a screenshot someone eyeballs.

`canvas` is a **devDependency** of `renderer-konva` and is never imported by `src/`. In the browser
Konva uses the DOM canvas and `canvas` is not in the bundle. The shim lives in
`tests/support/headless.ts`, so the production entry point has no idea Node exists.

### D-10. `renderer-svg` is a real adapter, not a stub

The plan calls it a skeleton, and the temptation is a file that throws `NOT_IMPLEMENTED`. A second
backend that does not run proves nothing about the abstraction — the same failure mode
`llm-provider-anthropic` exists to prevent on the provider side. It is ~150 lines because D-1 left
it nothing to do but emit `<path>` elements, and it is the backend that lets the layering, viewport
and hit-testing criteria be asserted in environments with no canvas at all.

It implements `captureImage` by returning `image/svg+xml` bytes rather than rasterising: honest
about what it can do, and `RendererCapabilities.raster: false` says so to any caller that cares.

### D-11. Volume 08's eight layers are Konva *groups*, and painting is `draw`, not `batchDraw`

Two Konva-specific calls that look like implementation detail and are not.

Eight `Konva.Layer`s would be eight `<canvas>` elements, against Konva's own guidance of three to
five. A `Konva.Group` gives independent visibility, z-order and caching — everything Volume 08
§Layer Model actually asks for — so the eight logical layers are groups inside one Konva layer.

`batchDraw` defers the actual paint to `requestAnimationFrame`, which leaves both the hit graph and
`toDataURL` describing a frame that has not happened yet: `getIntersection` returns nothing and an
export comes back blank. There is also nothing to batch, because Phase 7 D-8 put the clock in the
caller, so `paint` already runs once per frame. `draw` it is.

---

## Acceptance

Verified by `tests/render-pipeline.test.ts` (root, driving the real `diagram-ast` →
`constraint-engine` → `layout-engine` → `stroke-planner` → `stroke-runtime` → `renderer-konva` →
`export-engine` chain on the movable-pulley fixture) plus the per-package suites.

- [x] Konva draws the pulley `StrokeAST` in order, matching a committed reference PNG within
      pixel-diff tolerance (text excluded per D-8).
- [x] Play/pause/resume visibly controls progressive drawing — asserted as ink coverage growing
      while playing, frozen while paused, resuming from the same node set.
- [x] `renderer-konva` imports nothing from AI, agent, constraint or layout packages — enforced by
      `check-layering.mjs` (renderer is below core) and asserted directly against its manifest.
- [x] PNG export contains all drawn objects — verified per object by decoding the PNG and finding
      ink inside each object's layout bounds, not by a whole-image hash.
- [x] Hit-testing returns the correct object id on click, cross-checked against Konva's own
      `getIntersection` (D-4).
- [x] `captureImage` returns a usable image buffer — decoded, dimensions checked, non-blank.

---

## Notes for Phase 9

- Mount with `createKonvaRenderer({ container })` in a `useEffect`, pump `advance(delta)` from
  `requestAnimationFrame`, and call `renderFrame(runtime.frame())`. The renderer holds no timer of
  its own (Phase 7 D-8 all the way through), so React's lifecycle stays in charge.
- `renderFrame` is idempotent (D-7); a double-render from StrictMode is harmless.
- `fitToContent(ast.bounds)` before the first frame, or the diagram is drawn in layout coordinates
  and mostly off-screen.
- The viewport transform is the only place pixels enter the system. Everything upstream — including
  hit-test input — is layout space, so a click must go through `toWorld(screenPoint)` first.
- `RendererRegistry` is how Phase 12's plugin backends arrive; `apps/web` should resolve its adapter
  through `rendererRegistry.select(capabilities)` rather than importing `renderer-konva` directly,
  or the plugin seam is decorative.

**What the baseline image actually shows, and why that is not a Phase 8 bug.** The rendered pulley
is a horizontal row: box, ellipse, ellipse, box, box, joined by straight lines. That is Phase 6's
layout faithfully drawn — its stated limitations are still in force (uniform leaf sizes, placeholder
anchors on box perimeters, straight-only connector routing), and D-4's own note in Phase 7 said a
stroke crossing something it shouldn't is a routing limitation rather than a planner bug. The
renderer's job is to draw the Layout Model, not to improve it, and a renderer that "fixed" this
would be computing layout — which Volume 08 forbids in as many words. Making the diagram
*recognisable* is Phase 10's geometric critique (10a) and the primitive manifests of Phase 12,
which is where the missing knowledge — a pulley is round and has a rim the rope wraps — belongs.
