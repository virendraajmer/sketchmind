/**
 * @sketchmind/stroke-planner
 *
 * LayoutModel + DiagramAST -> StrokeAST, plus the optimizer (Volume 06). This
 * package decides **how a human would draw** a layout: the order, the pen path,
 * the timing. It never decides what exists (the AST did) or where things are
 * (the layout did), and it emits no renderer commands.
 *
 * Nothing here throws on invalid input -- every entry point returns a
 * `ValidationResult`, the same contract `diagram-ast`, `constraint-engine`, and
 * `layout-engine` established, because a validation failure is an agent
 * observation (AD-2), not a halt.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */
import {
  SCHEMA_VERSION,
  StrokeASTSchema,
  fail,
  ok,
  parseWith,
  type DiagramAST,
  type LayoutModel,
  type StrokeAST,
  type ValidationResult,
} from "@sketchmind/shared-types";
import { PACKAGE, plan, type PlanOptions } from "./internal/plan.js";
import { optimize } from "./internal/optimize.js";
import { semanticErrors } from "./internal/validate.js";
import {
  DEFAULT_GENERATOR,
  FREEFORM_GENERATOR,
  GENERATOR_FOR_TYPE,
  getStrokeGenerator,
  registerStrokeGenerator,
  registeredStrokeGeneratorNames,
} from "./internal/generators/registry.js";
import { DRAWING_PHASES, type DrawingPhase } from "./internal/ordering.js";
import type { GeneratedStroke, GeneratorInput, StrokeGenerator } from "./internal/generators/types.js";

export const PACKAGE_NAME = PACKAGE;
export const PACKAGE_VERSION = "0.0.1";

export type { PlanOptions } from "./internal/plan.js";
export type { GeneratedStroke, GeneratorInput, StrokeGenerator, DrawingPhase };
export {
  DRAWING_PHASES,
  DEFAULT_GENERATOR,
  FREEFORM_GENERATOR,
  GENERATOR_FOR_TYPE,
  getStrokeGenerator,
  registerStrokeGenerator,
  registeredStrokeGeneratorNames,
};

const origin = { package: PACKAGE, stage: "stroke" } as const;

/**
 * Validate a value already shaped like a Stroke AST. Schema checks run first;
 * the semantic checks assume a well-formed structure.
 */
export function validateStrokeAST(input: unknown): ValidationResult<StrokeAST> {
  const parsed = parseWith(StrokeASTSchema, input, origin);
  if (!parsed.ok) return parsed;

  const errors = semanticErrors(parsed.value);
  return errors.length > 0 ? fail(errors) : ok(parsed.value);
}

/**
 * Plan a drawing sequence for a solved layout.
 *
 * Deterministic (AD-6): the same AST and layout always produce a byte-identical
 * Stroke AST. Order is semantic -- phases, then containment depth, then the
 * layout's own node order -- never nearest-neighbour over coordinates, so a
 * layout nudge cannot reshuffle the drawing (see the Phase 7 plan, D-3).
 *
 * The optimizer runs by default. If it would change which objects are drawn it
 * declines (D-7) and the unoptimized plan is returned instead -- optimization is
 * a performance pass, and a performance pass is never worth a semantic change.
 */
export function planStrokes(
  ast: DiagramAST,
  layout: LayoutModel,
  options: PlanOptions = {},
): ValidationResult<StrokeAST> {
  const planned = plan(ast, layout, options);
  if (!planned.ok) return fail(planned.errors);

  let strokes = planned.value.strokes;
  let totalDurationMs = planned.value.totalDurationMs;
  if (options.optimize !== false) {
    const optimized = optimize(strokes);
    if (optimized.ok) {
      strokes = optimized.value.strokes;
      totalDurationMs = optimized.value.totalDurationMs;
    }
  }

  return validateStrokeAST({
    version: SCHEMA_VERSION,
    diagramId: ast.id,
    strokes,
    ...(planned.value.bounds === undefined ? {} : { bounds: planned.value.bounds }),
    totalDurationMs,
  });
}

/**
 * Run the optimizer over an existing Stroke AST (Volume 06 §Stroke Optimizer).
 *
 * Separate from `planStrokes` because the runtime's editing operations produce
 * strokes too, and a hand-edited sequence deserves the same merge/thin passes as
 * a planned one. Returns `STROKE_OPTIMIZER_COVERAGE_CHANGED` rather than
 * silently declining, so a caller optimizing deliberately learns that it did.
 */
export function optimizeStrokes(ast: StrokeAST): ValidationResult<StrokeAST> {
  const result = optimize(ast.strokes);
  if (!result.ok) return fail(result.errors);

  return validateStrokeAST({
    ...ast,
    strokes: result.value.strokes,
    totalDurationMs: result.value.totalDurationMs,
  });
}
