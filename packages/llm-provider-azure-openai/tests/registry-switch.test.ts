/**
 * Proves D-9's whole point: switching `SKETCHMIND_LLM_PROVIDER` swaps the
 * running provider with no code change above the registry.
 *
 * This is the one place a devDependency crosses two sibling provider packages
 * -- test-only, so `check-layering.mjs` (which reads `dependencies` and
 * `peerDependencies`, not `devDependencies`) never sees it, and it ships in
 * neither package's `dist/`. Living in `llm-provider` itself was ruled out: the
 * comment there is explicit that it must import no adapter, cycle risk aside,
 * so that a browser bundle registering nothing pulls in no provider SDK.
 */
import { describe, expect, it } from "vitest";
import { ProviderRegistry, createProviderFromEnv, PROVIDER_ENV_VAR } from "@sketchmind/llm-provider";
import { registerAzureOpenAI, AZURE_OPENAI_PROVIDER_ID } from "../src/index.js";
import { registerAnthropic, ANTHROPIC_PROVIDER_ID } from "@sketchmind/llm-provider-anthropic";

const AZURE_ENV = {
  AZURE_OPENAI_BASE_URL: "https://stub.services.ai.azure.com/openai/v1",
  AZURE_OPENAI_DEPLOYMENT: "stub-deployment",
  AZURE_OPENAI_API_KEY: "secret",
};

const ANTHROPIC_ENV = { ANTHROPIC_API_KEY: "sk-ant-secret" };

describe("provider selection (D-9)", () => {
  const registry = registerAnthropic(registerAzureOpenAI(new ProviderRegistry()));

  it("defaults to azure-openai when the env var is unset", () => {
    const provider = createProviderFromEnv(registry, AZURE_ENV);
    expect(provider.id).toBe(AZURE_OPENAI_PROVIDER_ID);
  });

  it("switches to anthropic on nothing but the env var", () => {
    const provider = createProviderFromEnv(registry, {
      ...ANTHROPIC_ENV,
      [PROVIDER_ENV_VAR]: "anthropic",
    });
    expect(provider.id).toBe(ANTHROPIC_PROVIDER_ID);
  });

  it("round-trips back to azure-openai by flipping the same variable", () => {
    const asAnthropic = createProviderFromEnv(registry, {
      ...ANTHROPIC_ENV,
      [PROVIDER_ENV_VAR]: "anthropic",
    });
    const asAzure = createProviderFromEnv(registry, {
      ...AZURE_ENV,
      [PROVIDER_ENV_VAR]: "azure-openai",
    });
    expect(asAnthropic.id).not.toBe(asAzure.id);
  });
});
