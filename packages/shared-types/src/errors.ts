/**
 * Structured errors and validation results.
 *
 * Two decisions here are load-bearing for the agent architecture:
 *
 * D-3: `SketchMindError` is plain data, not an `Error` subclass. These objects
 * travel over SSE to the browser agent and into the model's context window. An
 * `Error` subclass loses its custom fields the moment it is JSON-serialised, and
 * carries a stack trace that costs tokens and teaches the model nothing.
 *
 * D-2: validation returns a result rather than throwing. Per AD-2 a validation
 * failure is an agent *observation*, not a pipeline halt -- and an agent needs to
 * see every problem at once so it can fix them in one pass, which an exception
 * (one failure, then unwind) structurally cannot deliver.
 */
import { z, type ZodError, type ZodType } from "zod";
import { PipelineStageSchema, type PipelineStage } from "./primitives.js";

export const SketchMindErrorSchema = z.object({
  /** Stable machine-readable identifier, e.g. `AST_DUPLICATE_ID`. */
  code: z.string().min(1),
  /** Human- and model-readable explanation. */
  message: z.string().min(1),
  /** Package that produced the error, e.g. `@sketchmind/diagram-ast`. */
  package: z.string().min(1),
  stage: PipelineStageSchema,
  /** Whether the agent may retry after correcting its input (Volume 16). */
  recoverable: z.boolean(),
  /**
   * Dotted path to the offending field, e.g. `objects[2].id`. Not in Volume 12,
   * added because "where" is the agent's first question about any failure.
   */
  path: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type SketchMindError = z.infer<typeof SketchMindErrorSchema>;

export function makeError(error: SketchMindError): SketchMindError {
  return SketchMindErrorSchema.parse(error);
}

export interface ErrorOrigin {
  package: string;
  stage: PipelineStage;
}

/** Zod's own path segments, rendered the way a developer would write them. */
function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    return acc === "" ? String(segment) : `${acc}.${String(segment)}`;
  }, "");
}

/**
 * Convert a Zod failure into structured errors -- all of them, not the first.
 * Schema failures are recoverable by definition: the agent produced malformed
 * output and can produce it again correctly.
 */
export function errorsFromZod(error: ZodError, origin: ErrorOrigin): SketchMindError[] {
  return error.issues.map((issue) =>
    makeError({
      code: "SCHEMA_INVALID",
      message: issue.message,
      package: origin.package,
      stage: origin.stage,
      recoverable: true,
      path: formatPath(issue.path),
      details: { zodCode: issue.code },
    }),
  );
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly SketchMindError[] };

export function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function fail<T>(errors: readonly SketchMindError[]): ValidationResult<T> {
  return { ok: false, errors };
}

/** Parse against a schema, returning structured errors instead of throwing. */
export function parseWith<S extends ZodType>(
  schema: S,
  input: unknown,
  origin: ErrorOrigin,
): ValidationResult<z.infer<S>> {
  const result = schema.safeParse(input);
  return result.success ? ok(result.data) : fail(errorsFromZod(result.error, origin));
}

/**
 * Fail-fast wrapper for callers that genuinely cannot continue -- program
 * startup, test fixtures. The result-returning form above is the default,
 * because it is the one the agent uses.
 */
export function assertValid<S extends ZodType>(
  schema: S,
  input: unknown,
  origin: ErrorOrigin,
): z.infer<S> {
  const result = parseWith(schema, input, origin);
  if (result.ok) return result.value;
  throw new Error(
    `${origin.package} [${origin.stage}] validation failed:\n` +
      result.errors.map((e) => `  ${e.path || "<root>"}: ${e.message}`).join("\n"),
  );
}
