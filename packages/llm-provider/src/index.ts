/**
 * @sketchmind/llm-provider
 *
 * The provider-independent model interface, plus everything that must behave
 * identically no matter which model is behind it: error classification, retry
 * policy, strict-mode schema generation, and the structured-output fallback.
 *
 * **This package imports no provider SDK, and never will.** That is what makes
 * LLM independence mechanical rather than aspirational -- lint forbids provider
 * SDKs outside `packages/llm-provider-*`, and nothing above this layer imports
 * those packages either (selection goes through `ProviderRegistry`).
 *
 * The contract suite lives at `@sketchmind/llm-provider/testing`.
 */

export const PACKAGE_NAME = "@sketchmind/llm-provider";
export const PACKAGE_VERSION = "0.0.1";

export * from "./types.js";
export * from "./fake.js";
export * from "./registry.js";
export * from "./structured-result.js";
export * from "./logging.js";

export {
  ProviderErrorCode,
  classifyFailure,
  providerError,
  parseRetryAfterMs,
  type TransportFailure,
} from "./internal/errors.js";

export {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  withRetry,
  type RetryHooks,
  type RetryPolicy,
} from "./internal/retry.js";

export {
  decodeStrictOutput,
  toStrictJsonSchema,
  type StrictSchema,
} from "./internal/json-schema.js";

export {
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  completeStructuredViaPrompt,
  extractJson,
  type PromptStructuredResult,
} from "./internal/structured.js";
