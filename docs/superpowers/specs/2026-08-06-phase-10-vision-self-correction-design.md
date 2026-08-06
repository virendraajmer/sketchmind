# Phase 10 — Vision Self-Correction (AD-3)

**Date:** 2026-08-06
**Status:** approved, pending implementation plan
**Packages:** `agent-vision`, `shared-types`, `llm-provider`, `apps/api`, `apps/studio`

## Why

The agent can draw anything and cannot tell whether it worked. AD-3 closes that: the agent
inspects its own output and repairs it. Two critique tiers feed one repair path — a deterministic
geometric tier that is free and always on, and a visual tier that costs tokens and stays off until
a deployment and a model support it.

Both tiers emit the same structured findings, so the repair path does not know or care which one
produced them.

## Deviations from the original Phase 10 plan

The implementation plan (`2026-08-05-sketchmind-implementation-plan.md` §Phase 10) describes the
visual tier as a server-side pre-playback check. This spec changes that in two ways, at the user's
direction:

1. **The visual tier is driven by a client-side agent locus**, not a server stage. The browser
   captures the rendered canvas, sends it to the server for analysis, and reports findings back.
   This pulls the client `agent-core` locus (Phase 11) forward into Phase 10.
2. **Critique happens after playback**, on the pixels the user actually saw, rather than on a
   server-rendered image of a stroke plan.

The geometric tier is unchanged from the plan, and additionally runs as a server-side pre-playback
pass so that a diagram is checked even when vision is off.

Phase 11's canvas *mutation* tools (`highlight_object`, `zoom_to`, `erase_object`, …) remain out of
scope. The only client tools this phase introduces are the three vision tools below.

## Constraints that shaped the design

- `LLMProvider.completeWithImages()` returns a plain `CompletionResponse` — **no tool calls**.
  `completeWithTools()` accepts text messages only, and `/api/agent/llm` validates exactly that
  shape. A browser `agent-core` loop therefore cannot put an image into its own reasoning turn
  without changing `agent-core`, `LLMProvider`, both provider adapters and the proxy schema.
  **Resolution:** the multimodal call happens server-side behind a tool; the client agent reads its
  result as JSON text. `agent-core`, `LLMProvider` and `/api/agent/llm` are untouched.
- Layering: `agent-vision` sits in the `agent` layer, so it may depend on `agent-core` (same layer,
  precedent: `agent-memory` exports `createMemoryTools`), and on `llm-provider` and `renderer-core`
  (both below). It must not become a second geometry authority, so it does **not** depend on
  `layout-engine`.
- `renderer-konva` is the only raster backend; `renderer-svg` reports `captureImage: true` but
  returns SVG bytes. The visual tier requires `raster: true` as well as `captureImage: true`.

## Architecture

```
apps/studio (browser)
  runVisionAgent  ── agent-core loop, locus "client", proxy provider
    ├ capture_canvas   → RendererAdapter.captureImage()          [local]
    ├ critique_canvas  → POST /api/agent/vision-critique         [server analyses]
    └ report_findings  → POST /api/sessions/:id/findings         [server repairs]
                              │
apps/api                      ▼
  routes/vision.ts   → agent-vision.critiqueImage(provider, …)   [tier 2]
  session/run.ts     → agent-vision.critiqueGeometry(…)          [tier 1, pre-playback]
  session/repair.ts  → runAgent over the live session registry
```

### `agent-vision` public API

```ts
// Deterministic, synchronous, no I/O.
export function critiqueGeometry(input: {
  ast: DiagramAST;
  layout: LayoutModel;
  strokes?: StrokeAST;
  options?: GeometricCritiqueOptions;
}): CritiqueFinding[];

// One multimodal call. Server-side only. Returns ValidationResult, never throws
// for model-shaped failures (AD-2).
export function critiqueImage(input: {
  provider: LLMProvider;
  image: CapturedImage;
  request: string;             // the user's original words
  layoutSummary: string;       // ids and counts, never coordinates
}): Promise<ValidationResult<CritiqueFinding[]>>;

// Server tool surface: `critique_diagram`.
export function createVisionTools(options: {
  workspace: GeometryWorkspace;
  getAst: () => DiagramAST | undefined;
  options?: GeometricCritiqueOptions;
}): ToolDefinition[];

// Client tool surface: capture_canvas, critique_canvas, report_findings.
export function createClientVisionTools(options: {
  capture: () => ValidationResult<CapturedImage>;
  critique: (image: CapturedImage) => Promise<CritiqueFinding[]>;
  report: (findings: CritiqueFinding[]) => Promise<void>;
  workspace: VisionWorkspace;
}): ToolDefinition[];

export function runVisionAgent(options: RunVisionAgentOptions): Promise<VisionAgentResult>;
```

