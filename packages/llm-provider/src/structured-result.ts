/**
 * `completeStructured`, restated as a `ValidationResult` (AD-2).
 *
 * `LLMProvider.completeStructured` throws, and that is right for the interface:
 * a provider that cannot answer is a transport failure, not model output. But
 * every Phase 5 reasoning stage wants the *other* framing -- "the model produced
 * something that did not validate" is an observation the agent fixes on its next
 * step, and four packages writing the same try/catch would be four chances to
 * classify it differently.
 *
 * So the split lives here, once:
 *
 *  - `SketchMindError.recoverable === true`  -> `ValidationResult` failure. The
 *    model wrote bad JSON, or wrote none, or blew the repair budget. The agent
 *    reads the errors and tries again with better instructions.
 *  - `recoverable === false`                 -> rethrown. Bad credentials, a
 *    deployment that does not exist, a schema no provider can express. No amount
 *    of agent reasoning fixes any of those, and swallowing them into a tool
 *    result would make a misconfigured server look like a confused model.
 *
 * It lives in `llm-provider` rather than in a reasoning package because it is
 * part of "everything that must behave identically no matter which model is
 * behind it", and it imports no provider SDK.
 */
import {
  fail,
  makeError,
  ok,
  type ErrorOrigin,
  type ValidationResult,
} from "@sketchmind/shared-types";
import type { ZodType, z } from "zod";
import { LLMProviderError, type LLMProvider, type StructuredRequest } from "./types.js";

export interface StructuredOutcome<T> {
  readonly result: ValidationResult<T>;
  /** Present whenever a call completed, so callers can attribute token cost. */
  readonly usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Which mechanism produced the value. Observability only. */
  readonly mechanism?: string;
}

/**
 * Ask a provider for a schema-shaped value, returning structured errors rather
 * than throwing when the *model* is at fault.
 *
 * `origin` attributes any failure to the stage that asked, so the agent's trace
 * says "visual-planner could not produce a plan" rather than naming the provider
 * package the error happened to surface from.
 */
export async function requestStructured<S extends ZodType>(
  provider: LLMProvider,
  request: StructuredRequest<S>,
  origin: ErrorOrigin,
): Promise<StructuredOutcome<z.infer<S>>> {
  try {
    const response = await provider.completeStructured(request);
    return { result: ok(response.value), usage: response.usage, mechanism: response.mechanism };
  } catch (cause) {
    if (cause instanceof LLMProviderError && cause.error.recoverable) {
      // Re-attribute, but keep the provider's code and details: "the model
      // produced no JSON after 3 attempts" is the actionable part, and losing it
      // would leave the agent guessing at what to change.
      return {
        result: fail([
          makeError({
            ...cause.error,
            package: origin.package,
            stage: origin.stage,
            details: { ...cause.error.details, providerPackage: cause.error.package },
          }),
        ]),
      };
    }
    throw cause;
  }
}
