/**
 * @sketchmind/diagram-reasoner
 *
 * Whatever reasoning exists so far, to a validated `DiagramAST`
 * (V03 §Diagram Composition, V04, V15 §Agent Contracts).
 *
 * The Package Map calls this "`ShapeGraph` -> `DiagramAST`", and under the docs'
 * fixed pipeline that is all it could be. Under AD-1 the shape graph is
 * *optional*, along with the plan and the intent: the agent decides how much
 * reasoning a request deserves, and this stage has to compose a valid AST from
 * whatever it was handed -- up to and including nothing but the user's sentence.
 * That is what makes "draw a circle" cost one model call instead of four.
 *
 * Composition never throws on the model's account (AD-2). An AST that fails
 * validation comes back as structured errors, and `composeDiagramAST` accepts
 * those errors plus the failed attempt on the next call, so the agent's repair
 * step is a normal call rather than a special mode.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */
import {
  DiagramASTSchema,
  SCHEMA_VERSION,
  renderPromptTemplate,
  type DiagramAST,
  type IntentModel,
  type ShapeGraph,
  type SketchMindError,
  type ValidationResult,
  type VisualPlan,
} from "@sketchmind/shared-types";
import { buildDiagramAST, validateDiagramAST } from "@sketchmind/diagram-ast";
import { requestStructured, type LLMProvider } from "@sketchmind/llm-provider";
import { DIAGRAM_AST_PROMPT } from "./internal/prompt.js";

export const PACKAGE_NAME = "@sketchmind/diagram-reasoner";
export const PACKAGE_VERSION = "0.0.1";

export { DIAGRAM_AST_PROMPT };

const origin = { package: PACKAGE_NAME, stage: "diagram-ast" } as const;

/** The model supplies everything except the schema version. */
export const DiagramASTDraftSchema = DiagramASTSchema.omit({ version: true });

export interface ComposeDiagramASTOptions {
  readonly provider: LLMProvider;
  /** The user's request. Always sent -- it is the one input that always exists. */
  readonly request: string;
  readonly intent?: IntentModel;
  readonly plan?: VisualPlan;
  readonly shapeGraph?: ShapeGraph;
  /**
   * The AST that failed last time, and why. Supplying both is what turns AD-2's
   * "validation errors are observations" into a repair the model can actually
   * perform -- errors without the text they refer to are riddles.
   */
  readonly previousAttempt?: unknown;
  readonly previousErrors?: readonly SketchMindError[];
  readonly signal?: AbortSignal;
  readonly maxRepairAttempts?: number;
}

function describeErrors(errors: readonly SketchMindError[]): string[] {
  return errors.map((error) => `${error.path || "<root>"}: [${error.code}] ${error.message}`);
}

export async function composeDiagramAST(
  options: ComposeDiagramASTOptions,
): Promise<ValidationResult<DiagramAST>> {
  const input = {
    request: options.request,
    intent: options.intent
      ? {
          intent: options.intent.intent,
          subject: options.intent.subject,
          domain: options.intent.domain,
          category: options.intent.category,
          complexity: options.intent.complexity,
          teachingObjective: options.intent.teachingObjective,
        }
      : undefined,
    plan: options.plan
      ? {
          detailLevel: options.plan.detailLevel,
          objects: options.plan.objects,
          labels: options.plan.labels,
          highlights: options.plan.highlights,
          animations: options.plan.animations,
          focusOrder: options.plan.focusOrder,
        }
      : undefined,
    shapeGraph: options.shapeGraph,
    previousAttempt: options.previousAttempt,
    previousErrors: options.previousErrors ? describeErrors(options.previousErrors) : undefined,
  };

  const { result } = await requestStructured(
    options.provider,
    {
      system: renderPromptTemplate(DIAGRAM_AST_PROMPT),
      messages: [{ role: "user", content: JSON.stringify(input) }],
      schema: DiagramASTDraftSchema,
      name: "DiagramAST",
      description: "what exists in the diagram, with no geometry",
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.maxRepairAttempts === undefined
        ? {}
        : { maxRepairAttempts: options.maxRepairAttempts }),
    },
    origin,
  );

  if (!result.ok) return result;

  // `buildDiagramAST` stamps the version and runs `diagram-ast`'s own schema and
  // semantic checks. Re-implementing either here would give the agent two
  // slightly different definitions of a valid AST.
  return buildDiagramAST(result.value);
}

/**
 * Re-export the validator so a caller holding only this package can check an AST
 * the agent composed itself, without reaching past it into `diagram-ast`.
 */
export { validateDiagramAST };

export const DIAGRAM_SCHEMA_VERSION = SCHEMA_VERSION;
