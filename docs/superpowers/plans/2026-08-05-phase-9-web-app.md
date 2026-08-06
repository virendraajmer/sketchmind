# Phase 9 — Web App, Protocol & Live Agent

**Branch:** `phase-9`
**Packages/apps:** `session-protocol`, `agent-tools-geometry`, `apps/api`, `apps/web`
**Deliverable:** the vertical slice — type a request in a browser, watch an agent reason about it
and draw it stroke by stroke, with a live trace panel as the debugging surface.

Phases 1–8 built every stage of the pipeline and an agent loop that can call any of them as a tool.
Nothing connected it to a person. This phase is the wiring, and the wiring is deliberately thin:
`apps/api/src/session/run.ts` is under 200 lines because everything it composes already worked.

---

## Design decisions

### D-1. The wire event is `RuntimeEvent`, not a new type

The plan listed `SessionStarted`, `AgentStep`, `StrokeGenerated`, `DiagramASTReady`,
`SessionCompleted`, `SessionFailed` as protocol events to define. Almost all of them already
existed: `shared-types/src/runtime.ts` has emitted a discriminated `RuntimeEvent` union since Phase
7, because the stroke runtime needed one, and `agent-core`'s `onStep` doc comment already said
"Phase 9's SSE stream is one line here."

So `session-protocol` re-exports that union rather than declaring a parallel one. A second "wire
event" type would be the same information with a second chance to be wrong, and it would need an
adapter at exactly the boundary where a mistake is least visible.

Three members were added to the union rather than invented beside it:

- **`AgentStep` grew the rest of `AgentTraceStep`** — `thought`, `toolArgs`, `toolResult`,
  `tokensIn/Out`, `durationMs`, `error`. It previously carried only `toolName`. The trace panel is
  the primary debugging surface for an autonomous agent (AD-8), and a panel that must fetch each
  step's detail separately cannot show it live.
- **`DiagramASTReady`** — fires the moment the AST exists, so the inspector fills in while layout
  is still being solved.
- **`FrameUpdate`** — one playback tick, and the only event carrying geometry. It also carries
  `bounds`, the extent of the *whole* drawing rather than of this frame, so a client fits its
  viewport once. Fitting to the frame would visibly re-zoom on every stroke.

### D-2. `DrawingFrame` became a real schema, and the twin types collapsed into it

`stroke-runtime`'s `DrawingFrame` and `renderer-core`'s `RenderFrame` were two hand-written,
structurally identical interfaces. Phase 8 D-2 explains why: `renderer` sits *below* `core`, so
neither package may import the other's type, and the duplication was policed by a compile-time
assignment in `tests/render-pipeline.test.ts`.

That was the right call while the shape never left one process. Phase 9 puts it on the wire, and an
unvalidated frame arriving from the network is exactly what the schema layer is for. Both packages
already depend on `shared-types`, so defining `DrawingFrameSchema` there *removes* the duplication
instead of adding a third copy — both names are now aliases. The Phase 8 assignment test is kept,
because it is what would catch either package reintroducing a local declaration.

Its arrays are `.readonly()` so `z.infer` reproduces the previous interfaces exactly.

One consequence needed handling. `llm-provider`'s `json-schema.test.ts` asserts that no shared model
admits `null`, because `decodeStrictOutput` strips nulls and our models express absence as
`undefined`. `DrawingFrame.inProgress` is `null` when no stroke is mid-flight — a real state, not an
absent field. The invariant is narrowed with a named, asserted exemption rather than by reshaping
the model: a frame is playback geometry, no model may emit geometry at all, so it can never be a
structured-output target and never travels through the decoder.

### D-3. `RuntimeEventBody` lives beside the union

Both emitters — the runtime, which stamps its own session id, and the API, which stamps both —
need "a `RuntimeEvent` minus the fields I already know". A bare `Omit<RuntimeEvent, ...>` collapses
the union to its members' common keys and silently discards `strokeId`, `frame`, `ast`. It
type-checks, then rejects every event body carrying a payload.

`stroke-runtime` had solved this locally with a distributive conditional. It is now exported from
`shared-types` next to the union it describes, which is what stops a third emitter rediscovering
the trap.

### D-4. Geometry tools have no geometry guard, and show the model no geometry

Every reasoning tool runs its output through a guard that rejects coordinates, because a model
authored that output. `derive_constraints`, `solve_layout` and `plan_strokes` are deterministic code
and producing coordinates is exactly their job — the guard is not omitted by oversight, it would be
checking the wrong invariant. `agent-tools-geometry`'s module comment says so, so the absence reads
as a decision.

The inverse holds for what comes back. Each handler stores the real artifact in the
`GeometryWorkspace` and returns a *summary*: counts, the strategy chosen, canvas size, and — from
`plan_strokes` — the object ids that got strokes. A `LayoutModel` is thousands of numbers the model
cannot usefully read, and the surest way to stop it inventing coordinates is to never put any in its
context. `targets` exists so the model can tell "I drew everything" from "I drew the pulley and
forgot the rope" without being shown a single coordinate.

