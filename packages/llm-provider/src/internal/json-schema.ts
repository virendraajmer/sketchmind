/**
 * Zod -> strict-mode JSON Schema (D-4).
 *
 * `z.toJSONSchema()` produces valid JSON Schema. It does not produce schema a
 * provider's strict structured-output mode accepts, and the gap is not small:
 *
 *   - every object needs `additionalProperties: false`
 *   - every property must appear in `required`; optionality is expressed by
 *     admitting `null` instead
 *   - open-ended maps (`z.record`, `z.unknown`) cannot be expressed at all
 *   - assorted validation keywords (`minLength`, `default`, `propertyNames`, ...)
 *     are rejected outright
 *
 * This lives in `llm-provider`, not in the Azure adapter, because it imports no
 * SDK and because the same normalization is what makes the prompt-injected
 * fallback legible to a weaker model. Writing it per-adapter would mean writing
 * it again for every provider.
 *
 * Tested against every schema `shared-types` exports, not against toy objects --
 * if `DiagramASTSchema` cannot be normalized we need to know now, not in Phase 5.
 */
import {
  fail,
  makeError,
  ok,
  type SketchMindError,
  type ValidationResult,
} from "@sketchmind/shared-types";
import { z, type ZodType } from "zod";

type JsonSchema = Record<string, unknown>;

/**
 * Keywords a strict structured-output mode rejects or ignores.
 *
 * `default` is stripped deliberately: under strict mode every property is
 * required, so a default can never fire -- leaving it in is a claim the schema
 * cannot honour. Zod still applies its own defaults when it parses the result.
 */
const STRIPPED_KEYWORDS = new Set([
  "$schema",
  "default",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "propertyNames",
  "patternProperties",
  "contentEncoding",
  "contentMediaType",
]);

export interface StrictSchema {
  /** Ready to hand to a provider as `text.format.schema` or a tool's schema. */
  readonly schema: JsonSchema;
  /**
   * Properties removed because they were open-ended maps. Always optional ones
   * -- a required one is an error, not a silent drop. The model simply never
   * produces them; Zod is fine with that because they were optional.
   */
  readonly droppedPaths: readonly string[];
  /**
   * Optional properties that became required-and-nullable. `decodeStrictOutput`
   * must strip the nulls back out before Zod sees them.
   */
  readonly nullablePaths: readonly string[];
}

function error(message: string, path: string): SketchMindError {
  return makeError({
    code: "PROVIDER_SCHEMA_UNREPRESENTABLE",
    message,
    package: "@sketchmind/llm-provider",
    stage: "agent",
    // The caller wrote a schema no provider can constrain output to. That is a
    // code fix, not something the agent can retry its way out of.
    recoverable: false,
    path,
  });
}

/**
 * An open-ended map: an object that accepts arbitrary keys. `z.record(...)` and
 * `z.unknown()` both land here, and strict mode has no way to express either.
 */
function isOpenEnded(node: JsonSchema): boolean {
  const isEmptySchema = Object.keys(node).length === 0;
  if (isEmptySchema) return true;
  if (node["type"] !== "object") return false;
  const hasDeclaredProperties =
    typeof node["properties"] === "object" &&
    node["properties"] !== null &&
    Object.keys(node["properties"] as object).length > 0;
  return !hasDeclaredProperties && node["additionalProperties"] !== false;
}

/** `{ type: "string" }` -> `{ type: ["string", "null"] }`; anything else via anyOf. */
function makeNullable(node: JsonSchema): JsonSchema {
  const type = node["type"];
  if (typeof type === "string") return { ...node, type: [type, "null"] };
  if (Array.isArray(type)) {
    return type.includes("null") ? node : { ...node, type: [...type, "null"] };
  }
  return { anyOf: [node, { type: "null" }] };
}

interface Context {
  readonly dropped: string[];
  readonly nullable: string[];
  readonly errors: SketchMindError[];
}

function joinPath(path: string, segment: string): string {
  return path === "" ? segment : `${path}.${segment}`;
}

