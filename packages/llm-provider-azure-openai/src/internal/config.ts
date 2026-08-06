/**
 * Configuration for the Azure v1 API surface (AD-9).
 *
 * There is no `api-version` here and that is not an omission. Azure's v1 API,
 * GA since August 2025, dropped it -- which is also why this adapter uses the
 * stock `OpenAI` client rather than `AzureOpenAI`. A variable that must be left
 * empty is a variable someone eventually fills in wrongly, so it is gone.
 */
import {
  ProviderErrorCode,
  providerError,
  type LLMCapabilities,
  type ProviderEnv,
  type ProviderOptions,
} from "@sketchmind/llm-provider";

export const PACKAGE = "@sketchmind/llm-provider-azure-openai";

/** The scope Azure requires for Entra-authenticated Foundry calls. */
export const ENTRA_SCOPE = "https://ai.azure.com/.default";

export type AzureAuth =
  | { readonly kind: "api-key"; readonly apiKey: string }
  | { readonly kind: "entra" };

export interface AzureOpenAIConfig {
  /** Fully-qualified v1 base URL, ending in `/openai/v1`. */
  readonly baseURL: string;
  /** The deployment name, which the v1 API takes as `model`. */
  readonly deployment: string;
  readonly auth: AzureAuth;
  readonly capabilities: LLMCapabilities;
  readonly timeoutMs: number;
}

/**
 * Both spellings Azure accepts, plus the bare resource endpoint people paste
 * from the portal. Normalising here rather than documenting it means the
 * common mistake simply works.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return trimmed;
  if (/\/openai\/v1$/i.test(trimmed)) return trimmed;
  if (/\/openai$/i.test(trimmed)) return `${trimmed}/v1`;
  return `${trimmed}/openai/v1`;
}

function misconfigured(message: string): never {
  throw providerError(ProviderErrorCode.Misconfigured, message, PACKAGE);
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
 * Declared capabilities, not inferred ones (D-5).
 *
 * The defaults assume a current deployment. `probeCapabilities()` checks them
 * against the live endpoint. What we deliberately do NOT do is key capabilities
 * off the model name -- that builds a model catalogue into our source, and it
 * is stale the week after it is written.
 *
 * `vision` is false by default: the agent works on JSON only until Phase 10b is
 * deliberately switched on.
 *
 * A deployment is vision-capable when it *is* the vision deployment. A role
 * that selected it explicitly (via `options.model`) gets a truthful flag; the
 * text role, pointed at a text deployment, still reports false even though
 * `AZURE_OPENAI_VISION_DEPLOYMENT` is set for the vision role elsewhere.
 */
export function capabilitiesFromEnv(env: ProviderEnv, options?: ProviderOptions): LLMCapabilities {
  const visionDeployment = env["AZURE_OPENAI_VISION_DEPLOYMENT"]?.trim() ?? "";
  const effectiveDeployment = options?.model?.trim() || env["AZURE_OPENAI_DEPLOYMENT"]?.trim() || "";
  return {
    structuredOutput: readBoolean(env["AZURE_OPENAI_STRUCTURED_OUTPUT"], true),
    toolCalling: readBoolean(env["AZURE_OPENAI_TOOL_CALLING"], true),
    parallelToolCalls: readBoolean(env["AZURE_OPENAI_PARALLEL_TOOL_CALLS"], true),
    streaming: readBoolean(env["AZURE_OPENAI_STREAMING"], true),
    vision: visionDeployment !== "" && effectiveDeployment === visionDeployment,
    maxContextTokens: readNumber(env["AZURE_OPENAI_MAX_CONTEXT_TOKENS"], 128_000),
  };
}

export function configFromEnv(env: ProviderEnv, options?: ProviderOptions): AzureOpenAIConfig {
  const rawBaseUrl = env["AZURE_OPENAI_BASE_URL"]?.trim() ?? "";
  if (rawBaseUrl === "") {
    misconfigured(
      "AZURE_OPENAI_BASE_URL is required, e.g. " +
        "https://<resource>.services.ai.azure.com/openai/v1",
    );
  }

  const baseURL = normalizeBaseUrl(rawBaseUrl);
  try {
    new URL(baseURL);
  } catch {
    misconfigured(`AZURE_OPENAI_BASE_URL is not a valid URL: ${rawBaseUrl}`);
  }

  const deployment = options?.model?.trim() || env["AZURE_OPENAI_DEPLOYMENT"]?.trim() || "";
  if (deployment === "") {
    misconfigured("AZURE_OPENAI_DEPLOYMENT is required -- the name you gave the deployment.");
  }

  const apiKey = env["AZURE_OPENAI_API_KEY"]?.trim() ?? "";
  const useEntra = readBoolean(env["AZURE_OPENAI_USE_ENTRA_ID"], false);

  if (useEntra && apiKey !== "") {
    // Ambiguous credentials are worse than missing ones: whichever we picked,
    // the operator would believe the other was in use.
    misconfigured(
      "Set either AZURE_OPENAI_API_KEY or AZURE_OPENAI_USE_ENTRA_ID=true, not both.",
    );
  }
  if (!useEntra && apiKey === "") {
    misconfigured(
      "No Azure credential. Set AZURE_OPENAI_API_KEY, or AZURE_OPENAI_USE_ENTRA_ID=true " +
        "to use DefaultAzureCredential (needs the Cognitive Services OpenAI User role).",
    );
  }

  return {
    baseURL,
    deployment,
    auth: useEntra ? { kind: "entra" } : { kind: "api-key", apiKey },
    capabilities: capabilitiesFromEnv(env, options),
    timeoutMs: readNumber(env["AZURE_OPENAI_TIMEOUT_MS"], 120_000),
  };
}
