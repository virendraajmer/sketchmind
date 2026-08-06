/**
 * Client -> server commands (Volume 16 §Session).
 *
 * The direction matters. Server -> client is `RuntimeEvent`, which already
 * exists in `shared-types` because the runtime emits it; these are the messages
 * travelling the other way, and every one of them arrives from a browser. So
 * they are parsed, never cast: `parseClientCommand` is the boundary, and past it
 * nothing is `unknown`.
 *
 * All four are defined now, including the two Phase 9 does not yet act on.
 * `FollowUpRequest` and `AgentToolProxy` are part of the contract a client codes
 * against, and adding them later would be a wire change rather than a feature.
 */
import {
  MetadataSchema,
  parseWith,
  type ValidationResult,
} from "@sketchmind/shared-types";
import { z } from "zod";

export const PACKAGE = "@sketchmind/session-protocol";

export const StartSessionCommandSchema = z.object({
  type: z.literal("StartSession"),
  userInput: z.string().min(1).max(2000),
  metadata: MetadataSchema.optional(),
});
export type StartSessionCommand = z.infer<typeof StartSessionCommandSchema>;

export const CancelSessionCommandSchema = z.object({
  type: z.literal("CancelSession"),
  sessionId: z.string().min(1),
  reason: z.string().optional(),
});
export type CancelSessionCommand = z.infer<typeof CancelSessionCommandSchema>;

/** A second turn against a session that has already drawn something. */
export const FollowUpRequestCommandSchema = z.object({
  type: z.literal("FollowUpRequest"),
  sessionId: z.string().min(1),
  message: z.string().min(1).max(2000),
});
export type FollowUpRequestCommand = z.infer<typeof FollowUpRequestCommandSchema>;

/**
 * A client-locus tool call the server must authorize before it runs (AD-8).
 *
 * The browser holds tool *specs*, never authority -- so a client tool with any
 * server-side effect comes back here to be re-validated against the registry
 * rather than trusted because the client already decided to call it. Phase 11
 * implements that check; Phase 9 fixes the shape it will arrive in.
 */
export const AgentToolProxyCommandSchema = z.object({
  type: z.literal("AgentToolProxy"),
  sessionId: z.string().min(1),
  toolName: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()),
});
export type AgentToolProxyCommand = z.infer<typeof AgentToolProxyCommandSchema>;

export const ClientCommandSchema = z.discriminatedUnion("type", [
  StartSessionCommandSchema,
  CancelSessionCommandSchema,
  FollowUpRequestCommandSchema,
  AgentToolProxyCommandSchema,
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;
export type ClientCommandType = ClientCommand["type"];

/**
 * Parse a command off the wire.
 *
 * Returns a `ValidationResult` rather than throwing (D-2): a malformed command
 * is a 400 with every problem listed, not a stack trace.
 */
export function parseClientCommand(input: unknown): ValidationResult<ClientCommand> {
  return parseWith(ClientCommandSchema, input, { package: PACKAGE, stage: "agent" });
}
