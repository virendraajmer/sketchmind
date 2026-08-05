/**
 * @sketchmind/llm-provider-azure-openai
 *
 * Azure OpenAI / AI Foundry adapter -- the only place Azure types exist. Lint
 * forbids `openai` and `@azure/*` imports anywhere outside `llm-provider-*`,
 * which is what turns "any LLM, swappable anytime" into a guarantee rather than
 * an intention.
 *
 * Targets Azure's v1 API surface: no `api-version`, stock `OpenAI` client, and
 * the Responses API (AD-9).
 *
 * Nothing above the provider layer imports this package. The composition root
 * calls `registerAzureOpenAI` and everything else takes an `LLMProvider`.
 */
import type { ProviderEnv, ProviderRegistry } from "@sketchmind/llm-provider";
import { configFromEnv } from "./internal/config.js";
import { AzureOpenAIProvider } from "./provider.js";

export const PACKAGE_NAME = "@sketchmind/llm-provider-azure-openai";
export const PACKAGE_VERSION = "0.0.1";

export const AZURE_OPENAI_PROVIDER_ID = "azure-openai";

export { AzureOpenAIProvider, type AzureOpenAIProviderOptions } from "./provider.js";
export {
  ENTRA_SCOPE,
  capabilitiesFromEnv,
  configFromEnv,
  normalizeBaseUrl,
  type AzureAuth,
  type AzureOpenAIConfig,
} from "./internal/config.js";

export function createAzureOpenAIProvider(env: ProviderEnv): AzureOpenAIProvider {
  return new AzureOpenAIProvider({ config: configFromEnv(env) });
}

/** Call this at the composition root to make `azure-openai` selectable. */
export function registerAzureOpenAI(registry: ProviderRegistry): ProviderRegistry {
  return registry.register(AZURE_OPENAI_PROVIDER_ID, createAzureOpenAIProvider);
}
