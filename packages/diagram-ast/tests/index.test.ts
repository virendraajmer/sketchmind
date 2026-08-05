import { describe, it, expect } from "vitest";
import { SCHEMA_VERSION, type DiagramAST } from "@sketchmind/shared-types";
import {
  PACKAGE_NAME,
  buildDiagramAST,
  validateDiagramAST,
  serializeDiagramAST,
  parseDiagramAST,
  collectObjects,
  findObject,
} from "../src/index.js";

const input = {
  id: "d1",
  subject: "pulley system",
  title: "Simple Pulley",
  category: "schematic",
  objects: [
    { id: "ceiling", type: "surface", name: "Ceiling", category: "structural" },
    {
      id: "pulley",
      type: "pulley",
      name: "Fixed Pulley",
      category: "mechanical",
      anchors: [{ name: "rim" }],
      children: [{ id: "axle", type: "axle", name: "Axle", category: "mechanical" }],
    },
  ],
  relationships: [{ id: "r1", type: "attachedTo", from: "pulley", to: "ceiling" }],
};

function build(overrides: Record<string, unknown> = {}) {
  return buildDiagramAST({ ...input, ...overrides });
}

function expectOk(result: ReturnType<typeof buildDiagramAST>): DiagramAST {
  if (!result.ok) throw new Error(`expected ok, got: ${JSON.stringify(result.errors, null, 2)}`);
  return result.value;
}

function expectFail(result: ReturnType<typeof buildDiagramAST>) {
  if (result.ok) throw new Error("expected failure, got a valid AST");
  return result.errors;
}

describe("package identity", () => {
  it("exposes its name", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/diagram-ast");
  });
});

describe("buildDiagramAST", () => {
  it("builds a valid AST and stamps the schema version", () => {
    const ast = expectOk(build());
    expect(ast.version).toBe(SCHEMA_VERSION);
    expect(ast.objects).toHaveLength(2);
  });

  it("returns structured errors instead of throwing", () => {
    const errors = expectFail(build({ objects: [] }));
    expect(errors[0]?.package).toBe("@sketchmind/diagram-ast");
    expect(errors[0]?.stage).toBe("diagram-ast");
    expect(typeof errors[0]?.path).toBe("string");
  });

  it("reports every schema problem at once, so the agent fixes them in one pass", () => {
    const errors = expectFail(
      buildDiagramAST({ id: "", subject: "", title: "", category: "nope", objects: [] }),
    );
    expect(errors.length).toBeGreaterThan(3);
  });
});

