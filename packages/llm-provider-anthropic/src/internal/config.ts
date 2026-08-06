/**
 * Configuration for the Anthropic Messages API.
 *
 * Deliberately shaped nothing like Azure's: no deployment, no resource URL, no
 * Entra path, and one variable Azure has no equivalent for --
 * `ANTHROPIC_MAX_OUTPUT_TOKENS`. The Messages API requires `max_tokens` on every
 * request, while `CompletionRequest.maxOutputTokens` is optional (because Azure
 * does not require it). Somebody has to supply the default; the adapter is the
 * right place, and the interface stays honest about what both providers can say.
 */
import {
  ProviderErrorCode,
  providerError,
  type LLMCapabilities,
  type ProviderEnv,
  type ProviderOptions,
} from "@sketchmind/llm-provider";

export const PACKAGE = "@sketchmind/llm-provider-anthropic";

/** What Anthropic's own docs use when no model is named. */
export const DEFAULT_MODEL = "claude-sonnet-4-5";

export interface AnthropicConfig {
  readonly apiKey: string;
  readonly model: string;
  /** Only set when talking to a gateway or proxy; the SDK's default otherwise. */
  readonly baseURL?: string;
  readonly capabilities: LLMCapabilities;
  readonly timeoutMs: number;
  /** Used when a request does not name its own budget. See the file header. */
  readonly defaultMaxOutputTokens: number;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function readNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Declared, not inferred (D-5).
 *
 * `structuredOutput` is false and that is not a limitation being admitted -- the
 * Messages API has no `response_format`, so this adapter reaches strict output
 * through a forced tool call instead. The flag means "native schema mode
 * exists", and here it does not; `completeStructured` still returns a validated
 * value, via `mechanism: "forced-tool"`.
 */
export function capabilitiesFromEnv(env: ProviderEnv): LLMCapabilities {
  return {
    structuredOutput: false,
    toolCalling: readBoolean(env["ANTHROPIC_TOOL_CALLING"], true),
    parallelToolCalls: readBoolean(env["ANTHROPIC_PARALLEL_TOOL_CALLS"], true),
    streaming: readBoolean(env["ANTHROPIC_STREAMING"], true),
    // Same standing directive as Azure: JSON only until Phase 10b is switched on.
    vision: readBoolean(env["ANTHROPIC_VISION"], false),
    maxContextTokens: readNumber(env["ANTHROPIC_MAX_CONTEXT_TOKENS"], 200_000),
  };
}

export function configFromEnv(env: ProviderEnv, options?: ProviderOptions): AnthropicConfig {
  const apiKey = env["ANTHROPIC_API_KEY"]?.trim() ?? "";
  if (apiKey === "") {
    throw providerError(
      ProviderErrorCode.Misconfigured,
      "ANTHROPIC_API_KEY is required to use the anthropic provider.",
      PACKAGE,
    );
  }

  const baseURL = env["ANTHROPIC_BASE_URL"]?.trim() ?? "";
  if (baseURL !== "") {
    try {
      new URL(baseURL);
    } catch {
      throw providerError(
        ProviderErrorCode.Misconfigured,
        `ANTHROPIC_BASE_URL is not a valid URL: ${baseURL}`,
        PACKAGE,
      );
    }
  }

  return {
    apiKey,
    model: options?.model?.trim() || env["ANTHROPIC_MODEL"]?.trim() || DEFAULT_MODEL,
    ...(baseURL === "" ? {} : { baseURL }),
    capabilities: capabilitiesFromEnv(env),
    timeoutMs: readNumber(env["ANTHROPIC_TIMEOUT_MS"], 120_000),
    defaultMaxOutputTokens: readNumber(env["ANTHROPIC_MAX_OUTPUT_TOKENS"], 8_192),
  };
}