`apps/studio` supplies a capture closure and two `fetch` calls. It contains no critique logic.

`VisionWorkspace` is the client-side equivalent of `GeometryWorkspace`: a per-run holder for the
most recent `CapturedImage` and the previous round's findings, so image bytes are referenced by the
tools rather than carried through the agent's message history.

### Shared types

New `packages/shared-types/src/critique.ts`:

```ts
CritiqueTier   = "geometric" | "visual"
CritiqueSeverity = "info" | "warning" | "error"

FixProposal =
  | { kind: "move_object";          objectId: string; hint: string }
  | { kind: "resize_object";        objectId: string; hint: string }
  | { kind: "reposition_label";     labelId: string;  hint: string }
  | { kind: "add_missing_component"; description: string }
  | { kind: "redraw_object";        objectId: string; hint: string }

CritiqueFinding = {
  id: string;
  tier: CritiqueTier;
  check: string;              // e.g. "anchor-miss"
  severity: CritiqueSeverity;
  message: string;            // plain language, addressed to the agent
  objectIds: string[];
  proposal?: FixProposal;
}
```

`hint` is prose, never a coordinate: proposals describe intent, and the solver remains the only
thing that produces numbers.

The existing `VisionCritique` runtime event (`findings: string[]`, `accepted: boolean`, currently
unused) is replaced by:

```ts
{ type: "VisionCritique", tier: CritiqueTier, findings: CritiqueFinding[], accepted: boolean }
```

This satisfies "critique findings appear in the trace panel, tagged with which tier produced them."

## Tier 1 — geometric critique (default on, zero tokens)

Seven checks over `(ast, layout, strokes)`:

| Check | Signal | Default proposal |
|---|---|---|
| `overlap` | Pairwise `bounds` intersection between nodes, and between labels and nodes, honouring the `intersects` exemptions Phase 6 defines | `move_object` |
| `out-of-bounds` | Node bounds, label bounds or connector point outside `layout.canvas` | `move_object` |
| `anchor-miss` | Connector endpoint further than tolerance from its declared `ResolvedAnchor.point` — the "rope not meeting the pulley" case | `move_object` |
| `connector-crossing` | Segment intersection between paths of distinct connectors | `redraw_object` |
| `degenerate-size` | `width` or `height` at or below a floor | `resize_object` |
| `whitespace-imbalance` | Content centroid offset from canvas centre beyond a ratio | none (advisory) |
| `stroke-coverage` | A layout node with no stroke whose `target` names it | `redraw_object` |

`stroke-coverage` is the only check needing the Stroke AST; when `strokes` is absent it is skipped.

Every threshold is a field on `GeometricCritiqueOptions` with a documented default — tuning is
configuration, not a code edit:

```ts
interface GeometricCritiqueOptions {
  overlapToleranceUnits: number;      // default 0.5
  anchorToleranceUnits: number;       // default 2
  minDimensionUnits: number;          // default 1
  whitespaceImbalanceRatio: number;   // default 0.25
  checks: Partial<Record<CheckName, boolean>>;  // all true by default
}
```

Determinism: findings are sorted by `(check, objectIds)` so the same input always yields a
byte-identical array — required for the "findings repeat the previous round" comparison.

### Where it runs

1. **Automatically**, in `runSession` after `plan_strokes` succeeds and before playback begins. If
   findings are non-empty and repair budget remains, a repair turn runs before the first stroke is
   drawn.
2. **On demand**, as the server tool `critique_diagram`, which the agent may call at any point once
   a layout exists. Same function, same findings.

Both paths converge on the same repair machinery. There is one critique implementation and one
repair implementation; only the entry points differ.

## Tier 2 — the client vision agent (default off)

A real `agent-core` loop in the browser, `locus: "client"`, with its own budget (defaults: 6 steps,
20 000 tokens, 60 s wall clock) and its own `AbortController` chained to the session's.

Its model turns go to `/api/agent/llm` via a new `createProxyProvider({ endpoint, capabilities })`
— an `LLMProvider` implementation that is pure `fetch`, living beside `fake.ts` in `llm-provider`
and importing no SDK. Its declared capabilities mirror what the proxy actually supports:
`toolCalling: true`, `vision: false`, `streaming: false`, `structuredOutput: false`. The client
agent never sees an image in its own context, so `vision: false` is truthful.

