# Phase 6 — Constraint Engine & Layout Solver

**Branch:** `phase-6`
**Packages:** `constraint-engine`, `layout-engine` (plus one dependency wired between them)
**Deliverable:** `DiagramAST` → `ConstraintGraph` → `LayoutModel`. Deterministic, no AI (Volume 05,
Volume 14 §Constraint Grammar).

Phase 5 ended with a validated `DiagramAST` and nothing downstream of it. This phase is the first
to compute anything — and the first phase where "deterministic" stops being a promise about JSON
shape and starts being a promise about arithmetic.

---

## Design decisions

### D-1. Same contract as every stage before it: a `ValidationResult`, never a throw

`deriveConstraintGraph`, `validateConstraintGraph`, `solveLayout`, `validateLayoutModel` all return
`ValidationResult<T>`. Per AD-2 a malformed hand-composed graph or a category/strategy mismatch is
an agent observation, not a pipeline halt — same reasoning `diagram-ast` already established, applied
twice more.

### D-2. `intersects` is an overlap exemption, not a constraint

Volume 14's fifteen constraint types have no entry for "these two should overlap" — `above`,
`inside`, `wrapAround` all describe a spatial relationship geometry can *satisfy*, and forcing
`intersects` into that vocabulary would mean picking one anyway and getting it wrong (routing a
connector between two circles that are meant to be drawn as a Venn diagram, say). Instead
`constraint-engine` records intersecting pairs under `metadata["overlapPermitted"]`, and
`layout-engine`'s collision pass reads it through `overlapExemptions()` — the one thing that pair is
allowed to do that every other pair in the diagram isn't.

### D-3. Ordering contradictions are containment cycles with different edges

A `required` `above(a,b)` and `above(b,a)` on the same pair contradict each other exactly the way a
containment cycle does — both claim something that can't simultaneously be true. Folding
`above`/`below` into one directed graph (and `leftOf`/`rightOf` into another) turns "is this
contradictory" into "does this have a cycle", so `checkContainmentCycles` and
`checkOrderingContradictions` share one `findCycle` primitive instead of two bespoke contradiction
checks. `preferred` constraints are exempt from both — Volume 14 is explicit that a preferred
constraint yields when it conflicts, so only `required` edges enter the graph being checked.

### D-4. Groups align to the first member, never chain

A group is "objects treated together for layout" (Volume 05); spatially that's alignment.
Members align to the **first** member, not to their neighbour — chaining (`b` aligned to `a`, `c`
aligned to `b`, ...) drifts, because each link is satisfied against an already-moved neighbour and
the last member ends up nowhere near the first. `equalSpacing` is emitted between consecutive pairs
(only once the group has three or more members, since spacing needs at least two gaps to be "equal"
about anything) and both constraints are `preferred` — a presentational grouping must never be the
reason a layout fails.

### D-5. `layout-engine` takes the AST too, not just the graph

The Package Map reads `ConstraintGraph -> LayoutModel`, but `ConstraintGraph.nodes` is an array of
bare id strings — no type, no anchors, no labels. Everything the solver needs to *size* an object,
*label* it, or *resolve its anchors* only exists on the `DiagramObject`. `solveLayout(ast, graph,
options?)` takes both; the graph supplies relationships, the AST supplies everything a node-id
string can't. A light cross-check (`LAYOUT_UNKNOWN_OBJECT`) enforces the two actually describe the
same diagram before anything is solved.

### D-6. Bottom-up sizing, top-down placement — and why collision resolution needs no ancestor exemption

Two tree passes, the standard box-model shape:

