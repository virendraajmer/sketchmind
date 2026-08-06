/**
 * @sketchmind/session-protocol
 *
 * The typed client/server contract: what the server streams, what the client
 * commands, and how both are framed.
 *
 * Server -> client is `RuntimeEvent`, re-exported here rather than redefined.
 * The runtime already emits that union and `shared-types` is where shared models
 * live; a second "wire event" type would be the same information with a second
 * chance to be wrong. What this package adds is the other direction (commands,
 * which only ever arrive from a browser and so are parsed at the boundary) and
 * the framing.
 *
 * Nothing here is transport-specific except `sse.ts`. That is deliberate: the
 * event types, command types and validators survive a move to WebSocket
 * unchanged.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */

export const PACKAGE_NAME = "@sketchmind/session-protocol";
export const PACKAGE_VERSION = "0.0.1";

export {
  RuntimeEventSchema,
  type RuntimeEvent,
  type RuntimeEventType,
} from "@sketchmind/shared-types";

export {
  AgentToolProxyCommandSchema,
  CancelSessionCommandSchema,
  ClientCommandSchema,
  FollowUpRequestCommandSchema,
  StartSessionCommandSchema,
  parseClientCommand,
  type AgentToolProxyCommand,
  type CancelSessionCommand,
  type ClientCommand,
  type ClientCommandType,
  type FollowUpRequestCommand,
  type StartSessionCommand,
} from "./commands.js";

export {
  SSE_HEADERS,
  SSE_KEEPALIVE,
  decodeServerEvent,
  encodeServerEvent,
} from "./sse.js";
