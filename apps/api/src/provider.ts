/**
 * Provider selection at the composition root.
 *
 * `llm-provider` owns the interface and the registry but imports no adapter --
 * that would be a cycle, and it would drag a vendor SDK into every consumer.
 * Registering the adapters is the app's job, and this file is the only place in
 * the server that names a provider at all. Everything past it holds an
 * `LLMProvider` and branches on capability flags.
 *
 * Both adapters are registered even though a deployment uses one. The second
 * exists precisely so the abstraction cannot quietly become Azure-shaped, and it
 * only proves that if it is reachable by changing one variable.
 */
import {
  FakeProvider,
  PROVIDER_ENV_VAR,
  ProviderRegistry,
  createProviderFromEnv,
  type LLMProvider,
} from "@sketchmind/llm-provider";
import { registerAzureOpenAI } from "@sketchmind/llm-provider-azure-openai";
import { registerAnthropic } from "@sketchmind/llm-provider-anthropic";

export function buildProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerAzureOpenAI(registry);
  registerAnthropic(registry);
  return registry;
}

/**
 * Resolve the provider this process will use.
 *
 * With no provider selected, a `FakeProvider` stands in. Tests need a server
 * they can drive without credentials, and a dev machine that has not been given
 * an Azure key should start and say so rather than crash on the first request.
 * A deployment that means to use a real model sets `SKETCHMIND_LLM_PROVIDER`,
 * and gets a loud misconfiguration error if the adapter's own variables are
 * missing -- silently falling back to a fake in production would be far worse
 * than failing to boot.
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  if (!env[PROVIDER_ENV_VAR]?.trim()) {
    return new FakeProvider({
      id: "fake",
      responses: [
        "No LLM provider is configured. Set SKETCHMIND_LLM_PROVIDER and the adapter's " +
          "variables (see .env.example) to draw something.",
      ],
    });
  }
  return createProviderFromEnv(buildProviderRegistry(), env);
}
