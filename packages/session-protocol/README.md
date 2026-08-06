# @sketchmind/session-protocol

The typed client/server contract: what the server streams, what the client
commands, and how both are framed.

## Server → client: `RuntimeEvent`

Re-exported from `shared-types`, not redefined. The runtime already emits that
union and shared models live in exactly one place; a second "wire event" type
would be the same information with a second chance to be wrong.

It is a discriminated union, so the browser handles a frame with an exhaustive
`switch` the compiler checks — adding an event produces a compile error at every
consumer that forgot it.

## Client → server: `ClientCommand`

| Command | |
|---|---|
| `StartSession` | `{ userInput }` — begins a run. |
| `CancelSession` | `{ sessionId, reason? }` |
| `FollowUpRequest` | `{ sessionId, message }` — a second turn against a session that already drew. |
| `AgentToolProxy` | `{ sessionId, toolName, args }` — a client-locus tool call the server must authorize (AD-8). |

All four are defined now, including the two Phase 9 does not act on. They are
part of the contract a client codes against, and adding them later would be a
wire change rather than a feature.

Commands only ever arrive from a browser, so `parseClientCommand` is the
boundary: it returns a `ValidationResult` with *every* problem (D-2), and past it
nothing is `unknown`. `AgentToolProxy` in particular is a request, never an
instruction — the browser holds tool specs, never authority, so a client tool
with server-side effects is re-validated against the registry here rather than
trusted because the client already decided to call it.

## Framing

`encodeServerEvent` / `decodeServerEvent` plus `SSE_HEADERS` and
`SSE_KEEPALIVE`. This is the only transport-specific file in the package; when a
later phase swaps SSE for a WebSocket it replaces these two functions and every
event type, command type and validator above them is untouched. That is the
reason the protocol is a package rather than a folder in `apps/api`.

The decoder validates rather than casts. An event off the network is untrusted
input, and the UI's exhaustive `switch` is only sound if the value really is a
union member.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

This package may depend only on its own layer or below. Direction is enforced
by `scripts/check-layering.mjs`; run `pnpm run check:layering`.
