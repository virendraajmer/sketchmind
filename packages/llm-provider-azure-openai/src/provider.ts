/**
 * Azure OpenAI adapter, over the v1 API surface and the Responses API (AD-9).
 *
 * Three things worth knowing before reading:
 *
 * 1. It uses the stock `OpenAI` client with a `baseURL`, not `AzureOpenAI`, and
 *    sends no `api-version`. That is what Azure's v1 API is for.
 * 2. `maxRetries: 0`. Retry policy lives in `llm-provider` (D-6); leaving the
 *    SDK's own loop on would nest two, and any timeout budget above would be
 *    fiction.
 * 3. It logs request shape only, never prompt text (D-7).
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
import OpenAI from "openai";
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import type { Responses } from "openai/resources/responses/responses";
import type { ZodType, z } from "zod";
import { ENTRA_SCOPE, PACKAGE, type AzureOpenAIConfig } from "./internal/config.js";
import {
  toFinishReason,
  toInput,
  toProviderError,
  toToolCalls,
  toTools,
  toUsage,
} from "./internal/translate.js";

export interface AzureOpenAIProviderOptions {
  readonly config: AzureOpenAIConfig;
  readonly logger?: ProviderLogger;
  readonly retryPolicy?: RetryPolicy;
  /** Injected in tests so the suite exercises the adapter without a network. */
  readonly client?: OpenAI;
}

function makeClient(config: AzureOpenAIConfig): OpenAI {
  const apiKey =
    config.auth.kind === "api-key"
      ? config.auth.apiKey
      : // The v1 client refreshes the token itself when `apiKey` is a provider
        // function -- which is why `AzureOpenAI` is no longer needed for Entra.
        getBearerTokenProvider(new DefaultAzureCredential(), ENTRA_SCOPE);

  return new OpenAI({
    baseURL: config.baseURL,
    apiKey,
    maxRetries: 0,
    timeout: config.timeoutMs,
  });
}

export class AzureOpenAIProvider implements LLMProvider {
  readonly id = "azure-openai";
  readonly model: string;
  readonly capabilities: LLMCapabilities;

  private readonly client: OpenAI;
  private readonly logger: ProviderLogger;
  private readonly retryPolicy: RetryPolicy;

  constructor(options: AzureOpenAIProviderOptions) {
    this.model = options.config.deployment;
    this.capabilities = options.config.capabilities;
    this.client = options.client ?? makeClient(options.config);
    this.logger = options.logger ?? noopLogger;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  /** Shared by every call: one retry loop, one error classification, one log line. */
  private async send(
    operation: string,
    shape: ReturnType<typeof describeRequest>,
    call: () => Promise<Responses.Response>,
  ): Promise<Responses.Response> {
    const startedAt = Date.now();
    this.logger.debug(`azure-openai ${operation}`, { ...shape, model: this.model });
    try {
      const response = await withRetry(
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
            this.logger.warn("azure-openai retry", {
              operation,
              attempt,
              delayMs,
              code: error.error.code,
            }),
        },
      );
      this.logger.info(`azure-openai ${operation} ok`, {
        model: this.model,
        latencyMs: Date.now() - startedAt,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        status: response.status,
      });
      return response;
    } catch (error) {
      // The message is ours; the prompt is not in it.
      this.logger.error(`azure-openai ${operation} failed`, {
        model: this.model,
        latencyMs: Date.now() - startedAt,
        operation,
      });
      throw error;
    }
  }

