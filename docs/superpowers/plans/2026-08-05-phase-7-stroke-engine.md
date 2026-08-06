# Phase 7 — Stroke Engine & Human Drawing Simulation

**Branch:** `phase-7`
**Packages:** `stroke-planner`, `stroke-runtime`
**Deliverable:** `LayoutModel` → animated `StrokeAST`, plus playback/editing over it. Deterministic,
renderer-independent, no AI (Volume 06).

Phase 6 ended with a fully placed `LayoutModel` and nothing that knows how to *draw* it. This phase
decides **how a human would draw it** — and is the last phase before pixels exist, so every decision
here has to be defensible without a renderer to check it against.

---

## Design decisions

### D-1. Same contract as every stage before it: a `ValidationResult`, never a throw

`planStrokes`, `optimizeStrokes`, `validateStrokeAST` all return `ValidationResult<StrokeAST>`.
Per AD-2, a layout that can't be drawn is an agent observation, not a pipeline halt — the same
contract `diagram-ast`, `constraint-engine` and `layout-engine` already established.

`stroke-runtime` is the deliberate exception: it is not a pipeline stage, it is a stateful
controller. Its constructor validates once and returns a `ValidationResult`; after that its methods
return plain values, because `pause()` returning a `ValidationResult` would be noise.

### D-2. `planStrokes` takes the AST too, not just the layout

