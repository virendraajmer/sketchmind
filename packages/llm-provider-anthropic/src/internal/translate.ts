/**
 * Translation between SketchMind's provider-independent types and Anthropic's
 * Messages API.
 *
 * Read this next to the Azure translator: same exported names, entirely
 * different bodies. That is the evidence D-2 asked for -- `system` is a
 * top-level field here and an `instructions` field there, `stop_reason` uses a
 * different vocabulary from `status` + `incomplete_details`, and tool arguments
 * arrive already parsed rather than as a JSON string. None of that leaks upward.
 */
import {
  classifyFailure,
  type CompletionRequest,
  type FinishReason,
  type LLMProviderError,
  type TokenUsage,
  type ToolCall,
  type ToolCallSpec,
} from "@sketchmind/llm-provider";
import {
  APIConnectionTimeoutError,
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  Message,
  MessageParam,
  Tool,
  ToolChoice,
  ToolResultBlockParam,
  Usage,
} from "@anthropic-ai/sdk/resources/messages";

/**
 * Build the Messages-API history, including tool round trips.
 *
 * Two rules this API enforces that Azure does not, and that shape the whole
 * function:
 *
 *   1. A `tool_use` block lives *inside* the assistant turn that produced it.
 *      Azure puts calls and outputs in one flat sibling list instead.
 *   2. Every `tool_result` answering one parallel batch must sit in a *single*
 *      user turn. Emitting one turn per result is a 400.
 *
 * Neither rule escapes this file, which is the point of adapters.
 */
export function toMessages(req: CompletionRequest): MessageParam[] {
  const messages: MessageParam[] = [];
  /** The user turn currently collecting tool results, if one is open. */
  let pendingResults: ToolResultBlockParam[] | undefined;

  const flushResults = (): void => {
    if (pendingResults === undefined) return;
    messages.push({ role: "user", content: pendingResults });
    pendingResults = undefined;
  };

  for (const message of req.messages) {
    if (message.role === "tool") {
      pendingResults ??= [];
      pendingResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        // A first-class failure flag, so the model is told the tool failed
        // rather than left to infer it from the wording (AD-2).
        ...(message.isError === true ? { is_error: true } : {}),
      });
      continue;
    }

    flushResults();

    if (message.role === "user") {
      messages.push({ role: "user", content: message.content });
      continue;
    }

    const blocks: ContentBlockParam[] = [];
    // An empty text block is a 400 here, not a harmless no-op, and a turn that
    // was nothing but tool calls has exactly that.
    if (message.content.length > 0) blocks.push({ type: "text", text: message.content });
    for (const call of message.toolCalls ?? []) {
      blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
    }
    messages.push({ role: "assistant", content: blocks.length > 0 ? blocks : message.content });
  }

  flushResults();
  return messages;
}

export function toTools(tools: readonly ToolCallSpec[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // Anthropic requires `type: "object"` at the root of every tool schema. Our
    // `ToolCallSpec.parameters` already carries it; spreading keeps whatever
    // else the caller declared and asserts the one field the API insists on.
    input_schema: { ...tool.parameters, type: "object" } as Tool.InputSchema,
  }));
}

export function toToolChoice(
  choice: "auto" | "required" | "none" | undefined,
  allowParallelCalls: boolean | undefined,
): ToolChoice | undefined {
  if (choice === undefined) return undefined;
  const disable = allowParallelCalls === false ? { disable_parallel_tool_use: true } : {};
  if (choice === "none") return { type: "none" };
  // "required" means *some* tool, not a named one -- that is Anthropic's `any`.
  if (choice === "required") return { type: "any", ...disable };
  return { type: "auto", ...disable };
}

export function toUsage(usage: Usage | undefined): TokenUsage {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  // Anthropic reports no total at all, so recomputing is the only option here --
  // which is exactly why the shared contract asserts the sum rather than
  // trusting whatever a provider calls a total.
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export function toFinishReason(message: Message): FinishReason {
  switch (message.stop_reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      // Nearest shared meaning: the model declined on content grounds. Callers
      // above never learn which provider phrased it which way.
      return "content_filter";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    default:
      return "unknown";
  }
}

export function toText(message: Message): string {
  return message.content
    .filter((block): block is Extract<Message["content"][number], { type: "text" }> =>
      block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

export function toToolCalls(message: Message): ToolCall[] {
  return message.content
    .filter((block): block is Extract<Message["content"][number], { type: "tool_use" }> =>
      block.type === "tool_use",
    )
    .map((block) => ({
      id: block.id,
      name: block.name,
      // Already an object here. The Azure adapter parses a JSON string to reach
      // the same place, and callers cannot tell the difference -- which is the
      // point of parsing inside adapters rather than above them.
      arguments:
        typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
          ? (block.input as Record<string, unknown>)
          : {},
    }));
}

interface AnthropicErrorBody {
  readonly error?: { readonly type?: string; readonly message?: string };
  readonly type?: string;
}

/** Flatten an SDK error into the shape the shared classifier understands (D-6). */
export function toProviderError(cause: unknown, providerPackage: string): LLMProviderError {
  if (cause instanceof APIUserAbortError) {
    return classifyFailure({ kind: "abort", message: "Request was cancelled." }, providerPackage);
  }
  if (cause instanceof APIConnectionTimeoutError) {
    return classifyFailure({ kind: "timeout", message: cause.message }, providerPackage);
  }
  if (cause instanceof APIConnectionError) {
    return classifyFailure({ kind: "connection", message: cause.message }, providerPackage);
  }
  if (cause instanceof APIError) {
    const body = cause.error as AnthropicErrorBody | undefined;
    return classifyFailure(
      {
        status: cause.status,
        providerCode: body?.error?.type ?? body?.type ?? undefined,
        message: cause.message,
        retryAfter: cause.headers?.get?.("retry-after") ?? null,
      },
      providerPackage,
    );
  }
  if (cause instanceof Error && cause.name === "AbortError") {
    return classifyFailure({ kind: "abort", message: cause.message }, providerPackage);
  }
  return classifyFailure(
    { message: cause instanceof Error ? cause.message : String(cause) },
    providerPackage,
  );
}