  private baseParams(req: CompletionRequest): Responses.ResponseCreateParamsNonStreaming {
    return {
      model: this.model,
      input: toInput(req),
      ...(req.system ? { instructions: req.system } : {}),
      ...(req.maxOutputTokens !== undefined ? { max_output_tokens: req.maxOutputTokens } : {}),
      // Passed through only when set. Reasoning deployments reject an explicit
      // temperature, so defaulting one here would break them for no gain.
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.send("complete", describeRequest(req), () =>
      this.client.responses.create(this.baseParams(req), { signal: req.signal }),
    );
    return {
      text: response.output_text ?? "",
      usage: toUsage(response.usage),
      model: response.model,
      finishReason: toFinishReason(response),
    };
  }

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

    if (this.capabilities.structuredOutput) {
      const response = await this.send("completeStructured", describeRequest(req), () =>
        this.client.responses.create(
          {
            ...this.baseParams(req),
            text: {
              format: {
                type: "json_schema",
                name: req.name,
                schema: strict.value.schema,
                strict: true,
                ...(req.description ? { description: req.description } : {}),
              },
            },
          },
          { signal: req.signal },
        ),
      );

      const parsed = this.tryParse(req.schema, response.output_text ?? "");
      if (parsed !== undefined) {
        return {
          value: parsed,
          usage: toUsage(response.usage),
          model: response.model,
          mechanism: "native",
          repairAttempts: 0,
        };
      }
      // Strict mode is a constraint, not a guarantee -- a truncated response
      // still arrives as valid-looking text. Fall through to repair rather than
      // failing a run over one bad generation.
      this.logger.warn("azure-openai native structured output did not validate; repairing", {
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

  private tryParse<S extends ZodType>(schema: S, text: string): z.infer<S> | undefined {
    try {
      const result = schema.safeParse(decodeStrictOutput(JSON.parse(text)));
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  async completeWithTools(req: ToolRequest): Promise<ToolResponse> {
    if (!this.capabilities.toolCalling) {
      throw providerError(
        ProviderErrorCode.CapabilityUnavailable,
        "This deployment is not configured for tool calling.",
        PACKAGE,
      );
    }

    const response = await this.send("completeWithTools", describeRequest(req), () =>
      this.client.responses.create(
        {
          ...this.baseParams(req),
          tools: toTools(req.tools),
          ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
          ...(this.capabilities.parallelToolCalls && req.allowParallelCalls !== undefined
            ? { parallel_tool_calls: req.allowParallelCalls }
            : {}),
        },
        { signal: req.signal },
      ),
    );

    return {
      toolCalls: toToolCalls(response),
      text: response.output_text ?? "",
      usage: toUsage(response.usage),
      model: response.model,
      finishReason: toFinishReason(response),
    };
  }

  async completeWithImages(req: VisionRequest): Promise<CompletionResponse> {
    // D-10: refuse BEFORE reading `req.images`. The standing directive is that
    // no image is encoded or transmitted while vision is off, and returning an
    // error after building the payload would not honour it.
    if (!this.capabilities.vision) {
      throw providerError(
        ProviderErrorCode.CapabilityUnavailable,
        "Image input is disabled. Set AZURE_OPENAI_VISION_DEPLOYMENT to enable the visual " +
          "self-correction tier (AD-3 / Phase 10b).",
        PACKAGE,
      );
    }

    const content: Responses.ResponseInputMessageContentList = [
      ...req.messages.map((message) => ({ type: "input_text" as const, text: message.content })),
      ...req.images.map((image) => ({
        type: "input_image" as const,
        image_url: `data:${image.mimeType};base64,${image.base64}`,
        detail: "auto" as const,
      })),
    ];

    const response = await this.send("completeWithImages", describeRequest(req), () =>
      this.client.responses.create(
        {
          model: this.model,
          input: [{ role: "user", content }],
          ...(req.system ? { instructions: req.system } : {}),
          ...(req.maxOutputTokens !== undefined ? { max_output_tokens: req.maxOutputTokens } : {}),
        },
        { signal: req.signal },
      ),
    );

    return {
      text: response.output_text ?? "",
      usage: toUsage(response.usage),
      model: response.model,
      finishReason: toFinishReason(response),
    };
  }

  async *stream(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (!this.capabilities.streaming) {
      throw providerError(
        ProviderErrorCode.CapabilityUnavailable,
        "This deployment is not configured for streaming.",
        PACKAGE,
      );
    }

    this.logger.debug("azure-openai stream", { ...describeRequest(req), model: this.model });
    try {
      const events = await this.client.responses.create(
        { ...this.baseParams(req), stream: true },
        { signal: req.signal },
      );
      for await (const event of events) {
        if (event.type === "response.output_text.delta") {
          yield { delta: event.delta, done: false };
        }
      }
      yield { delta: "", done: true };
    } catch (cause) {
      // Streams are not retried: partial output has already been handed to the
      // caller, and replaying from the start would duplicate it.
      throw toProviderError(cause, PACKAGE);
    }
  }

  /**
   * Verify declared capabilities against the live deployment (D-5).
   *
   * Two real calls, deliberately tiny. This is what answers "does this model
   * support strict structured output?" for a deployment nobody has run before,
   * instead of us guessing from its name.
   */
  async probeCapabilities(): Promise<LLMCapabilities> {
    const probeSchema: Record<string, unknown> = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    };

    const structuredOutput = await this.attempt(() =>
      this.client.responses.create({
        model: this.model,
        input: [{ role: "user", content: "Reply with ok = true." }],
        max_output_tokens: 2048,
        text: { format: { type: "json_schema", name: "probe", schema: probeSchema, strict: true } },
      }),
    );

    const toolCalling = await this.attempt(() =>
      this.client.responses.create({
        model: this.model,
        input: [{ role: "user", content: "Call the ping tool." }],
        max_output_tokens: 2048,
        tools: [
          {
            type: "function",
            name: "ping",
            description: "Respond to a liveness check.",
            parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
            strict: false,
          },
        ],
      }),
    );

    return { ...this.capabilities, structuredOutput, toolCalling };
  }

  private async attempt(call: () => Promise<unknown>): Promise<boolean> {
    try {
      await call();
      return true;
    } catch {
      return false;
    }
  }
}