- `computeSize` walks the containment forest (built from the graph's required `inside` edges)
  post-order. A leaf gets a fixed default box; a container arranges its own children first — which
  needs their sizes, hence post-order — then wraps them in a bounding box plus padding. A container's
  size is therefore always exactly "big enough for what's inside it."
- `place` walks the same forest pre-order, turning each container's locally-arranged children into
  absolute positions by adding the container's own absolute origin.

Because a subtree only ever moves as a whole (its container's wrapped size already encloses
everything inside it), collision resolution never needs to know about ancestry: two *sibling* boxes
not overlapping is sufficient to guarantee nothing nested inside either of them overlaps the other
subtree. `resolveOverlaps` (a fixed number of passes over a fixed pair order — Volume 05 asks for
"automatically resolve conflicts," not a proof of global optimality) runs once per sibling scope —
once for each container's children, once for the roots — instead of once globally with an
ancestor/descendant exemption bolted on.

### D-7. Leaf sizing is a fixed constant, on purpose

Nothing upstream of `layout-engine` is allowed to emit a number (Global Constraints), so a leaf
object's box can't come from anywhere but a default. Teaching the solver "a pulley is bigger than a
gear" is a primitive manifest's job — `primitive-sdk`, Phase 12 — not this one's. Recorded here so
it isn't mistaken for an oversight later.

### D-8. Declared anchors resolve to perimeter points, not semantic ones

The AST only carries an anchor's name and description (`{ name: "rim", description: "..." }`) —
nothing says where "rim" sits on a pulley. Absent that, `resolveAnchorPoint` distributes an object's
declared anchors evenly around its box perimeter in declaration order: deterministic, distinct per
anchor, and honest about not knowing more. A primitive manifest supplying real per-anchor offsets
(Phase 12) replaces this without changing the interface anchors are consumed through.

### D-9. The strategy registry ships two strategies and refuses to fake the other six

`LayoutStrategySchema` has eight members; Phase 6's acceptance asks for two (`hierarchical`,
`grid`) "behind a strategy interface" — worded that way because the interface is what makes a third
one (`plugin-sdk`, Phase 12) an addition, not a rewrite. Selection reads `ast.category` (diagram
metadata the AST already carries) through one lookup table, `DEFAULT_STRATEGY_FOR_CATEGORY`; an
explicit `options.strategy` always wins, which is how a caller reaches a plugin-registered strategy
the table doesn't know about. Asking for a schema-valid but unregistered strategy (`"radial"`, say)
returns `LAYOUT_STRATEGY_NOT_IMPLEMENTED` naming what *is* registered — silently substituting
`hierarchical` would be a diagram claiming a strategy it didn't actually use.

Within `hierarchical`, `above`/`below` produce a vertical rank by longest-path over a DAG (cyclic
edges — always `preferred` ones, since `required` same-axis contradictions are already rejected by
D-3 — are dropped greedily, same primitive as D-3's cycle check); `leftOf`/`rightOf` order each rank
by topological sort; `centeredOn`, `alignedWith`, and `equalSpacing` are post-passes over that
placement. `grid` ignores directional constraints entirely — a comparison or map diagram rarely
states "above" with real spatial intent, and a grid that tried to honour it would just be a worse
hierarchical strategy.

### D-10. `validateLayoutModel` does not re-check overlap

Volume 05 lists "no overlaps" under Validation, but `solveLayout`'s own collision pass is
best-effort by design (D-6), and an `intersects` relationship produces a model with a real, *intended*
overlap. A strict overlap re-check here would fail output this package itself just produced
correctly. What it checks instead is unambiguous regardless of intent: no two nodes claiming the
same id, no label or connector pointing at something that doesn't exist, and every node's bounds
inside the canvas the model itself declares (`LAYOUT_OUT_OF_BOUNDS`) — a claim only the model can
contradict on its own, unlike overlap, which needs outside context to judge.

---

## A small architecture note

`layout-engine` depends on `constraint-engine` (both `core` layer, so this is a sideways dependency,
not upward) purely to reuse `overlapExemptions()` — keeping the `overlapPermitted` metadata contract
in one place rather than duplicating the key name and shape in two packages that would drift the
first time either changed.

---

## Acceptance

All verified by `tests/layout-pipeline.test.ts` (root, the same movable-pulley `DiagramAST` fixture
`tests/reasoning-pipeline.test.ts` uses) plus the per-package suites (25 tests in
`constraint-engine`, 19 in `layout-engine`).

- [x] The movable-pulley AST yields non-overlapping bounding boxes with every referenced object
      positioned.
- [x] Identical input always yields identical output — asserted with `JSON.stringify` equality on
      the full `LayoutModel`, run twice, once on a `structuredClone`d AST (AD-6).
- [x] Strategy selection is driven by `ast.category`, not hardcoded at a call site (`schematic` →
      `hierarchical`, `comparison` → `grid`, proven by switching only the category field).
- [x] `LayoutModel` remains the only model with coordinates — the Constraint Graph produced along
      the way is asserted to contain no `x`/`y`/`width`/`height` keys anywhere in its serialized form.

---

## Notes for Phase 7

- Draw order: `LayoutNode.zIndex` is the node's index in `ConstraintGraph.nodes`, which is itself a
  parents-before-children DFS over the AST. `stroke-planner` gets a free head start on "outlines
  before detail, connected objects continuous" from this ordering, though it will need its own pass
  for "labels last" since labels aren't nodes.
- Connector routing is `"straight"` only (D-9's sibling: Volume 05's other three routing styles —
  orthogonal, curved, smart avoidance — are schema members this phase doesn't produce). If a stroke
  looks like it's crossing an object it shouldn't, that's this phase's known limitation, not a stroke-
  planner bug.
- Anchor points are perimeter placeholders (D-8). If stroke ordering or connector endpoints ever need
  a *specific* named anchor (a pulley's rope meeting its rim, not just "some point on the box"), that
  precision has to come from a primitive manifest — there's nothing left to derive it from here.
- Leaf sizing is a fixed constant (D-7). Every object is the same size until `primitive-sdk` exists;
  Phase 7/8 should not read anything semantic into current box proportions.
