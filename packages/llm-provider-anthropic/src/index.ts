/**
 * @sketchmind/llm-provider-anthropic
 *
 * The second provider, and the reason the first one can be trusted. A single
 * adapter would let an Azure-shaped interface pass as a generic one; this
 * package is what forces `llm-provider` to mean something both vendors can say.
 *
 * It reaches structured output by a different mechanism entirely (forced tool
 * call, not a native `response_format`) behind an identical signature, and it
 * passes the same contract suite with no changes to the test code (D-8).
 *
 * Nothing above the provider layer imports this package. The composition root
 * calls `registerAnthropic`; everything else takes an `LLMProvider`.
 */
import type { ProviderEnv, ProviderRegistry } from "@sketchmind/llm-provider";
import { configFromEnv } from "./internal/config.js";
import { AnthropicProvider } from "./provider.js";

export const PACKAGE_NAME = "@sketchmind/llm-provider-anthropic";
export const PACKAGE_VERSION = "0.0.1";

export const ANTHROPIC_PROVIDER_ID = "anthropic";

export { AnthropicProvider, type AnthropicProviderOptions } from "./provider.js";
export {
  DEFAULT_MODEL,
  capabilitiesFromEnv,
  configFromEnv,
  type AnthropicConfig,
} from "./internal/config.js";

export function createAnthropicProvider(env: ProviderEnv): AnthropicProvider {
  return new AnthropicProvider({ config: configFromEnv(env) });
}

/** Call this at the composition root to make `anthropic` selectable. */
export function registerAnthropic(registry: ProviderRegistry): ProviderRegistry {
  return registry.register(ANTHROPIC_PROVIDER_ID, createAnthropicProvider);
}
