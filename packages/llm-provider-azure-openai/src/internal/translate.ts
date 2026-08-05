/**
 * Translation between SketchMind's provider-independent types and the Azure
 * Responses API.
 *
 * All the Azure-shaped thinking lives here so that `provider.ts` reads as the
 * contract rather than as an SDK wrapper -- and so the next adapter has a
 * visible template for what it actually has to do.
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
import { APIConnectionTimeoutError, APIConnectionError, APIError, APIUserAbortError } from "openai";
import type { Responses } from "openai/resources/responses/responses";

export function toInput(req: CompletionRequest): Responses.ResponseInput {
  return req.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export function toTools(tools: readonly ToolCallSpec[]): Responses.FunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // Tool argument schemas come from callers and are not run through our
    // strict normalizer, so demanding strict validation here would reject
    // perfectly good tools. Phase 4 validates arguments with Zod on arrival.
    strict: false,
  }));
}

export function toUsage(usage: Responses.ResponseUsage | undefined): TokenUsage {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    // Recompute rather than trusting `total_tokens`: budgets in Phase 4 are
    // enforced against the sum, and a total that disagrees with its parts would
    // make those budgets quietly wrong.
    totalTokens: inputTokens + outputTokens,
  };
}

export function toFinishReason(response: Responses.Response): FinishReason {
  if (response.output.some((item) => item.type === "function_call")) return "tool_calls";
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "max_output_tokens") return "length";
    if (reason === "content_filter") return "content_filter";
    return "unknown";
  }
  return response.status === "completed" ? "stop" : "unknown";
}

export function toToolCalls(response: Responses.Response): ToolCall[] {
  return response.output
    .filter((item): item is Responses.ResponseFunctionToolCall => item.type === "function_call")
    .map((item) => ({
      id: item.call_id,
      name: item.name,
      // Parse here, once. Passing the raw string through would make every tool
      // implementation parse it again and disagree about failure handling.
      arguments: parseArguments(item.arguments),
    }));
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A malformed argument blob is the model's mistake, and Phase 4's Zod
    // validation turns the resulting empty object into a legible observation.
    return {};
  }
}

interface AzureErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly code?: string;
}

/**
 * Flatten an SDK error into the shape the shared classifier understands. This
 * is the whole of the adapter's error responsibility: it classifies, and
 * `llm-provider` decides what the classification means (D-6).
 */
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
    const body = cause.error as AzureErrorBody | undefined;
    return classifyFailure(
      {
        status: cause.status,
        providerCode: body?.error?.code ?? body?.code ?? cause.code ?? undefined,
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
