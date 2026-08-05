/**
 * Anthropic adapter, over the Messages API.
 *
 * Its reason for existing is D-3: three mechanisms behind one signature. Azure
 * reaches structured output natively; Anthropic has no `response_format`, so
 * this adapter forces a tool call whose input schema *is* the requested schema,
 * and returns the tool's arguments as the value. Callers see the same
 * `StructuredResponse`, differing only in `mechanism` -- which is observability,
 * not control flow.
 *
 * As in the Azure adapter: `maxRetries: 0` (retry policy lives in
 * `llm-provider`, D-6) and request shape is logged, never prompt text (D-7).
 */
import {
  DEFAULT_RETRY_POLICY,
  ProviderErrorCode,
  completeStructuredViaPrompt,
  decodeStrictOutput,
  describeRequest,
  noopLogger,
  providerError,
  toStrictJsonSchema,
  withRetry,
  type CompletionChunk,
  type CompletionRequest,
  type CompletionResponse,
  type LLMCapabilities,
  type LLMProvider,
  type ProviderLogger,
  type RetryPolicy,
  type StructuredRequest,
  type StructuredResponse,
  type ToolRequest,
  type ToolResponse,
  type VisionRequest,
} from "@sketchmind/llm-provider";
import Anthropic from "@anthropic-ai/sdk";
import type {
  Base64ImageSource,
  ImageBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { ZodType, z } from "zod";
import { PACKAGE, type AnthropicConfig } from "./internal/config.js";
import {
  toFinishReason,
  toMessages,
  toProviderError,
  toText,
  toToolCalls,
  toToolChoice,
  toTools,
  toUsage,
} from "./internal/translate.js";

export interface AnthropicProviderOptions {
  readonly config: AnthropicConfig;
  readonly logger?: ProviderLogger;
  readonly retryPolicy?: RetryPolicy;
  /** Injected in tests so the suite runs without a network or credentials. */
  readonly client?: Anthropic;
}

export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  readonly model: string;
  readonly capabilities: LLMCapabilities;

  private readonly client: Anthropic;
  private readonly logger: ProviderLogger;
  private readonly retryPolicy: RetryPolicy;
  private readonly defaultMaxOutputTokens: number;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.config.model;
    this.capabilities = options.config.capabilities;
    this.defaultMaxOutputTokens = options.config.defaultMaxOutputTokens;
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.config.apiKey,
        ...(options.config.baseURL ? { baseURL: options.config.baseURL } : {}),
        maxRetries: 0,
        timeout: options.config.timeoutMs,
      });
    this.logger = options.logger ?? noopLogger;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  /** Shared by every call: one retry loop, one error classification, one log line. */
  private async send(
    operation: string,
    shape: ReturnType<typeof describeRequest>,
    call: () => Promise<Message>,
  ): Promise<Message> {
    const startedAt = Date.now();
    this.logger.debug(`anthropic ${operation}`, { ...shape, model: this.model });
    try {
      const message = await withRetry(
        async () => {
          try {
            return await call();
          } catch (cause) {
            throw toProviderError(cause, PACKAGE);
          }
        },
        this.retryPolicy,
        {
          onRetry: (attempt, delayMs, error) =>
            this.logger.warn("anthropic retry", {
              operation,
              attempt,
              delayMs,
              code: error.error.code,
            }),
        },
      );
      this.logger.info(`anthropic ${operation} ok`, {
        model: this.model,
        latencyMs: Date.now() - startedAt,
        inputTokens: message.usage?.input_tokens,
        outputTokens: message.usage?.output_tokens,
        stopReason: message.stop_reason ?? undefined,
      });
      return message;
    } catch (error) {
      this.logger.error(`anthropic ${operation} failed`, {
        model: this.model,
        latencyMs: Date.now() - startedAt,
        operation,
      });
      throw error;
    }
  }

  private baseParams(req: CompletionRequest): MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      // Unlike Azure, `max_tokens` is mandatory. The config default exists so an
      // optional field in our interface stays optional for every provider.
      max_tokens: req.maxOutputTokens ?? this.defaultMaxOutputTokens,
      messages: toMessages(req),
      ...(req.system ? { system: req.system } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.stop && req.stop.length > 0 ? { stop_sequences: [...req.stop] } : {}),
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const message = await this.send("complete", describeRequest(req), () =>
      this.client.messages.create(this.baseParams(req), { signal: req.signal }),
    );
    return {
      text: toText(message),
      usage: toUsage(message.usage),
      model: message.model,
      finishReason: toFinishReason(message),
    };
  }

  /**
   * Structured output by forced tool call.
   *
   * The schema goes in as a tool's `input_schema` and `tool_choice` names that
   * tool, so the model has no path that does not produce a conforming object.
   * We still validate what comes back: a constraint the provider enforces is
   * not the same as one we have checked.
   */
  async completeStructured<S extends ZodType>(
    req: StructuredRequest<S>,
  ): Promise<StructuredResponse<z.infer<S>>> {
    const strict = toStrictJsonSchema(req.schema, req.name);
    if (!strict.ok) {
      throw providerError(
        ProviderErrorCode.Misconfigured,
        `Schema "${req.name}" cannot be expressed for structured output.`,
        PACKAGE,
        { details: { problems: strict.errors.map((e) => `${e.path || "<root>"}: ${e.message}`) } },
      );
    }

    if (this.capabilities.toolCalling) {
      const message = await this.send("completeStructured", describeRequest(req), () =>
        this.client.messages.create(
          {
            ...this.baseParams(req),
            tools: [
              {
                name: req.name,
                description:
                  req.description ?? `Return the result as ${req.name}. Call this tool exactly once.`,
                input_schema: strict.value.schema as { type: "object" },
              },
            ],
            tool_choice: { type: "tool", name: req.name },
          },
          { signal: req.signal },
        ),
      );

      const call = toToolCalls(message).find((candidate) => candidate.name === req.name);
      if (call) {
        const parsed = req.schema.safeParse(decodeStrictOutput(call.arguments));
        if (parsed.success) {
          return {
            value: parsed.data as z.infer<S>,
            usage: toUsage(message.usage),
            model: message.model,
            mechanism: "forced-tool",
            repairAttempts: 0,
          };
        }
      }
      // A forced tool call still lands wrong occasionally -- most often
      // truncated by `max_tokens`. Repair rather than failing the run.
      this.logger.warn("anthropic forced tool call did not validate; repairing", {
        model: this.model,
        name: req.name,
      });
    }

    const result = await completeStructuredViaPrompt(req, (r) => this.complete(r), PACKAGE);
    return {
      value: result.value,
      usage: result.response.usage,
      model: result.response.model,
      mechanism: "prompt-repair",
      repairAttempts: result.repairAttempts,
    };
  }

  async completeWithTools(req: ToolRequest): Promise<ToolResponse> {
    if (!this.capabilities.toolCalling) {
      throw providerError(
        ProviderErrorCode.CapabilityUnavailable,
        "This model is not configured for tool calling.",
        PACKAGE,
      );
    }

    const toolChoice = toToolChoice(
      req.toolChoice,
      this.capabilities.parallelToolCalls ? req.allowParallelCalls : false,
    );

    const message = await this.send("completeWithTools", describeRequest(req), () =>
      this.client.messages.create(
        {
          ...this.baseParams(req),
          tools: toTools(req.tools),
          ...(toolChoice ? { tool_choice: toolChoice } : {}),
        },
        { signal: req.signal },
      ),
    );

    return {
      toolCalls: toToolCalls(message),
      text: toText(message),
      usage: toUsage(message.usage),
      model: message.model,
      finishReason: toFinishReason(message),
    };
  }

  async completeWithImages(req: VisionRequest): Promise<CompletionResponse> {
    // D-10, same as Azure: refuse BEFORE reading `req.images`, so that "no image
    // is encoded or transmitted" is a property of the code and not a promise.
    if (!this.capabilities.vision) {
      throw providerError(
        ProviderErrorCode.CapabilityUnavailable,
        "Image input is disabled. Set ANTHROPIC_VISION=true to enable the visual " +
          "self-correction tier (AD-3 / Phase 10b).",
        PACKAGE,
      );
    }

    const content: (TextBlockParam | ImageBlockParam)[] = [
      ...req.messages.map((m) => ({ type: "text" as const, text: m.content })),
      ...req.images.map((image) => ({
        type: "image" as const,
        // Anthropic narrows `media_type` to four literals. Our `ImageInput`
        // cannot: it is provider-independent, and Azure accepts more. The cast
        // is where that difference is absorbed -- an unsupported type is
        // rejected by the API with a legible error rather than by our types
        // with a compile failure in an unrelated package.
        source: {
          type: "base64" as const,
          media_type: image.mimeType as Base64ImageSource["media_type"],
          data: image.base64,
        },
      })),
    ];

    const message = await this.send("completeWithImages", describeRequest(req), () =>
      this.client.messages.create(
        {
          model: this.model,
          max_tokens: req.maxOutputTokens ?? this.defaultMaxOutputTokens,
          messages: [{ role: "user", content }],
          ...(req.system ? { system: req.system } : {}),
        },
        { signal: req.signal },
      ),
    );

    return {
      text: toText(message),
      usage: toUsage(message.usage),
      model: message.model,
      finishReason: toFinishReason(message),
    };
  }

  async *stream(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (!this.capabilities.streaming) {
      throw providerError(
        ProviderErrorCode.CapabilityUnavailable,
        "This model is not configured for streaming.",
        PACKAGE,
      );
    }

    this.logger.debug("anthropic stream", { ...describeRequest(req), model: this.model });
    try {
      const events = await this.client.messages.create(
        { ...this.baseParams(req), stream: true },
        { signal: req.signal },
      );
      for await (const event of events) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { delta: event.delta.text, done: false };
        }
      }
      yield { delta: "", done: true };
    } catch (cause) {
      // Not retried: partial output is already with the caller, and replaying
      // from the start would duplicate it.
      throw toProviderError(cause, PACKAGE);
    }
  }
}
