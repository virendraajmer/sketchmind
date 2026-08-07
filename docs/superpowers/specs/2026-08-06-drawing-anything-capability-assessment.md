# Drawing and Explaining Anything — Capability Assessment

**Date:** 2026-08-06
**Status:** assessment; not a phase. Feeds Phase 11+ scoping.
**Relates to:** AD-5 (freeform composition), AD-7 (promote-on-reuse), AD-3 (vision critique)

## The question

Can the current architecture reach the stated final goal — an agent that draws **and explains**
anything on a whiteboard, stroke by stroke — or does it need a different approach?

## Verdict

Yes. The four-model separation and the "no AI-authored coordinates" rule are what make arbitrary
shapes *safe* rather than what blocks them. The remaining work is vocabulary and narration, both
additive. Two gaps need planning, one of which currently belongs to no phase.

## What exists today

`FreeformShape` (`shared-types/src/freeform.ts`) is the escape hatch AD-5 promised, and it is
sound:

- Eight sub-primitive kinds: `line`, `polyline`, `curve`, `arc`, `circle`, `ellipse`, `rectangle`,
  `polygon`.
- Control points in a **unit 0..1 box**, local to the shape. The model describes proportions within
  a shape it is inventing — nearer to authoring an SVG `viewBox` than to doing layout — and cannot
  position anything on the board.
- Semantic anchors in unit space, so labels and connectors attach meaningfully.
- An `aspectRatio` the layout engine scales but never distorts.

`StrokeType` already enumerates all twelve drawing acts, including `curve`, `arc`, `polygon` and
`freehand`. The vocabulary for "anything" exists in the type system.

**Consumed since 2026-08-07.** `stroke-planner` registers a third generator, `freeform`, which maps
a shape's unit box onto the layout node it was placed in and samples every sub-primitive into a pen
path. `planStrokes` takes the run's shapes via `PlanOptions.freeforms` and selects `freeform` over
the type table whenever an object resolves to one -- by explicit `properties.freeformId`, or by
matching the object's own `type`/`name` against the shape's. `agent-tools-geometry` passes them
through from `ReasoningWorkspace.freeforms`, so a shape `compose_freeform` composed is now the shape
that gets drawn. Before this the box fallback silently discarded it and every unrecognised type came
out as a rectangle.

This makes the proposed test ladder -- lines, rectangles, circles, then complex objects -- an
accurate description of where the code is. The remaining gap is quality of the composed shapes, not
reach.

## Gap 1 — pictorial and structural are a genuine fork

`layout-engine` is a box-model diagram solver: hierarchical, tree, radial, flow, circular, grid,
force-directed. It serves **structural** diagrams (flowcharts, org charts, ER, network) completely.
It does not serve **pictorial** ones (a pulley system, a nephron, a heart), because no box solver
knows what a nephron looks like.

The existing design answers this correctly and should be kept: **layout places an opaque box with
anchors; `FreeformShape` fills that box.** Layout never learns anatomy; the shape never learns
where it sits. Unit-space anchors resolving into `ResolvedAnchor`s is what lets "the rope meets the
pulley groove" cross that boundary — and it is exactly the condition Phase 10's `anchor-miss` check
tests.

The strain point is therefore **quality, not structure**: how well a model describes organic
contours in unit space. That is why Phase 10's tier-2 vision critique is load-bearing for this
goal rather than a nice-to-have — no deterministic geometric check can tell you a shape does not
read as a heart.

## Gap 2 — "explain" is not modelled

This is the gap that belongs to no phase.

`Stroke` carries `target`, `order`, `dependencies` and `timing.pauseAfterMs`. The Stroke AST's own
comment calls stroke ordering *"the difference between a diagram appearing and a diagram being
explained."* But that is pacing, not words. **There is no narration field anywhere in the Stroke
AST, and no runtime event carries explanatory text alongside the drawing.**

The goal is "draw *and explain*". Half of it has no home in the data model.

### Recommendation

Add a narration channel bound to stroke **groups**, not individual strokes — a teacher explains a
part, not a pen movement — surfaced as its own `RuntimeEvent` so the UI captions in step with the
pen.

Land it **before** the shape vocabulary grows. Retrofitting narration across many generators is
substantially worse than designing it into the two that exist now.

## Gap 3 — grow generators, not primitives

Make the freeform path the default route to any new shape, and let AD-7's promote-on-reuse decide
what becomes a registered primitive. Requiring a manifest per shape is precisely what would stall
"draw a nephron" on registration bureaucracy — the failure mode AD-5 was written to prevent.

## Recommended capability ladder

Not a roadmap — a fixture set, each rung a golden-file test:

| Rung | Exercises | Status |
|---|---|---|
| 1. Single line | Stroke planner, runtime, both renderers | Via `freeform`, a `line` part |
| 2. Rectangle | Box generator, layout box model | Exists |
| 3. Circle / ellipse | Disc generator | Exists |
| 4. Connected boxes + labels | Constraint engine, connector routing, label placement | Exists |
| 5. Composite freeform (pulley + rope) | `FreeformShape` end to end, unit-space anchors, `anchor-miss` critique | Generator built; unit-space anchors still unresolved |
| 6. Organic freeform (nephron) | Model spatial ability, tier-2 vision critique | Generator built; quality unmeasured |

The rung at which output stops being convincing identifies the next investment — generators, layout
strategies, or vision critique — measured rather than guessed.

## What this does not change

Phase 10 as specified in `2026-08-06-phase-10-vision-self-correction-design.md` stands unaltered.
Narration, the freeform generator path, and the ladder fixtures are separate work, sequenced after
it.
