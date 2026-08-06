# @sketchmind/agent-vision

Self-correction: the agent inspects its own drawing and fixes what's wrong (AD-3).

## Two critique tiers

**Tier 1: Geometric critique.** Deterministic inspection of the `LayoutModel` and `StrokeAST` for object/label overlap, out-of-bounds elements, connector crossings, endpoints that don't meet their anchors, degenerate sizes, and whitespace imbalance. Zero token cost, instant, and catches most real errors.

**Tier 2: Visual critique.** Multimodal model evaluation of the rendered diagram against the original request — catches issues only visible in the final image ("this doesn't read as a pulley system"). Gated on `SKETCHMIND_VISION_MODE` and a vision-capable provider. Off by default.

Both emit the same structured `CritiqueFinding[]`, so the agent's repair loop is identical regardless of which tier(s) ran.

## Public API

See `src/index.ts` for complete exports. The four entry points:

- **`critiqueGeometry(input)`** — Run geometric checks on a diagram. Input: `{ ast, layout, strokes?, options? }`. Returns `CritiqueFinding[]`. Called by the repair loop and available as an agent tool.

- **`critiqueImage(input)`** — Multimodal critique of a rendered diagram. Input: `{ provider, image, request, layoutSummary, signal? }`. Server-side only. Returns `ValidationResult<CritiqueFinding[]>`.

- **`createVisionTools(options)`** — Expose critique to the server agent. Returns `ToolDefinition[]` for `critique_diagram`. Options include accessors for current AST/layout/strokes and geometric check configuration.

- **`runVisionAgent(options)`** — Client-side vision agent. Input: `{ sessionId, request, provider, capture, critique, report, visionEnabled, signal, maxSteps?, maxTokens?, timeoutMs?, onStep? }`. When `visionEnabled` is false, returns immediately without building a tool registry or capturing anything. Otherwise runs a bounded `agent-core` loop (`capture_canvas` → `critique_canvas` → `report_findings`) and returns `{ reported, rounds, stopReason }`.

## Dependency rules

This package does not import `layout-engine`, `constraint-engine`, `stroke-planner`, or any other `core`-layer package. Critique must form its own independent opinion from the solver's output; sharing solver internals would make the two agree by construction, which defeats the purpose of a check.

This package may depend only on its own layer (`agent`) or below (`core`, `renderer`, `provider`, `foundation`).