### Tools

| Tool | Effect |
|---|---|
| `capture_canvas` | Calls the supplied capture closure (`RendererAdapter.captureImage()`), stores the PNG in a client-side `VisionWorkspace`, returns `{ width, height, byteLength }`. The bytes never enter the message history. |
| `critique_canvas` | POSTs the held image to `/api/agent/vision-critique`; returns the findings as JSON text. |
| `report_findings` | POSTs selected findings to `/api/sessions/:id/findings`. |

The agent's work between those calls is judgement: whether a finding is real, whether it repeats
the previous round, whether it justifies a repair. That is what makes it an agent rather than a
pipe, and it is why `report_findings` takes a subset rather than forwarding everything.

### Cadence and termination

- Wakes on `SessionCompleted`, and again after each repair redraw reaches `SessionCompleted`.
- Never on a wall-clock timer, and never mid-draw — a half-finished diagram produces false
  positives that cost tokens.
- Hard cap: **2 critique rounds per session** (`SKETCHMIND_VISION_MAX_ROUNDS`).
- A round whose findings are identical to the previous round's is dropped without reporting.
- Budget exhaustion ends the loop and is reported as a trace step, not an error.

## Repair

`SessionManager` retains the session's `ReasoningWorkspace` and `GeometryWorkspace` after the agent
run completes, until the session is disposed.

`POST /api/sessions/:id/findings` returns `202` and starts a fresh `runAgent` over the **same
`ToolRegistry`**, with the findings rendered as its goal text. Budget: 12 steps
(`SKETCHMIND_REPAIR_MAX_STEPS`), counted against a per-session limit of 2 repair rounds
(`SKETCHMIND_REPAIR_MAX_ROUNDS`).

It repairs using the tools it already has — edit the Diagram AST, `derive_constraints`,
`solve_layout`, `plan_strokes` — and playback then replays the new Stroke AST. There is no second
way to author geometry: the solver stays the only producer of coordinates, and fix proposals are
inputs to it, never substitutes for it.

The session's single `AbortController` covers repair turns, so cancellation semantics are unchanged.

## Gating

### Two model roles, independently resolved

Critique needs a model that accepts text **and** images. The model driving the session may not be
one, and may never be one. So the system resolves two *roles* rather than one provider:

| Role | Used by | Needs |
|---|---|---|
| `text` | The session agent, the repair turn, the client agent's own reasoning | Tool calling |
| `vision` | `critiqueImage` on the critique route, only | Text + image input |

Each role resolves independently to **a provider and a model**. Setting neither role variable makes
them the same object, so the common case — one model doing both — costs no configuration:

```ts
// apps/api/src/provider.ts
export type ProviderRole = "text" | "vision";

export function resolveRoleProvider(
  role: ProviderRole,
  env: NodeJS.ProcessEnv = process.env,
): LLMProvider | undefined {
  const prefix = role === "vision" ? "SKETCHMIND_VISION" : "SKETCHMIND_TEXT";
  const id = env[`${prefix}_PROVIDER`]?.trim() || env[PROVIDER_ENV_VAR]?.trim();
  if (!id) return undefined;

  const model = env[`${prefix}_MODEL`]?.trim();
  const provider = buildProviderRegistry().create(id, env, model ? { model } : {});

  return role === "vision" && !provider.capabilities.vision ? undefined : provider;
}
```

When both roles resolve to the same id and no model override differs, the two calls return
equivalent providers and the composition root reuses one instance — same model for both purposes,
one object, no duplicate client.

### The model override mechanism

`ProviderFactory` gains an optional second argument, and `ProviderRegistry.create` forwards it:

```ts
export interface ProviderOptions {
  /** Overrides the model/deployment the adapter would otherwise take from env. */
  readonly model?: string;
}
export type ProviderFactory = (env: ProviderEnv, options?: ProviderOptions) => LLMProvider;
```

This is deliberately the *only* addition to the provider abstraction in this phase, and it is
additive — existing factories ignoring the argument keep working. Each adapter applies the override
to whatever its own model concept is (`AZURE_OPENAI_DEPLOYMENT`, `ANTHROPIC_MODEL`), so vendor
variable names stay inside their packages and `apps/api` never learns them. `FakeProvider` honours
it too, which is what makes the split testable without credentials.

An adapter must report capabilities **for the model it was actually constructed with**. For the
Azure adapter, `AZURE_OPENAI_VISION_DEPLOYMENT` becomes the default model for the `vision` role, and
a provider constructed for that role reports `vision: true`; the same adapter constructed for the
`text` role on `AZURE_OPENAI_DEPLOYMENT` reports whatever that deployment supports. One adapter,
two instances, honest flags on each.

