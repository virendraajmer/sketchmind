# @sketchmind/agent-core

The agent loop, tool registry, budgets, cancellation and tracing. One loop,
shared by both loci (AD-4): the browser runs this same code with a different
tool catalogue, so the client and server agents cannot disagree about how a
turn works.

## Why this shape

The docs (V09) describe nine pipeline stages running in a fixed order every
time. AD-1 turns them into tools the model may call, skip, reorder or repeat —
`runAgent` has no idea a "pipeline" exists; it only runs `observe -> reason ->
select tool(s) -> execute -> observe -> ...` until the model answers instead of
calling a tool, a budget runs out, or the run is cancelled. Everything Phase 5
onward adds is a tool, not a change to this loop.

AD-2 is enforced in `internal/execute.ts`, not by convention: a tool that does
not exist, arguments that fail Zod validation, a handler that throws, and a
handler that reports its own `ValidationResult` failure all come back as an
observation the model reads on its next step. Nothing here throws on account of
the model or a tool — the one exception that escapes `runAgent` is a provider
that cannot answer at all, which is a transport failure, not the agent
producing bad output.

## What lives here

| File | Responsibility |
|---|---|
| `tools.ts` | `defineTool` (Zod in, JSON Schema derived, out) and `ToolRegistry` |
| `internal/execute.ts` | Running one tool call without ever throwing (AD-2) |
| `internal/budget.ts` | `BudgetTracker` (steps/tokens/deadline) and `composeRunSignal` (AD-8) |
| `loop.ts` | `runAgent` — the loop itself |

## Budgets and cancellation (AD-8)

Wall clock is an absolute deadline computed once at the start of a run, checked
at each step boundary — not a `setTimeout`, which cannot stop an in-flight
`await` and needs fake timers to test honestly. Budget exhaustion is a *reason*
a run stops, not an exception: `runAgent` resolves with whatever partial trace
and output exist, because a budget that discarded the work done so far would
bound cost by destroying value.

Cancellation is one composed `AbortSignal` — the caller's signal, the deadline,
and an internal controller — handed to the provider and to every tool handler
via `ToolContext.signal`. A run stops within one step boundary.

## The `ToolSpec` / `ToolDefinition` split

`@sketchmind/shared-types` owns `ToolSpec` (serializable: name, description,
JSON Schema parameters, locus, readOnly) — what a browser agent is sent so it
knows what it may call, without being sent server code. This package owns the
executable half, `ToolDefinition = ToolSpec & { argsSchema, handler }`. A tool
is declared once, in Zod; the JSON Schema the model reads is derived from that
same schema, so "the prompt says one thing and the validator checks another" is
not a bug this design can express.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

Depends on `@sketchmind/llm-provider` and `@sketchmind/shared-types`, and on no
concrete provider — that is what keeps swapping models a one-env-var change.
Direction is enforced by `scripts/check-layering.mjs`; run
`pnpm run check:layering`.