Same shape as Phase 6's D-5, for the same reason. `LayoutModel` carries geometry but not meaning:
it cannot say whether an object is a container or a leaf (needed for "outlines first, details
after"), what its semantic `type` is (needed to pick a stroke shape), or which relationship a
connector realises (needed to pick `arrow` vs `line`). `planStrokes(ast, layout, options?)` takes
both, and cross-checks that they describe the same diagram (`STROKE_UNKNOWN_OBJECT`) before
planning anything.

### D-3. Ordering is semantic, not geometric — five phases, declaration order within each

The obvious reading of "avoid unnatural pen jumps" (Volume 06 §Human Drawing Rules) is a greedy
nearest-neighbour walk over the layout. That reading is wrong, and following it would break the very
example Volume 06 gives: a teacher drawing a pulley system draws the ceiling, then the pulleys, then
the rope, then the load — an order driven by *what depends on what*, not by which shape happens to
be closest to the pen. Nearest-neighbour would also make stroke order a function of geometry, so a
one-pixel layout change could reshuffle the whole drawing — the opposite of "keep stroke order
predictable."

So order is decided semantically, by five phases drawn in sequence:

| phase | contents | rule it implements |
| --- | --- | --- |
| `outline` | depth-0 objects (nothing contains them) | "draw large outlines first" |
| `detail` | depth ≥ 1 objects, shallowest first | "add details afterwards" |
| `connector` | routed connector paths | you cannot draw a rope to a pulley that isn't there |
| `annotation` | annotation labels | commentary follows the thing commented on |
| `label` | object labels | "add labels last" |

Within a phase, order is `zIndex` — which Phase 6 set to the object's index in
`ConstraintGraph.nodes`, itself a parents-before-children DFS over the AST. That is declaration
order, it is stable, and for the movable-pulley fixture it produces exactly Volume 06's stated
sequence.

"Draw connected objects continuously" and "avoid unnatural pen jumps" are then honoured at a scale
where they cost nothing semantic: **within** a stroke, by choosing where the pen enters the path
(D-5), and by keeping every stroke belonging to one object contiguous. Not by reordering objects.

### D-4. Two stroke generators, and a refusal to fake shapes we can't know

Nothing upstream knows an object's *shape*. The AST's `type` is an open string (AD-5 — the agent may
invent one) and Phase 6's D-7 already gave every leaf the same box. Inventing a shape table with
forty entries would be inventing knowledge that belongs in a primitive manifest (`primitive-sdk`,
Phase 12).

So `stroke-planner` ships a generator **registry** — the same extension point shape as Phase 6's
strategy registry, and what Volume 06 §Extensibility means by "stroke generators" — with exactly
two generators registered: `box` (a rectangle traversal) and `disc` (an ellipse traversal inscribed
in the node's bounds). Selection is `options.generatorFor?.(object)` → `GENERATOR_FOR_TYPE[type]` →
`"box"`. `GENERATOR_FOR_TYPE` is a deliberately short table of round things (`pulley`, `wheel`,
`gear`, `circle`, `node`, `ball`, `mass`…); everything else is a box until a manifest says
otherwise. Asking for an unregistered generator returns `STROKE_GENERATOR_NOT_IMPLEMENTED` naming
what *is* registered, rather than silently substituting `box` — a stroke claiming a generator it
didn't use is worse than an error.

### D-5. The planner emits exact points; jitter is the renderer's job

`StrokeStyle.jitter` exists and defaults to `0.15`, and `shared-types/stroke.ts` already states the
rule: replays seed their randomness **from the stroke id**. If the planner baked jitter into
`points`, that seeding would happen once, at plan time, and the same `StrokeAST` replayed on two
machines would still match — but the *AST* would then contain hand-shake noise, and any consumer
that wanted a clean mechanical render (an export to PDF, a pixel-diff test, a vision critique in
Phase 10) could never recover the true geometry. Points stay exact; `style.jitter` travels as
intent.

What the planner *does* do geometrically is pick the pen's entry point: `orientPath` rotates a
closed path to start at the vertex nearest the previous stroke's endpoint, and reverses an open path
if its far end is nearer. Deterministic, and the only cheap thing that genuinely reduces pen travel
without touching order (D-3).

### D-6. Duration is proportional to path length

A rope spanning the diagram should not take the same 400ms as a small circle — that reads as a
slideshow, not as drawing. `durationMs = clamp(length * MS_PER_UNIT, MIN, MAX)`, rounded to an
integer so the timeline stays exactly reproducible in floating point. Text strokes are charged per
character instead of per unit of path, since a label's "path" is a single point.

Sequencing is expressed twice, on purpose: `dependencies` carries the previous stroke's id (the
semantic claim — this stroke cannot start until that one finishes), and the timeline computes
absolute start times from durations (the operational claim). A renderer that wants to stream out of
order reads `dependencies`; a scrubber reads the timeline.

### D-7. The optimizer's contract is object coverage, not stroke count

Volume 06 says the optimizer "must never change semantic meaning." Stroke count is the wrong
invariant to check that with — merging two collinear segments into one is exactly what the optimizer
is *for*. The invariant that actually holds is **object coverage**: the set of `target`s with at
least one stroke, and the set of stroke types drawn per target, are identical before and after.

`optimizeStrokes` asserts that itself, not just in a test: if a pass would change coverage it
returns `STROKE_OPTIMIZER_COVERAGE_CHANGED` with the offending targets, and the caller keeps the
unoptimized plan. Four passes run, each order-preserving: drop degenerate strokes (fewer than two
distinct points, non-text), drop consecutive exact duplicates on the same target, merge consecutive
same-target/same-type/same-style strokes whose endpoints coincide, and collapse collinear interior
points.

### D-8. The runtime owns no timers

"Play, pause mid-sequence, resume, replay are deterministic across runs" is untestable against
`setTimeout`, and a package in the `core` layer has no business assuming `requestAnimationFrame`
exists. So the runtime is a **pure function of (strokes, timeMs)** driven by `advance(deltaMs)`,
which the caller pumps — `requestAnimationFrame` in `renderer-konva` (Phase 8), a fixed step in a
test. `play()`/`pause()`/`resume()` set status and gate whether `advance` moves the clock; they do
not start anything. Seek is just an assignment to `timeMs`, which is why `seek` backwards, `replay`,
and scrubbing are all the same code path.

`frame()` returns what a progressive renderer needs and nothing more: the strokes already complete,
plus the one in progress with its partially-traversed points interpolated along the polyline.

### D-9. Undo is stroke-level, not command-level

Two coherent designs exist: undo reverses the last *edit operation* (an editor), or undo removes the
last *stroke* (a whiteboard). Volume 06 lists Undo/Redo under **Runtime**, next to play and seek,
and the acceptance criterion says "undo removes exactly the last stroke" — so it's the whiteboard.

`undo()` removes the highest-`order` stroke and pushes it on a redo stack; `redo()` puts it back.
The editing operations (`insertStroke`, `deleteStroke`, `moveStroke`, `replaceStroke`,
`reorderStroke` — Volume 06 §Editing) clear the redo stack, as any editor does when you type after
undoing. `moveStroke` translates a stroke's geometry and `reorderStroke` changes its position in the
sequence; Volume 06 lists them separately, so they do different things.

Every mutation rebuilds the timeline and clamps the playhead, so "no side effects" means what it
says: undoing the last stroke leaves every other stroke's id, points, and duration byte-identical.

### D-10. `PlaybackState.status` gains `"cancelled"`

`PlaybackStateSchema` shipped with `idle | playing | paused | completed`, but Volume 06 lists Cancel
as a first-class runtime operation and a cancelled playback is not the same observable state as a
paused or completed one — Phase 9's trace panel has to tell them apart. One enum member added in
`shared-types`, no other model touched.

---

## Acceptance

Verified by `tests/stroke-pipeline.test.ts` (root, driving the real `diagram-ast` →
`constraint-engine` → `layout-engine` → `stroke-planner` → `stroke-runtime` chain on the same
movable-pulley fixture every phase since 5 has used) plus the per-package suites.

- [x] The pulley layout yields the natural order — ceiling → pulleys → rope → load → connectors
      (the force arrows) → labels last.
- [x] Play, pause mid-sequence, resume, and replay are deterministic across runs — asserted by
      driving two independent runtimes through the same tick script and comparing full frame
      transcripts.
- [x] `undo()` removes exactly the last stroke, `redo()` restores it, and every other stroke is
      byte-identical before and after.
- [x] The optimizer never changes which objects exist — asserted by object-coverage diff, with the
      guard living in the optimizer itself (D-7), not only in the test.

---

## Notes for Phase 8

- `frame()` is the renderer's entry point. `completed` is "draw these fully", `inProgress.points` is
  "draw this partial polyline"; a renderer that redraws everything each frame needs nothing else.
- Points are exact (D-5). `renderer-konva` is responsible for applying `style.jitter`, seeded from
  `stroke.id`, or the drawing will look plotted rather than hand-drawn.
- Every stroke type reduces to `points`, so a renderer can ship one polyline path and be correct for
  all twelve; `type` exists so a renderer *may* specialise (a real `arc` command, a text node).
  `text` strokes carry a single point and the `text` field — those genuinely cannot be a polyline.
- Connector strokes are `arrow` only for `pointsTo`, and `line` for everything else. `connectedTo`,
  `attachedTo` and `wraps` are symmetric joins — a rope tied to a load has no arrowhead, and drawing
  one would assert a direction the AST never claimed. The head itself is the renderer's to draw,
  since its size is a visual decision.
- A connector stroke's `target` is the relationship's `from` object, not the relationship — `target`
  is defined as "the Diagram AST object this stroke belongs to", and keeping it an object id is what
  makes the optimizer's coverage invariant (D-7) mean something. The relationship id travels in
  `metadata.relationshipId`. Labels do the same: `target` is the labelled object,
  `metadata.labelId` is the label.
- Phase 6's limitations still stand underneath: straight-only routing, placeholder anchors, uniform
  leaf sizes. A stroke crossing an object it shouldn't is a routing limitation, not a planner bug.
