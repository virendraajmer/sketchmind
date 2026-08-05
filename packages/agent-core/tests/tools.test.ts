/**
 * The tool registry (Phase 4, D-2).
 *
 * A tool is defined once, in Zod. The JSON Schema the model sees is derived from
 * it, so a tool whose prompt schema and runtime validation disagree is not a bug
 * that can be written here.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry, defineTool } from "../src/tools.js";

const drawShape = defineTool({
  name: "draw_shape",
  description: "Draw a labelled shape on the whiteboard.",
  locus: "server",
  argsSchema: z.object({
    shape: z.enum(["circle", "square", "triangle"]),
    label: z.string().min(1),
  }),
  handler: async (args) => ({ drawn: args.shape, label: args.label }),
});

const lookUp = defineTool({
  name: "look_up",
  description: "Look something up. Changes nothing.",
  locus: "server",
  readOnly: true,
  argsSchema: z.object({ query: z.string() }),
  handler: async () => ({ found: false }),
});

const highlight = defineTool({
  name: "highlight_object",
  description: "Highlight an object in the browser.",
  locus: "client",
  argsSchema: z.object({ id: z.string() }),
  handler: async () => ({ highlighted: true }),
});

describe("defineTool", () => {
  it("derives the model-facing JSON Schema from the Zod schema", () => {
    expect(drawShape.parameters).toMatchObject({
      type: "object",
      properties: {
        shape: { enum: ["circle", "square", "triangle"] },
        label: expect.objectContaining({ type: "string" }),
      },
    });
    expect(drawShape.parameters.required).toEqual(
      expect.arrayContaining(["shape", "label"]),
    );
  });

  it("defaults readOnly to false, because assuming a tool is safe is the wrong default", () => {
    expect(drawShape.readOnly).toBe(false);
    expect(lookUp.readOnly).toBe(true);
  });

  it("produces a ToolSpec that survives serialization to the browser", () => {
    const spec = JSON.parse(JSON.stringify(drawShape.spec)) as Record<string, unknown>;
    expect(spec).toMatchObject({
      name: "draw_shape",
      description: "Draw a labelled shape on the whiteboard.",
      locus: "server",
      readOnly: false,
    });
    // The handler must NOT come along -- that is the whole point of the
    // ToolSpec / ToolDefinition split (shared-types agent.ts).
    expect(spec).not.toHaveProperty("handler");
    expect(spec).not.toHaveProperty("argsSchema");
  });

  it("rejects a name the providers cannot express", () => {
    expect(() =>
      defineTool({
        name: "draw shape!",
        description: "…",
        locus: "server",
        argsSchema: z.object({}),
        handler: async () => null,
      }),
    ).toThrow(/name/i);
  });

  it("rejects a schema that is not an object at the root", () => {
    expect(() =>
      defineTool({
        // Every provider models tool arguments as a named-property object.
        name: "bad_root",
        description: "…",
        locus: "server",
        argsSchema: z.string() as unknown as z.ZodObject<z.ZodRawShape>,
        handler: async () => null,
      }),
    ).toThrow(/object/i);
  });
});

describe("ToolRegistry", () => {
  it("registers and retrieves by name", () => {
    const registry = new ToolRegistry([drawShape, lookUp]);
    expect(registry.get("draw_shape")?.name).toBe("draw_shape");
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.size).toBe(2);
  });

  it("refuses a duplicate name instead of silently shadowing", () => {
    const registry = new ToolRegistry([drawShape]);
    // Two tools with one name means the model's choice is ambiguous and the
    // winner depends on registration order. That is a startup error, not a
    // runtime surprise.
    expect(() => registry.register(drawShape)).toThrow(/already registered/i);
  });

  it("lists specs filtered by locus, so each side advertises only what it can run", () => {
    const registry = new ToolRegistry([drawShape, lookUp, highlight]);
    expect(registry.specs("server").map((s) => s.name)).toEqual(["draw_shape", "look_up"]);
    expect(registry.specs("client").map((s) => s.name)).toEqual(["highlight_object"]);
    expect(registry.specs().map((s) => s.name)).toHaveLength(3);
  });

  it("emits the ToolCallSpec shape the provider interface expects", () => {
    const registry = new ToolRegistry([drawShape]);
    const [spec] = registry.toolCallSpecs("server");
    expect(spec).toEqual({
      name: "draw_shape",
      description: "Draw a labelled shape on the whiteboard.",
      parameters: drawShape.parameters,
    });
  });

  it("names the available tools when asked, for the 'no such tool' observation", () => {
    const registry = new ToolRegistry([drawShape, lookUp]);
    expect(registry.names()).toEqual(["draw_shape", "look_up"]);
  });
});
