/**
 * The normalizer is the highest-risk piece in Phase 3: if it produces schema a
 * provider rejects, every structured call fails at runtime and nothing before
 * runtime says so. So it is tested against the real models, and the "is this
 * actually strict-valid?" check is a walker rather than a spot check.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as SharedTypes from "@sketchmind/shared-types";
import { decodeStrictOutput, toStrictJsonSchema } from "../src/internal/json-schema.js";

type JsonSchema = Record<string, unknown>;

/** Keywords a strict structured-output mode rejects. Must not survive. */
const FORBIDDEN_KEYWORDS = [
  "$schema",
  "default",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "propertyNames",
  "patternProperties",
  "const",
  "oneOf",
];

/** Walks the whole document, `$defs` included, and reports every violation. */
function strictViolations(node: unknown, path = "<root>"): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child, i) => strictViolations(child, `${path}[${i}]`));
  }
  if (typeof node !== "object" || node === null) return [];

  const schema = node as JsonSchema;
  const problems: string[] = [];

  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (keyword in schema) problems.push(`${path}: forbidden keyword "${keyword}"`);
  }

  const properties = schema["properties"];
  if (typeof properties === "object" && properties !== null) {
    if (schema["additionalProperties"] !== false) {
      problems.push(`${path}: additionalProperties must be false`);
    }
    const required = new Set(
      Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [],
    );
    for (const name of Object.keys(properties as JsonSchema)) {
      if (!required.has(name)) {
        problems.push(`${path}: property "${name}" is not in required`);
      }
    }
  }

  for (const [key, value] of Object.entries(schema)) {
    if (key === "enum" || key === "required") continue;
    problems.push(...strictViolations(value, `${path}.${key}`));
  }
  return problems;
}

