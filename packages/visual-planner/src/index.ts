/**
 * @sketchmind/visual-planner
 *
 * `IntentModel` to `VisualPlan` (V03 §Visual Planning Agent, V15 §Agent Contracts).
 *
 * This stage decides **what appears**, and nothing else. Not what it looks like,
 * not what it is made of, not where it goes. That restraint is the whole reason
 * the stage exists separately: "which objects belong in this explanation" is a
 * teaching judgement, and mixing it with "what is a pulley made of" (which is
 * `shape-intelligence`) produces plans that are really half-drawn diagrams.
 *
 * Validation follows AD-2 throughout: a plan whose labels point at objects it
 * never declared comes back as structured errors the agent fixes, not an
 * exception that ends the run.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */
import {
  SCHEMA_VERSION,
  VisualPlanSchema,
  fail,
  ok,
  parseWith,
  renderPromptTemplate,
  type IntentModel,
  type Metadata,
  type ValidationResult,
  type VisualPlan,
} from "@sketchmind/shared-types";
import { requestStructured, type LLMProvider } from "@sketchmind/llm-provider";
import { VISUAL_PLAN_PROMPT } from "./internal/prompt.js";
import { PACKAGE, defaultFocusOrder, semanticErrors } from "./internal/validate.js";

export const PACKAGE_NAME = PACKAGE;
export const PACKAGE_VERSION = "0.0.1";

export { VISUAL_PLAN_PROMPT };

const origin = { package: PACKAGE, stage: "vil" } as const;

/** The model supplies everything except the schema version. */
export const VisualPlanDraftSchema = VisualPlanSchema.omit({ version: true, metadata: true });

export interface PlanVisualOptions {
  readonly provider: LLMProvider;
  readonly intent: IntentModel;
  readonly signal?: AbortSignal;
  readonly metadata?: Metadata;
  readonly maxRepairAttempts?: number;
}

/**
 * Validate a plan that already exists, filling in a default draw order.
 *
 * Exported separately from `planVisual` because the agent may compose a plan
 * itself for a trivial request rather than spending a model call on it (AD-1),
 * and that plan must be held to exactly the same standard.
 */
export function validateVisualPlan(input: unknown): ValidationResult<VisualPlan> {
  const parsed = parseWith(VisualPlanSchema, input, origin);
  if (!parsed.ok) return parsed;

  const errors = semanticErrors(parsed.value);
  if (errors.length > 0) return fail(errors);

  const plan = parsed.value;
  return ok(
    plan.focusOrder.length > 0 ? plan : { ...plan, focusOrder: defaultFocusOrder(plan) },
  );
}

export async function planVisual(
  options: PlanVisualOptions,
): Promise<ValidationResult<VisualPlan>> {
  const { intent } = options;

  const { result } = await requestStructured(
    options.provider,
    {
      system: renderPromptTemplate(VISUAL_PLAN_PROMPT),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            intent: intent.intent,
            subject: intent.subject,
            domain: intent.domain,
            category: intent.category,
            complexity: intent.complexity,
            teachingObjective: intent.teachingObjective,
            rawRequest: intent.rawRequest,
          }),
        },
      ],
      schema: VisualPlanDraftSchema,
      name: "VisualPlan",
      description: "what should appear on the whiteboard, with no geometry",
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.maxRepairAttempts === undefined
        ? {}
        : { maxRepairAttempts: options.maxRepairAttempts }),
    },
    origin,
  );

  if (!result.ok) return result;

  return validateVisualPlan({
    ...result.value,
    version: SCHEMA_VERSION,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}