The critique route holds the vision-role provider; the session holds the text-role provider.
Neither knows the other's id or model, and adding a vision-capable provider later is still "one new
`llm-provider-*` package plus one config value".

### The gate

```ts
visualCritiqueEnabled =
     modeAllows(config.vision.mode)              // "on" | "auto" (see below)
  && visionProvider !== undefined                // resolved AND capabilities.vision === true
  && renderer.capabilities.captureImage
  && renderer.capabilities.raster;
```

All must pass. Any one false leaves the tier inert rather than failing at request time.

`SKETCHMIND_VISION_MODE` takes three values:

| Value | Behaviour |
|---|---|
| `off` (default) | Tier 2 never runs, whatever the provider can do |
| `auto` | Tier 2 runs **iff** a vision-capable provider resolves — the "we found a model that can do this" case, with no config change beyond pointing at it |
| `on` | Tier 2 is required; if no vision-capable provider resolves, the server logs a loud misconfiguration warning at boot rather than silently degrading |

`auto` is the answer to "later we may find a capable model": point `SKETCHMIND_VISION_PROVIDER` (or
the session provider) at it and the tier turns itself on. `off` remains the default so that
enabling vision is always a deliberate act, and `on` exists so a deployment that depends on
critique finds out at boot instead of mid-session.

Capability is read from `provider.capabilities.vision`, never from the provider's id. Where an
adapter supports it, `probeCapabilities()` may be called once at boot to verify the declaration
against the live endpoint (D-5) — an adapter that claims vision and cannot deliver it is caught
there rather than on the first upload.

The session-start payload gains `visionEnabled: boolean`. When it is false, `apps/studio` builds
the client agent **without** `capture_canvas` and `critique_canvas` in its registry. With vision
off, no image is ever captured, encoded, sent or logged — and that is provable by inspecting the
registry rather than by trusting a branch not to be taken.

`POST /api/agent/vision-critique` returns `503` with a reason when the gate is closed, so a
misconfiguration is legible instead of silent.

### Configuration

All of it lands on `ApiConfig.vision`, read once in `apps/api/src/config.ts` — no package reads
`process.env`.