function isZodType(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

/** Every exported schema whose JSON Schema root is an object. */
function objectRootedSchemas(): Array<[string, z.ZodType]> {
  // `SharedTypes` is a namespace import: TypeScript infers `Object.entries` over
  // it as a union of per-property tuple literals rather than `[string, T][]`,
  // which the `isZodType` predicate below can't narrow against. Widening to
  // `Record<string, unknown>` first is what actually erases that literal typing.
  return Object.entries(SharedTypes as Record<string, unknown>)
    .filter((entry): entry is [string, z.ZodType] => isZodType(entry[1]))
    .filter(([, schema]) => {
      try {
        const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
        return json["type"] === "object";
      } catch {
        return false;
      }
    });
}

/**
 * Schemas the model never *produces*, and so never needs to be a structured
 * output target.
 *
 * `ToolSpec.parameters` is a JSON Schema for a tool's arguments: an arbitrary
 * map by definition, and one WE hand to the model rather than ask it for. There
 * is no version of this that strict mode can express, and there does not need
 * to be.
 *
 * This list is asserted to fail for exactly that reason below, so nothing else
 * can quietly shelter behind it.
 */
const NEVER_MODEL_OUTPUT = new Set(["ToolSpecSchema"]);

describe("toStrictJsonSchema", () => {
  const all = objectRootedSchemas();
  const schemas = all.filter(([name]) => !NEVER_MODEL_OUTPUT.has(name));

  it("excludes only schemas that are inputs to the model, for the documented reason", () => {
    for (const name of NEVER_MODEL_OUTPUT) {
      const entry = all.find(([exported]) => exported === name);
      expect(entry, `${name} is no longer exported; drop it from the exclusion list`).toBeDefined();
      const result = toStrictJsonSchema(entry![1], "excluded");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Fails because it contains a required open-ended map -- not for some
      // other reason the exclusion would then be hiding.
      expect(result.errors.map((e) => e.code)).toContain("PROVIDER_SCHEMA_UNREPRESENTABLE");
      expect(result.errors.some((e) => e.message.includes("open-ended map"))).toBe(true);
    }
  });

  it("finds the shared-types models to check", () => {
    // Guards against the filter silently matching nothing, which would make
    // every case below vacuously pass.
    expect(schemas.length).toBeGreaterThan(10);
    const names = schemas.map(([name]) => name);
    expect(names).toContain("DiagramASTSchema");
    expect(names).toContain("VILSchema");
    expect(names).toContain("ConstraintGraphSchema");
    expect(names).toContain("StrokeASTSchema");
  });

  it.each(schemas)("normalizes %s to strict-valid JSON Schema", (name, schema) => {
    const result = toStrictJsonSchema(schema, name.replace(/Schema$/, "").slice(0, 64));
    if (!result.ok) {
      throw new Error(
        `${name} did not normalize:\n${result.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`,
      );
    }
    expect(strictViolations(result.value.schema)).toEqual([]);
  });

  it("keeps recursive models expressible via $defs", () => {
    const result = toStrictJsonSchema(SharedTypes.DiagramASTSchema, "diagram_ast");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // DiagramObject nests itself; the round trip must preserve the $ref target
    // rather than inlining forever or dropping the branch.
    expect(JSON.stringify(result.value.schema)).toContain("$ref");
    expect(result.value.schema["$defs"]).toBeDefined();
  });

  it("drops open-ended maps and says which ones it dropped", () => {
    const result = toStrictJsonSchema(SharedTypes.VILSchema, "vil");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `context`, `metadata` and per-object `parameters` are free-form records.
    expect(result.value.droppedPaths).toContain("context");
    expect(result.value.droppedPaths).toContain("metadata");
    expect(result.value.droppedPaths.length).toBeGreaterThan(0);
  });

  it("makes optional properties required-and-nullable, and records them", () => {
    const schema = z.object({ a: z.string(), b: z.string().optional() });
    const result = toStrictJsonSchema(schema, "opt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const properties = result.value.schema["properties"] as JsonSchema;
    expect(result.value.schema["required"]).toEqual(["a", "b"]);
    expect((properties["b"] as JsonSchema)["type"]).toEqual(["string", "null"]);
    expect(result.value.nullablePaths).toEqual(["b"]);
  });

  it("rejects a REQUIRED open-ended map rather than silently dropping it", () => {
    const schema = z.object({ bag: z.record(z.string(), z.unknown()) });
    const result = toStrictJsonSchema(schema, "bad");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("PROVIDER_SCHEMA_UNREPRESENTABLE");
    expect(result.errors[0]?.path).toBe("bag");
  });

  it("rejects a non-object root", () => {
    const result = toStrictJsonSchema(z.array(z.string()), "arr");
    expect(result.ok).toBe(false);
  });

  it("rejects names providers will not accept", () => {
    expect(toStrictJsonSchema(z.object({ a: z.string() }), "has spaces").ok).toBe(false);
    expect(toStrictJsonSchema(z.object({ a: z.string() }), "a".repeat(65)).ok).toBe(false);
    expect(toStrictJsonSchema(z.object({ a: z.string() }), "ok_name-1").ok).toBe(true);
  });

  it("converts const to enum", () => {
    const result = toStrictJsonSchema(z.object({ v: z.literal("1.0") }), "lit");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const properties = result.value.schema["properties"] as JsonSchema;
    expect((properties["v"] as JsonSchema)["enum"]).toEqual(["1.0"]);
  });
});

describe("the premise that stripping nulls is safe", () => {
  /**
   * `decodeStrictOutput` deletes every null because our models express absence
   * as `undefined`. The moment someone adds `.nullable()` to a shared model,
   * that stops being true and this test is how we find out -- before a null
   * that meant something gets silently dropped.
   */
  it("no shared-types model admits null", () => {
    const offenders: string[] = [];
    for (const [name, schema] of objectRootedSchemas()) {
      const json = JSON.stringify(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
      if (json.includes('"null"')) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});

describe("decodeStrictOutput", () => {
  it("removes nulls at every depth, including inside arrays", () => {
    const decoded = decodeStrictOutput({
      keep: "yes",
      drop: null,
      nested: { keep: 1, drop: null },
      list: [{ keep: true, drop: null }],
    });
    expect(decoded).toEqual({
      keep: "yes",
      nested: { keep: 1 },
      list: [{ keep: true }],
    });
  });

  it("leaves non-null falsy values alone", () => {
    expect(decodeStrictOutput({ zero: 0, empty: "", no: false })).toEqual({
      zero: 0,
      empty: "",
      no: false,
    });
  });
});
