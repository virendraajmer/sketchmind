/**
 * @sketchmind/shape-intelligence
 *
 * `VisualPlan` to `ShapeGraph`, plus primitive discovery and generation
 * (V10 §Shape Intelligence Engine, V14 §Shape Graph, AD-5).
 *
 * V10's rule is "look it up before inventing it", and this package makes that
 * mechanical rather than advisory: `generatePrimitive` **runs the search itself**
 * and returns the match when one is good enough. There is no code path that
 * generates without having searched, so the guarantee does not depend on the
 * agent choosing to be well behaved (AD-8 -- bound the cost, never gate the
 * decision).
 *
 * Two ways to answer "what is this thing":
 *
 *  - `generatePrimitive` -- a `ShapeGraph`: what it is *made of*, semantic, reusable.
 *  - `composeFreeform`   -- a `FreeformShape`: what it *looks like*, in the shape's
 *    own 0..1 unit box, for objects with no structure worth decomposing (AD-5).
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */
import {
  FreeformShapeSchema,
  SCHEMA_VERSION,
  ShapeGraphSchema,
  fail,
  ok,
  parseWith,
  renderPromptTemplate,
  type FreeformShape,
  type IntentModel,
  type Metadata,
  type ShapeGraph,
  type ValidationResult,
  type VisualPlan,
} from "@sketchmind/shared-types";
import { requestStructured, type LLMProvider } from "@sketchmind/llm-provider";
import { FREEFORM_PROMPT, PRIMITIVE_PROMPT, SHAPE_GRAPH_PROMPT } from "./internal/prompt.js";
import { PACKAGE, semanticErrors } from "./internal/validate.js";

export const PACKAGE_NAME = PACKAGE;
export const PACKAGE_VERSION = "0.0.1";

export { FREEFORM_PROMPT, PRIMITIVE_PROMPT, SHAPE_GRAPH_PROMPT };

export {
  DEFAULT_MIN_SCORE,
  DEFAULT_SEARCH_LIMIT,
  EMPTY_CATALOG,
  InMemoryPrimitiveCatalog,
  REUSE_SCORE,
  lexicalScore,
  tokenize,
  type PrimitiveCatalog,
  type PrimitiveMatch,
  type PrimitiveRecord,
  type SearchOptions,
} from "./catalog.js";

import { REUSE_SCORE, type PrimitiveCatalog, type PrimitiveMatch } from "./catalog.js";

const origin = { package: PACKAGE, stage: "shape-graph" } as const;

/** The model supplies everything except the schema version. */
export const ShapeGraphDraftSchema = ShapeGraphSchema.omit({ version: true, metadata: true });
export const FreeformShapeDraftSchema = FreeformShapeSchema.omit({ version: true, metadata: true });

/**
 * Validate a graph that already exists.
 *
 * Separate from the generators because the agent may hand-compose a graph for a
 * trivial subject rather than spend a model call on it (AD-1), and a
 * hand-composed graph is held to the same standard as a generated one.
 */
export function validateShapeGraph(input: unknown): ValidationResult<ShapeGraph> {
  const parsed = parseWith(ShapeGraphSchema, input, origin);
  if (!parsed.ok) return parsed;

  const errors = semanticErrors(parsed.value);
  return errors.length > 0 ? fail(errors) : ok(parsed.value);
}

interface StageOptions {
  readonly provider: LLMProvider;
  readonly signal?: AbortSignal;
  readonly metadata?: Metadata;
  readonly maxRepairAttempts?: number;
}

function requestFields(options: StageOptions): Record<string, unknown> {
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.maxRepairAttempts === undefined
      ? {}
      : { maxRepairAttempts: options.maxRepairAttempts }),
  };
}

export interface BuildShapeGraphOptions extends StageOptions {
  readonly plan: VisualPlan;
  /** Supplies subject and domain. Omitted when the agent skipped intent analysis. */
  readonly intent?: IntentModel;
}