function normalizeNode(input: unknown, path: string, ctx: Context): JsonSchema {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    ctx.errors.push(error(`Expected a schema object at ${path || "<root>"}.`, path));
    return {};
  }

  const node = input as JsonSchema;
  const out: JsonSchema = {};

  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED_KEYWORDS.has(key)) continue;

    if (key === "properties" || key === "$defs" || key === "definitions") continue; // handled below
    if (key === "required") continue; // rebuilt below
    if (key === "additionalProperties") continue; // forced below

    if (key === "items") {
      out["items"] = normalizeNode(value, joinPath(path, "[]"), ctx);
      continue;
    }
    if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      const branches = Array.isArray(value) ? value : [];
      // `oneOf` is not part of the supported subset; `anyOf` is, and for our
      // discriminated unions the two mean the same thing.
      out["anyOf"] = branches.map((branch, index) =>
        normalizeNode(branch, joinPath(path, `<${index}>`), ctx),
      );
      continue;
    }
    if (key === "const") {
      // `enum` is in the supported subset; `const` is not universally.
      out["enum"] = [value];
      continue;
    }
    out[key] = value;
  }

  for (const defsKey of ["$defs", "definitions"] as const) {
    const defs = node[defsKey];
    if (typeof defs !== "object" || defs === null) continue;
    const normalizedDefs: JsonSchema = {};
    for (const [name, def] of Object.entries(defs as Record<string, unknown>)) {
      normalizedDefs[name] = normalizeNode(def, joinPath(path, `${defsKey}.${name}`), ctx);
    }
    out[defsKey] = normalizedDefs;
  }

  const properties = node["properties"];
  if (typeof properties === "object" && properties !== null) {
    const declaredRequired = new Set(
      Array.isArray(node["required"]) ? (node["required"] as string[]).map(String) : [],
    );
    const normalizedProperties: JsonSchema = {};
    const required: string[] = [];

    for (const [name, rawChild] of Object.entries(properties as Record<string, unknown>)) {
      const childPath = joinPath(path, name);
      const child = (rawChild ?? {}) as JsonSchema;

      if (isOpenEnded(child)) {
        if (declaredRequired.has(name)) {
          ctx.errors.push(
            error(
              `Required property "${name}" is an open-ended map, which strict structured ` +
                `output cannot express. Give it declared properties or make it optional.`,
              childPath,
            ),
          );
          continue;
        }
        ctx.dropped.push(childPath);
        continue;
      }

      const normalizedChild = normalizeNode(child, childPath, ctx);
      if (declaredRequired.has(name)) {
        normalizedProperties[name] = normalizedChild;
      } else {
        // Strict mode has no optional properties. Absence becomes `null`, which
        // `decodeStrictOutput` strips before Zod -- our models express absence
        // as `undefined`, never `null`.
        normalizedProperties[name] = makeNullable(normalizedChild);
        ctx.nullable.push(childPath);
      }
      required.push(name);
    }

    out["properties"] = normalizedProperties;
    out["required"] = required;
    out["additionalProperties"] = false;
  } else if (node["type"] === "object") {
    out["properties"] = {};
    out["required"] = [];
    out["additionalProperties"] = false;
  }

  return out;
}

/** `[a-zA-Z0-9_-]{1,64}` -- the name constraint every provider we target imposes. */
const VALID_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function toStrictJsonSchema(schema: ZodType, name: string): ValidationResult<StrictSchema> {
  if (!VALID_NAME.test(name)) {
    return fail([
      error(
        `Schema name "${name}" must match [a-zA-Z0-9_-] and be 1-64 characters.`,
        "name",
      ),
    ]);
  }

  let generated: JsonSchema;
  try {
    // `io: "input"` matters: the model produces the schema's INPUT shape, where
    // fields carrying Zod defaults are still optional. Using the output shape
    // would demand values the model was never meant to supply.
    generated = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  } catch (cause) {
    return fail([
      error(
        `Zod could not convert this schema to JSON Schema: ${(cause as Error).message}`,
        "<root>",
      ),
    ]);
  }

  const ctx: Context = { dropped: [], nullable: [], errors: [] };
  const normalized = normalizeNode(generated, "", ctx);

  if (normalized["type"] !== "object") {
    ctx.errors.push(
      error("Structured output must be a JSON object at the root, not a bare value or array.", "<root>"),
    );
  }

  if (ctx.errors.length > 0) return fail(ctx.errors);
  return ok({ schema: normalized, droppedPaths: ctx.dropped, nullablePaths: ctx.nullable });
}

/**
 * Undo the nullable-for-optional encoding.
 *
 * Strict mode forced every optional field to be present-and-null. Zod's
 * `.optional()` accepts `undefined`, not `null`, so a straight parse of the raw
 * output would fail on every field the model correctly declined to fill in.
 *
 * Stripping nulls wholesale is safe here because no SketchMind model uses
 * `.nullable()` -- absence is always `undefined`. A test asserts that stays true.
 */
export function decodeStrictOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeStrictOutput);
  if (typeof value !== "object" || value === null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === null) continue;
    out[key] = decodeStrictOutput(child);
  }
  return out;
}
