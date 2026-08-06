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
import type { VisionMode } from "./config.js";

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

export type ProviderRole = "text" | "vision";

/**
 * Resolve one model role.
 *
 * The two roles are fully independent: either may name any registered provider
 * and any model, and they need not agree on either. Setting neither leaves both
 * on `SKETCHMIND_LLM_PROVIDER`, which is the common case -- one model doing both
 * jobs -- and costs no configuration at all.
 *
 * Either role returns `undefined` rather than an unusable provider when the
 * resolved model lacks the one capability that role exists to use -- `vision`
 * for the vision role, `toolCalling` for the text role (design spec, "Provider
 * independence": *"the `vision` role's only requirement is that whatever it
 * resolves to reports `capabilities.vision`; the `text` role's only requirement
 * is `capabilities.toolCalling`"*). That is what makes the visual tier *inert*
 * when misconfigured instead of failing on the first upload, and what makes an
 * unusable text role fall back to `resolveProvider`'s explanatory fake instead
 * of throwing on the session's first model turn. Both are read from
 * `capabilities`, never from a provider id.
 */
export function resolveRoleProvider(
  role: ProviderRole,
  env: NodeJS.ProcessEnv = process.env,
): LLMProvider | undefined {
  const prefix = role === "vision" ? "SKETCHMIND_VISION" : "SKETCHMIND_TEXT";
  const id = env[`${prefix}_PROVIDER`]?.trim() || env[PROVIDER_ENV_VAR]?.trim();
  if (!id) return undefined;

  const model = env[`${prefix}_MODEL`]?.trim();

  let provider: LLMProvider;
  try {
    provider = buildProviderRegistry().create(id, env, model ? { model } : {});
  } catch {
    // An unknown id or missing adapter variables leave the role unresolved. The
    // text role's absence is already handled by `resolveProvider`'s fake; the
    // vision role's absence simply keeps the tier inert.
    return undefined;
  }

  if (role === "vision" && !provider.capabilities.vision) return undefined;
  if (role === "text" && !provider.capabilities.toolCalling) return undefined;
  return provider;
}

/**
 * The provider the session agent runs on.
 *
 * This is the seam the composition root actually calls, and it exists so the
 * `text` role is not documented-but-dead: `SKETCHMIND_TEXT_PROVIDER` /
 * `SKETCHMIND_TEXT_MODEL` steer the session, and `resolveProvider` remains the
 * fallback for the (common) case where only `SKETCHMIND_LLM_PROVIDER` is set,
 * as well as the source of the explanatory `FakeProvider` when nothing is
 * configured at all.
 */
export function resolveSessionProvider(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  return resolveRoleProvider("text", env) ?? resolveProvider(env);
}

/**
 * The tier-2 gate, in one place.
 *
 * The design spec writes it as four terms:
 *
 * ```
 * mode !== "off" && visionProvider resolved
 *   && renderer.capabilities.captureImage && renderer.capabilities.raster
 * ```
 *
 * Only the first two are implementable today: `renderer-core`'s capability
 * interface has no `captureImage` or `raster` flags yet, and adding them is a
 * renderer-layer change outside Phase 10's diff. They are **not** silently
 * dropped -- they are a tracked follow-up, and when they land they belong here,
 * as extra terms on this expression, not as a fourth copy of the gate at a
 * fourth call site.
 *
 * `capabilities.vision` is re-checked rather than assumed: `resolveRoleProvider`
 * already guarantees it for anything it returns (so this changes nothing at the
 * composition root), but it makes the gate total for any caller -- including a
 * test -- that hands over a provider it resolved some other way.
 */
export function isVisualCritiqueEnabled(
  mode: VisionMode,
  visionProvider: LLMProvider | undefined,
): boolean {
  return mode !== "off" && visionProvider !== undefined && visionProvider.capabilities.vision;
}
