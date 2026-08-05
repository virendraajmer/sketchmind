/**
 * An in-memory provider.
 *
 * This is not a testing convenience bolted on afterwards -- it is how the whole
 * repo runs without a network. Phases 4-12 develop the agent, the tools and the
 * pipeline against it, so the default test suite never makes a model call. It
 * is also half the proof that the abstraction is real: the contract suite runs
 * against this and against Azure with one copy of the test body (D-8).
 *
 * Configurable capabilities matter as much as configurable responses. Setting
 * `structuredOutput: false` here is what exercises the repair fallback, which is
 * otherwise dead code until someone plugs in a local model.
 */
import type { ZodType, z } from "zod";
import { ProviderErrorCode, providerError } from "./internal/errors.js";
import { completeStructuredViaPrompt } from "./internal/structured.js";
import { toStrictJsonSchema } from "./internal/json-schema.js";
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResponse,
  LLMCapabilities,
  LLMProvider,
  StructuredRequest,
  StructuredResponse,
  ToolCall,
  ToolRequest,
  ToolResponse,
  TokenUsage,
  VisionRequest,
} from "./types.js";

const PACKAGE = "@sketchmind/llm-provider";

export const FAKE_CAPABILITIES: LLMCapabilities = {
  structuredOutput: true,
  toolCalling: true,
  parallelToolCalls: true,
  streaming: true,
  vision: false,
  maxContextTokens: 128_000,
};

/** What the fake should say next. A function gets the request and decides. */
export type FakeResponder = (req: CompletionRequest) => string | Promise<string>;

export interface FakeProviderOptions {
  readonly id?: string;
  readonly model?: string;
  readonly capabilities?: Partial<LLMCapabilities>;
  /** Consumed in order; the last entry repeats once the queue is exhausted. */
  readonly responses?: readonly (string | FakeResponder)[];
  /** Tool calls to emit from `completeWithTools`, in order. */
  readonly toolCalls?: readonly (readonly ToolCall[])[];
  /** Throw this instead of answering. Set per call to test error paths. */
  readonly failWith?: Error;
}

/** Rough, deterministic, and clearly labelled as an estimate. */
function estimateUsage(promptChars: number, outputChars: number): TokenUsage {
  const inputTokens = Math.ceil(promptChars / 4);
  const outputTokens = Math.ceil(outputChars / 4);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export class FakeProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: LLMCapabilities;

  /** Every request the fake was given, for assertions about what was sent. */
  readonly calls: CompletionRequest[] = [];

  private readonly responses: readonly (string | FakeResponder)[];
  private readonly toolCallQueue: readonly (readonly ToolCall[])[];
  private readonly failWith?: Error;
  private cursor = 0;
  private toolCursor = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.id = options.id ?? "fake";
    this.model = options.model ?? "fake-model";
    this.capabilities = { ...FAKE_CAPABILITIES, ...options.capabilities };
    this.responses = options.responses ?? ["ok"];
    this.toolCallQueue = options.toolCalls ?? [];
    this.failWith = options.failWith;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(req);
    if (this.failWith) throw this.failWith;
    req.signal?.throwIfAborted();

    const index = Math.min(this.cursor, this.responses.length - 1);
    this.cursor += 1;
    const entry = this.responses[index] ?? "";
    const text = typeof entry === "function" ? await entry(req) : entry;

    const promptChars =
      (req.system?.length ?? 0) + req.messages.reduce((sum, m) => sum + m.content.length, 0);
    return {
      text,
      usage: estimateUsage(promptChars, text.length),
      model: this.model,
      finishReason: "stop",
    };
  }

  async completeStructured<S extends ZodType>(
    req: StructuredRequest<S>,
  ): Promise<StructuredResponse<z.infer<S>>> {
    // Even the "native" path validates the schema is expressible. A fake that
    // accepted schemas Azure would reject would let a broken schema reach
    // production having passed every test.
    const strict = toStrictJsonSchema(req.schema, req.name);
    if (!strict.ok) {
      throw providerError(
        ProviderErrorCode.Misconfigured,
        `Schema "${req.name}" cannot be expressed for structured output.`,
        PACKAGE,
        { details: { problems: strict.errors.map((e) => `${e.path || "<root>"}: ${e.message}`) } },
      );
    }

    const result = await completeStructuredViaPrompt(req, (r) => this.complete(r), PACKAGE);
    return {
      value: result.value,
      usage: result.response.usage,
      model: this.model,
      mechanism: this.capabilities.structuredOutput ? "native" : "prompt-repair",
      repairAttempts: result.repairAttempts,
    };
  }

  async completeWithTools(req: ToolRequest): Promise<ToolResponse> {
    if (!this.capabilities.toolCalling) {
      throw providerError(
        ProviderErrorCode.CapabilityUnavailable,
        "This provider does not support tool calling.",
        PACKAGE,
      );
    }
    const response = await this.complete(req);
    const index = Math.min(this.toolCursor, this.toolCallQueue.length - 1);
    this.toolCursor += 1;
    const toolCalls = this.toolCallQueue[index] ?? [];
    return {
      toolCalls,
      // Text *and* tool calls, because that is what real providers do: Anthropic
      // emits a text block beside its `tool_use` blocks, and Azure can return a
      // message item beside its `function_call` items. A fake that blanked the
      // text would hide the agent's reasoning from the trace in tests and show
      // it in production.
      text: response.text,
      usage: response.usage,
      model: this.model,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    };
  }

  async completeWithImages(req: VisionRequest): Promise<CompletionResponse> {
    // D-10: refuse BEFORE touching `req.images`, so a vision-disabled provider
    // provably never encodes or transmits an image.
    if (!this.capabilities.vision) {
      throw providerError(
        ProviderErrorCode.CapabilityUnavailable,
        "This provider is not configured for image input (AD-3 / Phase 10b).",
        PACKAGE,
      );
    }
    return this.complete(req);
  }

  async *stream(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (!this.capabilities.streaming) {
      throw providerError(
        ProviderErrorCode.CapabilityUnavailable,
        "This provider does not support streaming.",
        PACKAGE,
      );
    }
    const response = await this.complete(req);
    for (const word of response.text.split(/(?<=\s)/)) {
      req.signal?.throwIfAborted();
      yield { delta: word, done: false };
    }
    yield { delta: "", done: true };
  }

  async probeCapabilities(): Promise<LLMCapabilities> {
    return this.capabilities;
  }
}

/**
 * A fake that answers every structured request with a value you supply.
 *
 * Saves Phase 4-12 tests from hand-writing JSON that satisfies a large schema
 * just to get past the provider.
 */
export function fakeReturning(value: unknown, options: FakeProviderOptions = {}): FakeProvider {
  return new FakeProvider({ ...options, responses: [JSON.stringify(value)] });
}
