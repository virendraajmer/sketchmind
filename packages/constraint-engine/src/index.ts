/**
 * @sketchmind/constraint-engine
 *
 * DiagramAST -> ConstraintGraph. Derives spatial intent, computes no geometry
 * (Volume 05, Volume 14 §Constraint Grammar).
 *
 * Nothing here throws on invalid input -- every entry point returns a
 * `ValidationResult`, same contract as `@sketchmind/diagram-ast`, because a
 * validation failure is an agent observation (AD-2), not a pipeline halt.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */
import {
  ConstraintGraphSchema,
  SCHEMA_VERSION,
  parseWith,
  ok,
  fail,
  type ConstraintGraph,
  type DiagramAST,
  type ValidationResult,
} from "@sketchmind/shared-types";
import { derive, flatten, OVERLAP_METADATA_KEY, PACKAGE } from "./internal/derive.js";
import { semanticErrors } from "./internal/validate.js";

export const PACKAGE_NAME = PACKAGE;
export const PACKAGE_VERSION = "0.0.1";

export { flatten, OVERLAP_METADATA_KEY };

const origin = { package: PACKAGE, stage: "constraint" } as const;

/**
 * Validate a value that is already shaped like a Constraint Graph. Schema
 * checks run first: semantic checks assume a well-formed structure.
 */
export function validateConstraintGraph(input: unknown): ValidationResult<ConstraintGraph> {
  const parsed = parseWith(ConstraintGraphSchema, input, origin);
  if (!parsed.ok) return parsed;

  const errors = semanticErrors(parsed.value);
  return errors.length > 0 ? fail(errors) : ok(parsed.value);
}

/**
 * Derive a Constraint Graph from a Diagram AST. Deterministic: the same AST
 * always produces byte-identical constraints in the same order (AD-6).
 *
 * `intersects` relationships carry no spatial constraint (see internal/derive
 * for why) and are recorded instead as overlap exemptions under
 * `metadata[OVERLAP_METADATA_KEY]`, which the layout engine's collision pass
 * reads via `overlapExemptions()`.
 */
export function deriveConstraintGraph(ast: DiagramAST): ValidationResult<ConstraintGraph> {
  const { nodes, constraints, overlapPermitted } = derive(ast);
  return validateConstraintGraph({
    version: SCHEMA_VERSION,
    nodes,
    constraints,
    metadata: overlapPermitted.length > 0 ? { [OVERLAP_METADATA_KEY]: overlapPermitted } : undefined,
  });
}

/** Pairs of object ids permitted to overlap -- see `deriveConstraintGraph`. */
export function overlapExemptions(graph: ConstraintGraph): Array<[string, string]> {
  const raw = graph.metadata?.[OVERLAP_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (pair): pair is [string, string] =>
      Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string",
  );
}
