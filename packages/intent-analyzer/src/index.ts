/**
 * @sketchmind/intent-analyzer
 *
 * Natural language to `IntentModel` (V03 §Intent Analyzer, V15 §Agent Contracts).
 *
 * The first reasoning stage, and the smallest. It answers four questions -- what
 * is this, what field, what kind of diagram, how involved -- and stops. It does
 * not decide what to draw; that is `visual-planner`, and keeping the two apart is
 * what lets AD-1's agent skip either one independently.
 *
 * Per AD-2 nothing here throws on account of the model. A response that will not
 * validate comes back as a `ValidationResult` failure the agent can read and act
 * on. Only a provider that cannot answer at all propagates.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */
import {
  IntentModelSchema,
  SCHEMA_VERSION,
  ok,
  renderPromptTemplate,
  type IntentModel,
  type Metadata,
  type ValidationResult,
} from "@sketchmind/shared-types";
import { requestStructured, type LLMProvider } from "@sketchmind/llm-provider";
import { INTENT_PROMPT } from "./internal/prompt.js";

export const PACKAGE_NAME = "@sketchmind/intent-analyzer";
export const PACKAGE_VERSION = "0.0.1";

export { INTENT_PROMPT };

const origin = { package: PACKAGE_NAME, stage: "intent" } as const;

/**
 * What the model is actually asked for.
 *
 * `version` and `rawRequest` are withheld deliberately. The agent should not
 * have to know a schema version to describe a pulley, and asking a model to echo
 * the request back is paying tokens for a string we already hold -- and inviting
 * it to paraphrase the one field whose whole value is being verbatim.
 */
export const IntentDraftSchema = IntentModelSchema.omit({
  version: true,
  rawRequest: true,
  metadata: true,
});
export type IntentDraft = ReturnType<typeof IntentDraftSchema.parse>;

export interface AnalyzeIntentOptions {
  readonly provider: LLMProvider;
  /** The user's request, in their words. */
  readonly request: string;
  readonly signal?: AbortSignal;
  /** Attached to the result. Never sent to the model. */
  readonly metadata?: Metadata;
  readonly maxRepairAttempts?: number;
}

export async function analyzeIntent(
  options: AnalyzeIntentOptions,
): Promise<ValidationResult<IntentModel>> {
  const { result } = await requestStructured(
    options.provider,
    {
      system: renderPromptTemplate(INTENT_PROMPT),
      messages: [{ role: "user", content: options.request }],
      schema: IntentDraftSchema,
      name: "IntentModel",
      description: "the instructional intent behind a drawing request",
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.maxRepairAttempts === undefined
        ? {}
        : { maxRepairAttempts: options.maxRepairAttempts }),
    },
    origin,
  );

  if (!result.ok) return result;

  // The draft validated, so the full model can only fail on the fields we
  // supply -- which is exactly why they are supplied rather than requested.
  return ok(
    IntentModelSchema.parse({
      ...result.value,
      version: SCHEMA_VERSION,
      rawRequest: options.request,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    }),
  );
}
