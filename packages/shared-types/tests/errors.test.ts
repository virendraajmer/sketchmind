import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  SketchMindErrorSchema,
  makeError,
  errorsFromZod,
  ok,
  fail,
  parseWith,
} from "../src/index";

describe("SketchMindError", () => {
  it("carries the Volume 12 contract fields", () => {
    const err = makeError({
      code: "AST_DUPLICATE_ID",
      message: "Duplicate object id 'pulley'.",
      package: "@sketchmind/diagram-ast",
      stage: "diagram-ast",
      recoverable: true,
    });

    expect(SketchMindErrorSchema.parse(err)).toEqual(err);
    expect(err).toMatchObject({
      code: "AST_DUPLICATE_ID",
      package: "@sketchmind/diagram-ast",
      stage: "diagram-ast",
      recoverable: true,
    });
  });

  it("survives JSON round-tripping, because it crosses the wire to the client agent", () => {
    const err = makeError({
      code: "X",
      message: "m",
      package: "p",
      stage: "layout",
      recoverable: false,
      path: "objects[2].id",
    });

    const revived: unknown = JSON.parse(JSON.stringify(err));
    expect(revived).toEqual(err);
    expect(SketchMindErrorSchema.parse(revived).path).toBe("objects[2].id");
  });

  it("is a plain object, not an Error subclass", () => {
    const err = makeError({
      code: "X",
      message: "m",
      package: "p",
      stage: "intent",
      recoverable: false,
    });
    expect(err).not.toBeInstanceOf(Error);
  });
});

describe("errorsFromZod", () => {
  const schema = z.object({
    id: z.string(),
    nested: z.object({ count: z.number() }),
  });

  it("returns every issue at once, not just the first", () => {
    const result = schema.safeParse({ id: 42, nested: { count: "no" } });
    expect(result.success).toBe(false);

    const errors = errorsFromZod(result.error!, {
      package: "@sketchmind/shared-types",
      stage: "diagram-ast",
    });

    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.code === "SCHEMA_INVALID")).toBe(true);
  });

  it("records a dotted path so the agent knows where to look", () => {
    const result = schema.safeParse({ id: "a", nested: { count: "no" } });
    const errors = errorsFromZod(result.error!, {
      package: "p",
      stage: "diagram-ast",
    });

    expect(errors[0]?.path).toBe("nested.count");
  });

  it("uses an empty path for a root-level failure", () => {
    const result = schema.safeParse("not an object");
    const errors = errorsFromZod(result.error!, { package: "p", stage: "intent" });
    expect(errors[0]?.path).toBe("");
  });

  it("marks schema failures recoverable, because the agent can retry with a fix", () => {
    const result = schema.safeParse({});
    const errors = errorsFromZod(result.error!, { package: "p", stage: "intent" });
    expect(errors.every((e) => e.recoverable)).toBe(true);
  });
});

describe("ValidationResult", () => {
  it("narrows on ok", () => {
    const r = ok(7);
    if (r.ok) expect(r.value).toBe(7);
    else throw new Error("expected ok");
  });

  it("narrows on fail and holds every error", () => {
    const r = fail([
      makeError({ code: "A", message: "a", package: "p", stage: "intent", recoverable: true }),
      makeError({ code: "B", message: "b", package: "p", stage: "intent", recoverable: true }),
    ]);
    if (r.ok) throw new Error("expected fail");
    expect(r.errors.map((e) => e.code)).toEqual(["A", "B"]);
  });
});

describe("parseWith", () => {
  const schema = z.object({ id: z.string() });

  it("returns ok with the parsed value", () => {
    const r = parseWith(schema, { id: "a" }, { package: "p", stage: "intent" });
    expect(r).toEqual({ ok: true, value: { id: "a" } });
  });

  it("returns structured errors instead of throwing", () => {
    const r = parseWith(schema, { id: 1 }, { package: "p", stage: "intent" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.stage).toBe("intent");
      expect(r.errors[0]?.path).toBe("id");
    }
  });
});
