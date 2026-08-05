/**
 * Provider selection (D-9).
 *
 * `llm-provider` cannot import `llm-provider-azure-openai` -- that is a cycle,
 * and it would drag the Azure SDK into every consumer of the interface. So this
 * package owns a registry, each adapter exports a `register*` function, and the
 * composition root registers whichever adapters that deployment actually wants.
 *
 * That is what makes "switching providers is one env var" true without anything
 * importing a provider it does not use. A browser bundle registers nothing and
 * therefore contains no SDK at all -- which is the same constraint the lint rule
 * enforces, arrived at from the other direction.
 */
import { ProviderErrorCode, providerError } from "./internal/errors.js";
import type { LLMProvider } from "./types.js";

const PACKAGE = "@sketchmind/llm-provider";

/** Adapters receive the raw environment rather than reading `process.env`. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

export type ProviderFactory = (env: ProviderEnv) => LLMProvider;

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  register(id: string, factory: ProviderFactory): this {
    this.factories.set(id, factory);
    return this;
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  ids(): string[] {
    return [...this.factories.keys()].sort();
  }

  create(id: string, env: ProviderEnv): LLMProvider {
    const factory = this.factories.get(id);
    if (!factory) {
      throw providerError(
        ProviderErrorCode.Misconfigured,
        `Unknown LLM provider "${id}". Registered: ${this.ids().join(", ") || "<none>"}. ` +
          `Register the adapter at the composition root before selecting it.`,
        PACKAGE,
      );
    }
    return factory(env);
  }
}

export const PROVIDER_ENV_VAR = "SKETCHMIND_LLM_PROVIDER";
export const DEFAULT_PROVIDER_ID = "azure-openai";

/**
 * The one function that reads the provider choice. Everything above this layer
 * takes an `LLMProvider` as a constructor argument and never asks which one.
 */
export function createProviderFromEnv(
  registry: ProviderRegistry,
  env: ProviderEnv = process.env,
): LLMProvider {
  const id = env[PROVIDER_ENV_VAR]?.trim() || DEFAULT_PROVIDER_ID;
  return registry.create(id, env);
}
