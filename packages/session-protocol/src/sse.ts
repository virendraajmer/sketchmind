/**
 * Server-Sent Events framing.
 *
 * This lives in the protocol package rather than in `apps/api` because the
 * framing is the contract, not the server's private business. When a later phase
 * swaps SSE for a WebSocket, it replaces this file's two functions and every
 * event type, command type and validator above them is untouched -- which is the
 * whole reason the protocol is a package.
 *
 * SSE's one hard rule is that a `data:` line may not contain a newline.
 * `JSON.stringify` escapes newlines inside strings and never emits one between
 * tokens, so one event is always exactly one `data:` line. The decoder still
 * joins multiple `data:` lines per the spec, because a conforming peer is
 * allowed to split them and a decoder that assumed otherwise would be wrong for
 * a reason nobody would find quickly.
 */
import {
  RuntimeEventSchema,
  makeError,
  parseWith,
  fail,
  type RuntimeEvent,
  type ValidationResult,
} from "@sketchmind/shared-types";

export const PACKAGE = "@sketchmind/session-protocol";

/**
 * A comment frame. SSE comments are ignored by `EventSource` but still count as
 * traffic, which is what stops an idle proxy closing the connection while the
 * agent is thinking through a slow first model turn.
 */
export const SSE_KEEPALIVE = ": keep-alive\n\n";

/** Headers a `text/event-stream` response must carry. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Nginx buffers proxied responses by default, which turns a live stream into
  // one delivery at the end.
  "x-accel-buffering": "no",
};

/**
 * Encode one event as an SSE frame.
 *
 * The `event:` field carries the discriminant so a browser may subscribe per
 * type with `addEventListener`. The type is also inside `data`, so a consumer
 * using a single `onmessage` handler and switching on `event.type` loses
 * nothing.
 */
export function encodeServerEvent(event: RuntimeEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Decode one SSE frame back into a validated event.
 *
 * Validates rather than casts. An event arriving over the network is untrusted
 * input like any other, and `RuntimeEvent` is a discriminated union whose
 * exhaustive `switch` in the UI is only sound if the value really is a member.
 */
export function decodeServerEvent(raw: string): ValidationResult<RuntimeEvent> {
  const data = raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");

  if (data === "") {
    return fail([
      makeError({
        code: "PROTOCOL_EMPTY_FRAME",
        message: "SSE frame carried no data lines.",
        package: PACKAGE,
        stage: "agent",
        recoverable: false,
      }),
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    return fail([
      makeError({
        code: "PROTOCOL_MALFORMED_JSON",
        message: `SSE frame data was not valid JSON: ${(error as Error).message}`,
        package: PACKAGE,
        stage: "agent",
        recoverable: false,
      }),
    ]);
  }

  return parseWith(RuntimeEventSchema, parsed, { package: PACKAGE, stage: "agent" });
}
