/**
 * @sketchmind/diagram-ast
 *
 * Builds, validates, and serializes the Diagram AST -- the single source of
 * truth for what a diagram contains (Volume 04).
 *
 * Nothing here throws on invalid input. Every entry point returns a
 * `ValidationResult` carrying structured errors, because per AD-2 a validation
 * failure is an observation the agent acts on, not a pipeline halt. The agent
 * reads the errors, fixes its AST, and calls again.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */
import {
  DiagramASTSchema,
  SCHEMA_VERSION,
  parseWith,
  ok,
  fail,
  makeError,
  type DiagramAST,
  type ValidationResult,
} from "@sketchmind/shared-types";
import { semanticErrors, collectObjects, findObject, PACKAGE } from "./internal/validate.js";

export const PACKAGE_NAME = PACKAGE;
export const PACKAGE_VERSION = "0.0.1";

export { collectObjects, findObject };

const origin = { package: PACKAGE, stage: "diagram-ast" } as const;

/**
 * Validate a value that is already shaped like a Diagram AST.
 *
 * Schema checks run first: the semantic checks assume a well-formed structure,
 * and running them against malformed input produces confident errors about the
 * wrong thing.
 */
export function validateDiagramAST(input: unknown): ValidationResult<DiagramAST> {
  const parsed = parseWith(DiagramASTSchema, input, origin);
  if (!parsed.ok) return parsed;

  const errors = semanticErrors(parsed.value);
  return errors.length > 0 ? fail(errors) : ok(parsed.value);
}

/**
 * Build an AST from partial input, stamping the current schema version.
 *
 * The version is supplied rather than demanded from the caller: the agent should
 * not need to know a schema version to describe a pulley, and letting it guess
 * is how you get an AST claiming a version that never existed.
 */
export function buildDiagramAST(input: Record<string, unknown>): ValidationResult<DiagramAST> {
  return validateDiagramAST({ version: SCHEMA_VERSION, ...input });
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
}

/**
 * Serialize with sorted keys.
 *
 * Determinism matters here for AD-6: snapshot tests and the layout cache both
 * key off this string. `JSON.stringify` emits keys in insertion order, so two
 * semantically identical ASTs assembled in different orders would produce
 * different bytes and miss the same cache entry forever.
 */
export function serializeDiagramAST(ast: DiagramAST): string {
  return JSON.stringify(sortKeys(ast), null, 2);
}

/** Parse JSON into a validated AST. Malformed JSON is an error, not a throw. */
export function parseDiagramAST(json: string): ValidationResult<DiagramAST> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    return fail([
      makeError({
        code: "AST_MALFORMED_JSON",
        message: `Input is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        package: PACKAGE,
        stage: "diagram-ast",
        recoverable: true,
        path: "",
      }),
    ]);
  }
  return validateDiagramAST(raw);
}
