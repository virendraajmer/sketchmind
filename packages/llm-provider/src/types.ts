/**
 * The provider-independent model interface.
 *
 * D-2: this file must contain no provider concept. Not `api-version`, not
 * `deployment`, not `input` vs `messages`, not Azure content parts, not
 * Anthropic's `system` top-level split. Everything provider-specific is
 * translated inside an adapter.
 *
 * The test for whether the abstraction is real: if a field cannot be expressed
 * by BOTH Azure and Anthropic, it does not belong here. That constraint is why
 * `llm-provider-anthropic` exists at all -- a single adapter would let an
 * Azure-shaped interface pass as a generic one.
 */
import type { SketchMindError } from "@sketchmind/shared-types";
import type { ZodType, z } from "zod";

/** Roles every provider we target can express. */
export type MessageRole = "user" | "assistant" | "tool";

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

/**
 * An assistant turn, optionally including the tool calls it made.
 *
 * Phase 4, D-1: an agent loop has to replay its own tool calls back to the model
 * on the next step. Anthropic in particular *rejects* a `tool_result` whose
 * matching `tool_use` is absent from the history, so dropping this field would
 * make multi-step loops fail against a real provider while passing every test
 * against the fake.
 */
export interface AssistantMessage {
  readonly role: "assistant";
  /** May be empty when the turn was nothing but tool calls. */
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
}

/**
 * What a tool returned, keyed to the call that asked for it.
 *
 * `content` is always a string: the caller serializes whatever the handler
 * produced. Modelling every provider's content-block vocabulary here would drag
 * provider concepts into the interface for no gain -- both targets accept a
 * string result.
 *
 * `isError` is first-class because AD-2 makes a failed tool result the
 * interesting case rather than the exceptional one, and both providers can say
 * "this one failed" natively.
 */
export interface ToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError?: boolean;
}

/**
 * The two-arm shape Phase 3 used is a strict subset of this union, so every
 * existing call site still compiles.
 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * A capability set. Read, never assumed: `completeStructured` picks its
 * mechanism from `structuredOutput`, and callers above this layer never see
 * which one ran.
 */
export interface LLMCapabilities {
  /** Native schema-constrained output. False selects the repair fallback. */
  readonly structuredOutput: boolean;
  readonly toolCalling: boolean;
  readonly parallelToolCalls: boolean;
  readonly streaming: boolean;
  /** AD-3 / Phase 10b. Defaults to false -- the agent works on JSON only. */
  readonly vision: boolean;
  readonly maxContextTokens: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface CompletionRequest {
  readonly system?: string;
  readonly messages: readonly Message[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly stop?: readonly string[];
  /** Cancellation. Honoured by the transport, not simulated by a timer. */
  readonly signal?: AbortSignal;
}

export interface CompletionResponse {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly model: string;
  readonly finishReason: FinishReason;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "unknown";

export interface CompletionChunk {
  readonly delta: string;
  readonly done: boolean;
}

/**
 * A structured request names its schema. `name` becomes the JSON Schema title
 * that providers require (Azure: `text.format.name`; Anthropic: the tool name),
 * so it must be `[a-zA-Z0-9_-]{1,64}`.
 */
export interface StructuredRequest<S extends ZodType> extends CompletionRequest {
  readonly schema: S;
  readonly name: string;
  readonly description?: string;
  /**
   * How many times to feed validation errors back and ask again when the
   * provider has no native structured output. Ignored when it does.
   */
  readonly maxRepairAttempts?: number;
}

export interface StructuredResponse<T> {
  readonly value: T;
  readonly usage: TokenUsage;
  readonly model: string;
  /** Which mechanism actually produced the value. Observability, not control flow. */
  readonly mechanism: StructuredMechanism;
  /** 0 when the first attempt validated. Non-zero proves the fallback engaged. */
  readonly repairAttempts: number;
}

export type StructuredMechanism = "native" | "forced-tool" | "prompt-repair";

/** A tool as the model sees it. Mirrors `ToolSpec` minus the execution locus. */
export interface ToolCallSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments. Produced from Zod by the caller. */
  readonly parameters: Record<string, unknown>;
}

export interface ToolRequest extends CompletionRequest {
  readonly tools: readonly ToolCallSpec[];
  readonly toolChoice?: "auto" | "required" | "none";
  /** Only honoured when `capabilities.parallelToolCalls` is true. */
  readonly allowParallelCalls?: boolean;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Parsed arguments. Adapters parse the provider's JSON string here. */
  readonly arguments: Record<string, unknown>;
}

export interface ToolResponse {
  /** Empty when the model chose to answer in prose instead of calling a tool. */
  readonly toolCalls: readonly ToolCall[];
  readonly text: string;
  readonly usage: TokenUsage;
  readonly model: string;
  readonly finishReason: FinishReason;
}

/** AD-3 / Phase 10b. Never constructed while `capabilities.vision` is false. */
export interface ImageInput {
  readonly mimeType: string;
  /** Base64, no data-URI prefix. Adapters add whatever wrapper they need. */
  readonly base64: string;
}

export interface VisionRequest extends CompletionRequest {
  readonly images: readonly ImageInput[];
}

/**
 * Every provider implements exactly this. Nothing above this layer may import
 * a provider package -- selection happens through the registry (D-9), which is
 * what makes swapping providers a one-line env change.
 */
export interface LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: LLMCapabilities;

  complete(req: CompletionRequest): Promise<CompletionResponse>;
  completeStructured<S extends ZodType>(
    req: StructuredRequest<S>,
  ): Promise<StructuredResponse<z.infer<S>>>;
  completeWithTools(req: ToolRequest): Promise<ToolResponse>;
  completeWithImages(req: VisionRequest): Promise<CompletionResponse>;
  stream(req: CompletionRequest): AsyncIterable<CompletionChunk>;

  /**
   * Verify declared capabilities against the live endpoint (D-5). Opt-in: a
   * probe on every construction would cost a round trip per process, and
   * hardcoding a model catalogue instead goes stale the week it is written.
   */
  probeCapabilities?(): Promise<LLMCapabilities>;
}

/**
 * Thrown by providers. This is the one place in SketchMind where an exception
 * is right: a provider failure is not the agent producing bad output (AD-2's
 * "observation"), it is the transport being unable to answer at all. Callers
 * that want it as an observation read `.error` and hand that to the agent.
 */
export class LLMProviderError extends Error {
  readonly error: SketchMindError;
  readonly retryable: boolean;
  /** Milliseconds the provider asked us to wait, from `Retry-After`. */
  readonly retryAfterMs?: number;

  constructor(error: SketchMindError, retryable: boolean, retryAfterMs?: number) {
    super(`[${error.code}] ${error.message}`);
    this.name = "LLMProviderError";
    this.error = error;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}