export async function buildShapeGraph(
  options: BuildShapeGraphOptions,
): Promise<ValidationResult<ShapeGraph>> {
  const { intent, plan } = options;

  const { result } = await requestStructured(
    options.provider,
    {
      system: renderPromptTemplate(SHAPE_GRAPH_PROMPT),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            intent: intent
              ? { subject: intent.subject, domain: intent.domain, category: intent.category }
              : undefined,
            plan: {
              detailLevel: plan.detailLevel,
              objects: plan.objects,
              labels: plan.labels,
              focusOrder: plan.focusOrder,
            },
          }),
        },
      ],
      schema: ShapeGraphDraftSchema,
      name: "ShapeGraph",
      description: "what the planned objects are structurally made of",
      ...requestFields(options),
    },
    origin,
  );

  if (!result.ok) return result;

  return validateShapeGraph({
    ...result.value,
    version: SCHEMA_VERSION,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}

export interface SearchPrimitivesOptions {
  readonly catalog: PrimitiveCatalog;
  readonly query: string;
  readonly limit?: number;
  readonly minScore?: number;
}

/**
 * Look for an existing primitive. Zero model calls, always.
 *
 * Finding nothing is `ok` with an empty array, not a failure. AD-2's "failure as
 * observation" covers problems the agent can fix; an empty catalogue is not one,
 * and reporting it as an error would send the agent hunting for a bug.
 */
export async function searchPrimitives(
  options: SearchPrimitivesOptions,
): Promise<ValidationResult<PrimitiveMatch[]>> {
  const matches = await options.catalog.search(options.query, {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.minScore === undefined ? {} : { minScore: options.minScore }),
  });
  return ok(matches);
}

export interface GeneratePrimitiveOptions extends StageOptions {
  readonly name: string;
  readonly description: string;
  /** Searched before generating. Defaults to searching nothing, not to skipping. */
  readonly catalog?: PrimitiveCatalog;
  /** Score at or above which an existing primitive is reused instead. */
  readonly reuseScore?: number;
}

export interface GeneratedPrimitive {
  readonly graph: ShapeGraph;
  /** True when the catalogue already had this and no model call was made (V10). */
  readonly reused: boolean;
  /** What the mandatory pre-generation search turned up, reused or not. */
  readonly matches: readonly PrimitiveMatch[];
}

/**
 * Produce a `ShapeGraph` for one object, searching the catalogue first (V10).
 *
 * A match at or above `reuseScore` that carries a stored graph is returned as
 * is, with `reused: true` and no model call. Weaker matches are still reported:
 * they are context the agent may want even when they were not good enough to
 * substitute.
 */
export async function generatePrimitive(
  options: GeneratePrimitiveOptions,
): Promise<ValidationResult<GeneratedPrimitive>> {
  const reuseScore = options.reuseScore ?? REUSE_SCORE;
  // Searched by name alone, not name-plus-description. Appending a sentence
  // dilutes the one token that identifies the thing: "pulley" scores 1 against
  // an entry called "pulley", while "pulley, a grooved wheel on an axle that
  // redirects a rope" scores 0.5 and misses its own exact match. Description-led
  // discovery is what `search_primitives` is for, where the agent chooses the
  // phrase.
  const matches = options.catalog ? await options.catalog.search(options.name) : [];

  const reusable = matches.find((match) => match.score >= reuseScore && match.record.shapeGraph);
  if (reusable?.record.shapeGraph) {
    return ok({ graph: reusable.record.shapeGraph, reused: true, matches });
  }

  const { result } = await requestStructured(
    options.provider,
    {
      system: renderPromptTemplate(PRIMITIVE_PROMPT),
      messages: [
        { role: "user", content: JSON.stringify({ name: options.name, description: options.description }) },
      ],
      schema: ShapeGraphDraftSchema,
      name: "ShapeGraph",
      description: `the structure of "${options.name}"`,
      ...requestFields(options),
    },
    origin,
  );

  if (!result.ok) return result;

  const validated = validateShapeGraph({
    ...result.value,
    version: SCHEMA_VERSION,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
  if (!validated.ok) return validated;

  return ok({ graph: validated.value, reused: false, matches });
}

export interface ComposeFreeformOptions extends StageOptions {
  readonly name: string;
  readonly description: string;
}

/**
 * Compose a one-off shape from geometric sub-primitives (AD-5).
 *
 * The unit-space relaxation is bounded by `FreeformShapeSchema` itself -- `u`
 * and `v` outside 0..1 fail validation -- so a model that starts emitting pixel
 * coordinates here is caught by the schema rather than by a reviewer.
 */
export async function composeFreeform(
  options: ComposeFreeformOptions,
): Promise<ValidationResult<FreeformShape>> {
  const { result } = await requestStructured(
    options.provider,
    {
      system: renderPromptTemplate(FREEFORM_PROMPT),
      messages: [
        { role: "user", content: JSON.stringify({ name: options.name, description: options.description }) },
      ],
      schema: FreeformShapeDraftSchema,
      name: "FreeformShape",
      description: `a sketchable composition of "${options.name}"`,
      ...requestFields(options),
    },
    { package: PACKAGE, stage: "shape-graph" },
  );

  if (!result.ok) return result;

  return parseWith(
    FreeformShapeSchema,
    {
      ...result.value,
      version: SCHEMA_VERSION,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    },
    origin,
  );
}
