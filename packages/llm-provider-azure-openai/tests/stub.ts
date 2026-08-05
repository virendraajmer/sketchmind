/**
 * A stand-in for the `OpenAI` client.
 *
 * The adapter takes its client by injection precisely so the default suite can
 * exercise every path -- retries, content filters, streaming, tool calls --
 * without a network and without credentials. The live test (`live.test.ts`)
 * covers the one thing a stub cannot: that Azure agrees with our reading of it.
 */
import type OpenAI from "openai";
import { APIError, APIUserAbortError } from "openai";
import type { Responses } from "openai/resources/responses/responses";

export interface StubResponseInit {
  readonly text?: string;
  readonly output?: Responses.ResponseOutputItem[];
  readonly status?: Responses.Response["status"];
  readonly incompleteReason?: "max_output_tokens" | "content_filter";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export function stubResponse(init: StubResponseInit = {}): Responses.Response {
  const text = init.text ?? "ok";
  return {
    id: "resp_stub",
    created_at: 0,
    output_text: text,
    error: null,
    incomplete_details: init.incompleteReason ? { reason: init.incompleteReason } : null,
    instructions: null,
    metadata: null,
    model: "stub-deployment",
    object: "response",
    output: init.output ?? [],
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    status: init.status ?? "completed",
    usage: {
      input_tokens: init.inputTokens ?? 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: init.outputTokens ?? 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: (init.inputTokens ?? 10) + (init.outputTokens ?? 5),
    },
  } as unknown as Responses.Response;
}

export function functionCall(name: string, args: unknown): Responses.ResponseOutputItem {
  return {
    type: "function_call",
    call_id: `call_${name}`,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  } as unknown as Responses.ResponseOutputItem;
}

/** An `APIError` shaped the way the SDK builds one from a real HTTP failure. */
export function apiError(
  status: number,
  options: { code?: string; retryAfter?: string; message?: string } = {},
): APIError {
  const headers = new Headers();
  if (options.retryAfter) headers.set("retry-after", options.retryAfter);
  return new APIError(
    status,
    { error: { code: options.code, message: options.message ?? "failed" } },
    options.message ?? "failed",
    headers,
  );
}

export type CreateHandler = (
  params: Responses.ResponseCreateParams,
  options?: { signal?: AbortSignal },
) => unknown;

export interface Stub {
  readonly client: OpenAI;
  /** Every `responses.create` call, for assertions about what we sent. */
  readonly calls: Responses.ResponseCreateParams[];
}

export function stubClient(handler: CreateHandler): Stub {
  const calls: Responses.ResponseCreateParams[] = [];
  const client = {
    responses: {
      create: async (
        params: Responses.ResponseCreateParams,
        options?: { signal?: AbortSignal },
      ) => {
        calls.push(params);
        if (options?.signal?.aborted) throw new APIUserAbortError();
        const result = handler(params, options);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

/** Answers each call from a queue; the last entry repeats. */
export function scripted(...results: unknown[]): CreateHandler {
  let index = 0;
  return () => {
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    return result;
  };
}

export async function* textDeltas(...deltas: string[]): AsyncIterable<unknown> {
  for (const delta of deltas) {
    yield { type: "response.output_text.delta", delta };
  }
  yield { type: "response.completed" };
}
