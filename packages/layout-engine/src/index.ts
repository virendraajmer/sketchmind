/**
 * @sketchmind/layout-engine
 *
 * Diagram AST + ConstraintGraph -> LayoutModel: the only package allowed to
 * compute geometry (Volume 05). Solver, collision detection, label
 * placement, and straight connector routing.
 *
 * Nothing here throws on invalid input -- every entry point returns a
 * `ValidationResult`, same contract as `diagram-ast` and `constraint-engine`,
 * because a validation failure is an agent observation (AD-2), not a halt.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */
import {
  LayoutModelSchema,
  SCHEMA_VERSION,
  parseWith,
  ok,
  fail,
  type ConstraintGraph,
  type DiagramAST,
  type LayoutModel,
  type ValidationResult,
} from "@sketchmind/shared-types";
import { PACKAGE, solve, type SolveOptions } from "./internal/solve.js";
import { semanticErrors } from "./internal/validate.js";
import {
  getStrategy,
  registerStrategy,
  registeredStrategyNames,
} from "./internal/strategies/registry.js";
import { DEFAULT_STRATEGY_FOR_CATEGORY } from "./internal/strategy-selection.js";
import type { LayoutStrategy, StrategyInput, StrategyResult } from "./internal/strategies/types.js";

export const PACKAGE_NAME = PACKAGE;
export const PACKAGE_VERSION = "0.0.1";

export type { SolveOptions as LayoutOptions } from "./internal/solve.js";
export type { LayoutStrategy, StrategyInput, StrategyResult };
export { getStrategy, registerStrategy, registeredStrategyNames, DEFAULT_STRATEGY_FOR_CATEGORY };

const origin = { package: PACKAGE, stage: "layout" } as const;

/**
 * Validate a value that is already shaped like a Layout Model. Schema checks
 * run first: semantic checks assume a well-formed structure.
 */
export function validateLayoutModel(input: unknown): ValidationResult<LayoutModel> {
  const parsed = parseWith(LayoutModelSchema, input, origin);
  if (!parsed.ok) return parsed;

  const errors = semanticErrors(parsed.value);
  return errors.length > 0 ? fail(errors) : ok(parsed.value);
}

/**
 * Solve a Diagram AST + its Constraint Graph into a Layout Model.
 *
 * Deterministic (AD-6): the same AST and graph always produce byte-identical
 * geometry. Strategy is chosen from `ast.category` unless `options.strategy`
 * names a registered one (see `registerStrategy` -- Volume 05 §Extensibility).
 */
export function solveLayout(
  ast: DiagramAST,
  graph: ConstraintGraph,
  options: SolveOptions = {},
): ValidationResult<LayoutModel> {
  const result = solve(ast, graph, options);
  if (!result.ok) return fail(result.errors);

  return validateLayoutModel({
    version: SCHEMA_VERSION,
    diagramId: ast.id,
    strategy: result.value.strategyName,
    canvas: result.value.canvas,
    nodes: result.value.nodes,
    connectors: result.value.connectors,
    labels: result.value.labels,
  });
}