Failures are the exception: a failed `ValidationResult` passes through verbatim, because an error
the model cannot read is one it cannot fix (AD-2).

`GeometryWorkspace` is deliberately not `ReasoningWorkspace`. The two tool packages know nothing
about each other; the join is the `getAst` function passed in at construction — a getter, not a
value, because the AST does not exist when the tools are built.

There is no render tool. Rendering needs a mounted `RendererAdapter`, which lives in the browser.

### D-5. One registry, one continuous run

`runSession` registers reasoning, geometry and memory tools into a single `ToolRegistry` and makes
one `runAgent` call across all three. It is not a reasoning phase followed by a geometry phase:
`compose_diagram_ast` and `solve_layout` are peers in the same catalogue, and the model decides
which stages a given request needs. That is AD-1, and structuring the run in phases would quietly
undo it.

The system prompt is a `PromptTemplate` (V15) like every reasoning package's, so a prompt that
forgets to forbid geometry does not parse. It states each tool's prerequisites and states no order.

### D-6. Events are buffered, and one AbortController is the whole cancellation story

Starting a session and opening its stream are two HTTP requests, and the agent begins immediately.
A client connecting a beat later would otherwise miss `SessionStarted` — reliably, on a fast
machine, which is the worst kind of bug. So `SessionManager` retains every event and replays it to
each new subscriber. `POST /api/sessions` returns `202` without awaiting the run for the same
reason: a drawing takes tens of seconds.

Cancellation is one `AbortController` per session, handed to `runAgent` (which threads it into the
provider call and every `ToolContext`) and checked by the playback loop. One `cancel()` stops an
in-flight model turn *and* an in-progress drawing, and there is no second flag that can disagree
with it. Cancelling the stroke runtime emits `SessionCancelled` itself, so no second terminal event
is synthesised.

### D-7. Playback is a server-side pump

The runtime owns no timers (Phase 7 D-8): it is a pure function of (strokes, timeMs) driven by
`advance(deltaMs)`. The server pumps it on a fixed step and streams `runtime.frame()` per tick,
forwarding the runtime's own `StrokeStarted`/`StrokeCompleted` events untouched — they are already
`RuntimeEvent`s stamped with the session id, which is what D-1 bought.

`tickMs` trades bandwidth against smoothness. It is not a drawing-speed control; stroke durations
live in the Stroke AST.

### D-8. The LLM proxy validates rather than forwards

`POST /api/agent/llm` stands in front of a paid API holding credentials a browser must never see. A
proxy that passed whatever it received straight through would be an open relay wearing a SketchMind
badge, so the request schema is the contract: bounded message counts, bounded prompt lengths, three
known roles, tool *specs* only. A provider exception never reaches the browser either — its message
can name an endpoint or a deployment.

Scope is one method. `completeWithTools` is what an agent loop needs; adding `completeStructured` or
`stream` should each be a decision about what the browser may spend money on.

### D-9. No provider selected means a fake, not a crash

`resolveProvider` returns a `FakeProvider` when `SKETCHMIND_LLM_PROVIDER` is blank. A machine
without a key should start, show the UI, and say why it cannot draw. Set the variable and a missing
adapter variable is a loud startup failure — silently falling back to a fake in production would be
far worse than failing to boot.

`apps/api` reads the environment in exactly two files (`config.ts`, `provider.ts`) and passes plain
data down. `configs/README.md` says no *package* reads `process.env`; an app is not a package, and
something must read it once.

### D-10. The bundle is checked, not just the imports

CI already greps for provider SDK imports outside `packages/llm-provider-*`. That asks "did anyone
write the import?" — `scripts/check-client-bundle.mjs` asks "did anything end up in the file a
browser downloads?", which is the property that actually matters and which a transitive dependency
or an inlined `NEXT_PUBLIC_*` value can break with no import statement changing. It fails if it
finds nothing to scan, so a missing build cannot pass vacuously.

`Whiteboard` is loaded through `next/dynamic` with `ssr: false`: Konva needs a real canvas, and
importing it during Next's server render drags in `node-canvas`. This also keeps it out of the
initial chunk.

---

## Verification

- Unit and route tests: `session-protocol` (17), `agent-tools-geometry` (14), `apps/api` (37),
  `apps/web` (12). The API tests drive the *real* pipeline with a scripted `FakeProvider` — only the
  model is simulated, because wiring is precisely what a mocked pipeline would hide.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:bundle` all pass.
- Driven end to end over real HTTP against a scripted model: 52 SSE frames, 4 strokes, ending
  `SessionCompleted` with `pending: 0`; cancel mid-draw stopped at 17 frames with `SessionCancelled`
  and no `SessionCompleted`; CORS correct for the browser origin; the page serves with all three
  panels; Konva resolves to a lazily-loaded chunk.

**Not verified:** the Konva canvas rendering visually. No browser automation was available in this
environment, and the web tests mock the board — the pixel behaviour underneath is covered by Phase
8's decoded-PNG assertions, but "frames arriving over SSE turn into visible strokes in a real
browser" has not been observed.