| Variable | Default | Meaning |
|---|---|---|
| `SKETCHMIND_GEOMETRIC_CRITIQUE` | `on` | Tier 1 master switch |
| `SKETCHMIND_VISION_MODE` | `off` | Tier 2 switch: `off` \| `auto` \| `on` |
| `SKETCHMIND_LLM_PROVIDER` | — | Existing. The provider both roles fall back to |
| `SKETCHMIND_TEXT_PROVIDER` | *(falls back)* | Registry id for the `text` role |
| `SKETCHMIND_TEXT_MODEL` | *(adapter's own)* | Model/deployment override for the `text` role |
| `SKETCHMIND_VISION_PROVIDER` | *(falls back)* | Registry id for the `vision` role |
| `SKETCHMIND_VISION_MODEL` | *(adapter's own)* | Model/deployment override for the `vision` role |

The two roles are fully independent — either may name any registered provider and any model, and
they need not agree on either:

```sh
# One model, both roles. Nothing to set beyond what already exists.
SKETCHMIND_LLM_PROVIDER=anthropic

# Same provider, two deployments.
SKETCHMIND_LLM_PROVIDER=azure-openai
SKETCHMIND_TEXT_MODEL=gpt-4o-mini
SKETCHMIND_VISION_MODEL=gpt-4o

# Different providers entirely.
SKETCHMIND_TEXT_PROVIDER=azure-openai
SKETCHMIND_VISION_PROVIDER=anthropic

# Different providers and explicit models on each.
SKETCHMIND_TEXT_PROVIDER=azure-openai
SKETCHMIND_TEXT_MODEL=gpt-4o-mini
SKETCHMIND_VISION_PROVIDER=anthropic
SKETCHMIND_VISION_MODEL=claude-sonnet-5
```

Nothing constrains the pairing. The `vision` role's only requirement is that whatever it resolves
to reports `capabilities.vision`; the `text` role's only requirement is `capabilities.toolCalling`.
Neither role knows the other exists.
| `SKETCHMIND_VISION_MAX_ROUNDS` | `2` | Client critique rounds per session |
| `SKETCHMIND_VISION_MAX_IMAGE_BYTES` | `4_000_000` | Upload cap on the critique route |
| `SKETCHMIND_REPAIR_MAX_ROUNDS` | `2` | Repair turns per session, both tiers combined |
| `SKETCHMIND_REPAIR_MAX_STEPS` | `12` | Agent steps per repair turn |

Geometric thresholds default as listed under Tier 1 and are overridable through the same config
object.

The plan's original switch, `AZURE_OPENAI_VISION_DEPLOYMENT`, is deliberately **not** part of this
gate. It is an Azure-specific variable and belongs to `llm-provider-azure-openai`, which is the only
package allowed to read it; its effect reaches this gate through `provider.capabilities.vision`.
Nothing in `agent-vision`, `apps/api` or `apps/studio` names a vendor, an Azure variable, or a
provider id — the gate would read identically if Azure were removed from the repo entirely.

## Error handling

- A failed `critiqueImage` parse is a `ValidationResult` failure returned to the client agent as a
  tool error it can retry once — not a session failure (AD-2).
- A provider transport failure on the critique route returns `502` with a structured
  `SketchMindError`, never the provider's own message (which can name a deployment).
- `captureImage()` failing on the client ends the vision loop with a trace step. Playback and the
  drawn diagram are unaffected.
- A repair turn that fails leaves the previously drawn diagram intact; the failure is a trace
  step, not a `SessionFailed`.

## Testing

| Test | Asserts |
|---|---|
| Per-check unit tests in `agent-vision` | Each of the seven checks fires on a hand-built layout and stays silent on a clean one |
| Seeded misplaced-rope fixture | Detected and corrected by **tier 1 alone**, verified by comparing before/after `LayoutModel` |
| Clean-diagram fixture | Zero findings; no repair turn starts; no oscillation |
| Repair cap | A fixture that always produces findings terminates at the round cap |
| Vision-off | Client registry contains no `capture_canvas`/`critique_canvas`; no `completeWithImages` call is made; no image bytes are produced. Asserted in code, not by configuration |
| Vision-on with `FakeProvider` | Setting the config value enables tier 2 with **no code change** |
| Provider independence | A `FakeProvider` registered under two different ids, one with `vision: true`, drives the whole tier-2 path identically. A grep over `agent-vision`, the critique route and `apps/studio` finds no vendor name, no provider id and no `AZURE_*` variable |
| Role matrix | All four combinations resolve correctly: same provider + same model; same provider + two models; two providers; two providers + two models. Driven by `FakeProvider` registered under several ids, no credentials |
| Role isolation | With split roles, the text-role provider's `completeWithImages` is never called and the vision-role provider's `completeWithTools` is never called |
| Model override | `ProviderFactory`'s `options.model` overrides the adapter's env-derived model in every adapter, and omitting it preserves current behaviour exactly |
| `auto` mode | With `mode=auto` and a non-vision provider, the tier stays inert; swapping in a vision-capable provider turns it on with no other change |
| `critiqueImage` parsing | Malformed model output becomes a `ValidationResult` failure, not a throw |
| Route validation | Oversized and malformed uploads are rejected, matching `/api/agent/llm`'s discipline |
| `check-client-bundle` | Gains `apps/studio` as a target; browser bundle carries no provider SDK and no credentials |

`critiqueImage` is tested against `FakeProvider` only. No test calls a live endpoint.

## Acceptance criteria

- [ ] A seeded diagram with an obviously misplaced component is detected and corrected by tier 1
      alone, verified by comparing before/after `LayoutModel`.
- [ ] A correct diagram passes critique without spurious changes.
- [ ] Correction rounds are budget-capped; the loop always terminates.
- [ ] With `SKETCHMIND_VISION_MODE=off`, the full pipeline runs end to end with tier 1 only — no
      image is ever encoded, sent or logged. Asserted by a test.
- [ ] Setting `SKETCHMIND_VISION_MODE` to `on` or `auto` against any vision-capable provider and a
      raster renderer enables tier 2 with no code change.
- [ ] The vision provider is resolvable independently of the session provider, and no code outside
      `apps/api/src/provider.ts` names a provider id or a vendor.
- [ ] Critique findings appear in the trace panel tagged with their tier.
- [ ] The client agent runs an `agent-core` loop with its own budget and trace, and the browser
      bundle contains no provider SDK or credentials.

## Out of scope

Mid-draw critique. Canvas mutation tools (`highlight_object`, `zoom_to`, `erase_object`,
`relayout_region` — Phase 11). Multimodal changes to `agent-core` or any provider adapter. A UI
toggle for vision. Server-side headless rasterisation for critique. Any change to `apps/web`.