describe("semantic validation", () => {
  it("rejects a duplicate object id, including across nesting levels", () => {
    const errors = expectFail(
      build({
        objects: [
          input.objects[0],
          { ...input.objects[1], children: [{ id: "ceiling", type: "t", name: "N", category: "c" }] },
        ],
      }),
    );
    const dup = errors.find((e) => e.code === "AST_DUPLICATE_ID");
    expect(dup?.message).toContain("ceiling");
  });

  it("rejects a relationship pointing at a missing object", () => {
    const errors = expectFail(
      build({ relationships: [{ id: "r1", type: "attachedTo", from: "pulley", to: "ghost" }] }),
    );
    const err = errors.find((e) => e.code === "AST_UNKNOWN_REFERENCE");
    expect(err?.message).toContain("ghost");
    expect(err?.path).toBe("relationships[0].to");
  });

  it("rejects an orphan object -- present but connected to nothing", () => {
    const errors = expectFail(
      build({ objects: [...input.objects, { id: "lonely", type: "t", name: "Lonely", category: "c" }] }),
    );
    expect(errors.map((e) => e.code)).toContain("AST_ORPHAN_OBJECT");
  });

  it("does not call a single-object diagram an orphan", () => {
    expect(build({ objects: [input.objects[0]], relationships: [] }).ok).toBe(true);
  });

  it("treats a child as connected through its parent, not as an orphan", () => {
    const ast = expectOk(build());
    expect(ast.objects[1]?.children[0]?.id).toBe("axle");
  });

  it("counts a group as connectivity, since grouping is a stated relationship", () => {
    const result = build({
      objects: [...input.objects, { id: "bracket", type: "t", name: "Bracket", category: "c" }],
      groups: [{ id: "g1", name: "Assembly", members: ["pulley", "bracket"] }],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown relationship type", () => {
    expect(build({ relationships: [{ id: "r1", type: "orbits", from: "pulley", to: "ceiling" }] }).ok).toBe(false);
  });

  it("rejects a label anchor the object does not expose", () => {
    const errors = expectFail(
      build({
        objects: [
          input.objects[0],
          { ...input.objects[1], labels: [{ id: "l1", text: "rim", anchor: "nonexistent" }] },
        ],
      }),
    );
    expect(errors.map((e) => e.code)).toContain("AST_UNKNOWN_ANCHOR");
  });

  it("accepts a label anchor the object does expose", () => {
    const result = build({
      objects: [
        input.objects[0],
        { ...input.objects[1], labels: [{ id: "l1", text: "rim", anchor: "rim" }] },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a relationship anchor the endpoint does not expose", () => {
    const errors = expectFail(
      build({
        relationships: [
          { id: "r1", type: "attachedTo", from: "pulley", to: "ceiling", fromAnchor: "ghostAnchor" },
        ],
      }),
    );
    expect(errors.map((e) => e.code)).toContain("AST_UNKNOWN_ANCHOR");
  });

  it("rejects a group member that is not an object", () => {
    const errors = expectFail(build({ groups: [{ id: "g1", name: "A", members: ["pulley", "ghost"] }] }));
    expect(errors.map((e) => e.code)).toContain("AST_UNKNOWN_REFERENCE");
  });

  it("rejects an annotation targeting a missing object", () => {
    expect(build({ annotations: [{ id: "a1", target: "ghost", text: "note" }] }).ok).toBe(false);
  });

  it("rejects a duplicate relationship id", () => {
    const errors = expectFail(
      build({
        relationships: [
          { id: "r1", type: "attachedTo", from: "pulley", to: "ceiling" },
          { id: "r1", type: "above", from: "ceiling", to: "pulley" },
        ],
      }),
    );
    expect(errors.map((e) => e.code)).toContain("AST_DUPLICATE_ID");
  });

  it("rejects a self-referential relationship", () => {
    const errors = expectFail(
      build({ relationships: [{ id: "r1", type: "above", from: "pulley", to: "pulley" }] }),
    );
    expect(errors.map((e) => e.code)).toContain("AST_SELF_REFERENCE");
  });

  it("marks every semantic error recoverable, since the agent can correct and retry", () => {
    const errors = expectFail(
      build({ relationships: [{ id: "r1", type: "attachedTo", from: "pulley", to: "ghost" }] }),
    );
    expect(errors.every((e) => e.recoverable)).toBe(true);
  });

  it("collects multiple distinct semantic failures in one pass", () => {
    const errors = expectFail(
      build({
        objects: [...input.objects, { id: "lonely", type: "t", name: "L", category: "c" }],
        relationships: [{ id: "r1", type: "attachedTo", from: "pulley", to: "ghost" }],
      }),
    );
    const codes = new Set(errors.map((e) => e.code));
    expect(codes.has("AST_ORPHAN_OBJECT")).toBe(true);
    expect(codes.has("AST_UNKNOWN_REFERENCE")).toBe(true);
  });

  it("validates an already-built AST without rebuilding it", () => {
    const ast = expectOk(build());
    expect(validateDiagramAST(ast).ok).toBe(true);
  });
});

describe("serialization", () => {
  it("round-trips unchanged", () => {
    const ast = expectOk(build());
    const back = parseDiagramAST(serializeDiagramAST(ast));
    if (!back.ok) throw new Error("expected ok");
    expect(back.value).toEqual(ast);
  });

  it("serializes deterministically -- byte-identical for the same AST (AD-6)", () => {
    expect(serializeDiagramAST(expectOk(build()))).toBe(serializeDiagramAST(expectOk(build())));
  });

  it("orders keys stably regardless of input key order", () => {
    const a = expectOk(buildDiagramAST(input));
    const b = expectOk(
      buildDiagramAST({
        objects: input.objects,
        title: input.title,
        id: input.id,
        subject: input.subject,
        category: input.category,
        relationships: input.relationships,
      }),
    );
    expect(serializeDiagramAST(a)).toBe(serializeDiagramAST(b));
  });

  it("returns structured errors for malformed JSON rather than throwing", () => {
    const result = parseDiagramAST("{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("AST_MALFORMED_JSON");
  });
});

describe("traversal helpers", () => {
  it("collects nested objects depth-first", () => {
    expect(collectObjects(expectOk(build())).map((o) => o.id)).toEqual(["ceiling", "pulley", "axle"]);
  });

  it("finds a nested object by id", () => {
    expect(findObject(expectOk(build()), "axle")?.name).toBe("Axle");
  });

  it("returns undefined for a missing id", () => {
    expect(findObject(expectOk(build()), "nope")).toBeUndefined();
  });
});
