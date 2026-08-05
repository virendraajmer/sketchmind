/**
 * A stand-in for the `Anthropic` client.
 *
 * Same role as the Azure stub, deliberately: the adapter takes its client by
 * injection so the default suite exercises retries, tool calls, streaming and
 * refusals with no network and no key.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  Message,
  MessageCreateParams,
  StopReason,
} from "@anthropic-ai/sdk/resources/messages";

export interface StubMessageInit {
  readonly text?: string;
  readonly content?: ContentBlock[];
  readonly stopReason?: StopReason | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export function stubMessage(init: StubMessageInit = {}): Message {
  const content =
    init.content ??
    (init.text === undefined
      ? [{ type: "text", text: "ok", citations: null }]
      : [{ type: "text", text: init.text, citations: null }]);

  return {
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: "stub-model",
    content,
    stop_reason: init.stopReason === undefined ? "end_turn" : init.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: init.inputTokens ?? 10,
      output_tokens: init.outputTokens ?? 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  } as unknown as Message;
}

/** A `tool_use` block. Note the input is an object, not a JSON string. */
export function toolUse(name: string, input: unknown): ContentBlock {
  return { type: "tool_use", id: `toolu_${name}`, name, input } as unknown as ContentBlock;
}

export function apiError(
  status: number,
  options: { type?: string; retryAfter?: string; message?: string } = {},
): APIError {
  const headers = new Headers();
  if (options.retryAfter) headers.set("retry-after", options.retryAfter);
  return new APIError(
    status,
    { error: { type: options.type, message: options.message ?? "failed" } },
    options.message ?? "failed",
    headers,
  );
}

export type CreateHandler = (
  params: MessageCreateParams,
  options?: { signal?: AbortSignal },
) => unknown;

export interface Stub {
  readonly client: Anthropic;
  /** Every `messages.create` call, for assertions about what we sent. */
  readonly calls: MessageCreateParams[];
}

export function stubClient(handler: CreateHandler): Stub {
  const calls: MessageCreateParams[] = [];
  const client = {
    messages: {
      create: async (params: MessageCreateParams, options?: { signal?: AbortSignal }) => {
        calls.push(params);
        if (options?.signal?.aborted) throw new APIUserAbortError();
        const result = handler(params, options);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  } as unknown as Anthropic;
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
  for (const [index, text] of deltas.entries()) {
    yield { type: "content_block_delta", index, delta: { type: "text_delta", text } };
  }
  yield { type: "message_stop" };
}
