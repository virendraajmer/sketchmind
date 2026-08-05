import { describe, it, expect } from "vitest";
import {
  DiagramASTSchema,
  DiagramObjectSchema,
  LayoutModelSchema,
  StrokeASTSchema,
  StrokeTypeSchema,
  FreeformShapeSchema,
  RuntimeEventSchema,
  AgentTraceSchema,
  AgentBudgetSchema,
  ToolSpecSchema,
  SCHEMA_VERSION,
  type RuntimeEvent,
} from "../src/index.js";

const ast = {
  id: "d1",
  version: SCHEMA_VERSION,
  subject: "pulley system",
  title: "Simple Pulley",
  category: "schematic",
  objects: [
    {
      id: "pulley",
      type: "pulley",
      name: "Fixed Pulley",
      category: "mechanical",
      anchors: [{ name: "rim" }],
      behaviors: ["rotate"],
      labels: [{ id: "l1", text: "Fixed Pulley" }],
      children: [{ id: "axle", type: "axle", name: "Axle", category: "mechanical" }],
    },
  ],
  relationships: [{ id: "r1", type: "attachedTo", from: "pulley", to: "ceiling" }],
} as const;

describe("DiagramAST", () => {
  it("accepts the Volume 04 root structure", () => {
    expect(DiagramASTSchema.parse(ast)).toMatchObject({ id: "d1", subject: "pulley system" });
  });

  it("nests objects, so a composite owns its own parts", () => {
    const parsed = DiagramASTSchema.parse(ast);
    expect(parsed.objects[0]?.children[0]?.id).toBe("axle");
  });

  it("nests recursively to arbitrary depth", () => {
    const deep = DiagramObjectSchema.parse({
      id: "a",
      type: "t",
      name: "A",
      category: "c",
      children: [
        { id: "b", type: "t", name: "B", category: "c", children: [{ id: "c", type: "t", name: "C", category: "c" }] },
      ],
    });
    expect(deep.children[0]?.children[0]?.id).toBe("c");
  });

  it("rejects an AST with no objects", () => {
    expect(DiagramASTSchema.safeParse({ ...ast, objects: [] }).success).toBe(false);
  });

  it("rejects an unrecognised schema version, so evolution is detectable", () => {
    expect(DiagramASTSchema.safeParse({ ...ast, version: "0.9" }).success).toBe(false);
  });

  it("fills nested metadata defaults when metadata is omitted entirely", () => {
    const parsed = DiagramASTSchema.parse(ast);
    expect(parsed.metadata.tags).toEqual([]);
  });

  it("carries style hints that are semantic, never visual", () => {
    const parsed = DiagramASTSchema.parse({
      ...ast,
      objects: [{ ...ast.objects[0], style: { emphasis: "strong", tone: "danger" } }],
    });
    expect(parsed.objects[0]?.style).toEqual({ emphasis: "strong", tone: "danger" });
    // A colour would make the AST renderer-specific; there is no field for one.
    expect(Object.keys(parsed.objects[0]?.style ?? {})).not.toContain("color");
  });
});

describe("LayoutModel", () => {
  const layout = {
    version: SCHEMA_VERSION,
    diagramId: "d1",
    strategy: "hierarchical",
    canvas: { width: 800, height: 600 },
    nodes: [
      {
        objectId: "pulley",
        position: { x: 100, y: 50 },
        size: { width: 60, height: 60 },
        bounds: { x: 100, y: 50, width: 60, height: 60 },
        anchors: [{ name: "rim", point: { x: 130, y: 50 } }],
      },
    ],
    connectors: [
      { relationshipId: "r1", routing: "orthogonal", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
    ],
  } as const;

  it("is allowed geometry -- it is the model that owns it", () => {
    const parsed = LayoutModelSchema.parse(layout);
    expect(parsed.nodes[0]?.position).toEqual({ x: 100, y: 50 });
  });

  it("defaults rotation and zIndex", () => {
    const parsed = LayoutModelSchema.parse(layout);
    expect(parsed.nodes[0]?.rotation).toBe(0);
    expect(parsed.nodes[0]?.zIndex).toBe(0);
  });

  it("rejects NaN and Infinity, which a solver can produce and a renderer cannot draw", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = LayoutModelSchema.safeParse({
        ...layout,
        nodes: [{ ...layout.nodes[0], position: { x: bad, y: 0 } }],
      });
      expect(r.success).toBe(false);
    }
  });

  it("rejects negative size", () => {
    const r = LayoutModelSchema.safeParse({
      ...layout,
      nodes: [{ ...layout.nodes[0], size: { width: -1, height: 10 } }],
    });
    expect(r.success).toBe(false);
  });

  it("requires at least two points on a connector -- one point is not a path", () => {
    const r = LayoutModelSchema.safeParse({
      ...layout,
      connectors: [{ relationshipId: "r1", routing: "straight", points: [{ x: 0, y: 0 }] }],
    });
    expect(r.success).toBe(false);
  });
});

describe("StrokeAST", () => {
  const strokes = {
    version: SCHEMA_VERSION,
    diagramId: "d1",
    strokes: [
      { id: "s1", type: "circle", target: "pulley", order: 0, points: [{ x: 0, y: 0 }] },
      { id: "s2", type: "text", target: "pulley", order: 1, points: [{ x: 5, y: 5 }], text: "P", dependencies: ["s1"] },
    ],
  } as const;

  it("supports all 12 Volume 06 stroke types", () => {
    expect(StrokeTypeSchema.options).toHaveLength(12);
    for (const t of ["line", "curve", "arc", "circle", "ellipse", "rectangle", "polygon", "freehand", "arrow", "text", "hatch", "erase"]) {
      expect(StrokeTypeSchema.options).toContain(t);
    }
  });

  it("applies pen and timing defaults, so the planner states only what differs", () => {
    const parsed = StrokeASTSchema.parse(strokes);
    expect(parsed.strokes[0]?.style).toMatchObject({ width: 2, ink: "pen", dashed: false });
    expect(parsed.strokes[0]?.timing).toMatchObject({ delayMs: 0, durationMs: 400 });
  });

  it("carries dependencies, so drawing order can express prerequisites", () => {
    const parsed = StrokeASTSchema.parse(strokes);
    expect(parsed.strokes[1]?.dependencies).toEqual(["s1"]);
  });

  it("keeps jitter within 0..1", () => {
    const r = StrokeASTSchema.safeParse({
      ...strokes,
      strokes: [{ ...strokes.strokes[0], style: { jitter: 5 } }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects a stroke with no points", () => {
    const r = StrokeASTSchema.safeParse({
      ...strokes,
      strokes: [{ ...strokes.strokes[0], points: [] }],
    });
    expect(r.success).toBe(false);
  });
});

describe("FreeformShape", () => {
  const bolt = {
    version: SCHEMA_VERSION,
    id: "f1",
    name: "lightning-bolt",
    parts: [
      { id: "p1", kind: "polygon", points: [{ u: 0.5, v: 0 }, { u: 0.2, v: 0.6 }, { u: 0.5, v: 0.6 }], closed: true },
    ],
    anchors: [{ name: "tip", at: { u: 0.5, v: 1 } }],
  } as const;

  it("composes a one-off shape without a primitive manifest", () => {
    expect(FreeformShapeSchema.parse(bolt)).toMatchObject({ name: "lightning-bolt" });
  });

  it("confines sub-parts to unit space, so they can never be board coordinates", () => {
    const r = FreeformShapeSchema.safeParse({
      ...bolt,
      parts: [{ id: "p1", kind: "line", points: [{ u: 340, v: 12 }] }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative unit coordinates too", () => {
    const r = FreeformShapeSchema.safeParse({
      ...bolt,
      parts: [{ id: "p1", kind: "line", points: [{ u: -0.1, v: 0.5 }] }],
    });
    expect(r.success).toBe(false);
  });

  it("requires at least one part", () => {
    expect(FreeformShapeSchema.safeParse({ ...bolt, parts: [] }).success).toBe(false);
  });
});

describe("RuntimeEvent", () => {
  it("discriminates on type", () => {
    const ev = RuntimeEventSchema.parse({
      type: "StrokeCompleted",
      sessionId: "s1",
      at: "2026-08-05T00:00:00Z",
      strokeId: "st1",
    });
    expect(ev.type).toBe("StrokeCompleted");
    if (ev.type === "StrokeCompleted") expect(ev.strokeId).toBe("st1");
  });

  it("exhausts in a switch, which is the point of the union", () => {
    const describeEvent = (e: RuntimeEvent): string => {
      switch (e.type) {
        case "SessionStarted": return "start";
        case "StageStarted":
        case "StageCompleted": return "stage";
        case "AgentStep": return `step:${e.locus}`;
        case "VisionCritique": return `vision:${e.accepted}`;
        case "StrokeStarted":
        case "StrokeCompleted": return "stroke";
        case "PlaybackPaused":
        case "PlaybackResumed": return "playback";
        case "SessionCompleted": return "done";
        case "SessionFailed": return e.error.code;
        case "SessionCancelled": return "cancelled";
      }
    };

    expect(describeEvent({ type: "AgentStep", sessionId: "s", at: "t", stepId: "1", locus: "client" })).toBe("step:client");
  });

  it("carries a structured error on failure, not a string", () => {
    const ev = RuntimeEventSchema.parse({
      type: "SessionFailed",
      sessionId: "s1",
      at: "t",
      error: { code: "E", message: "m", package: "p", stage: "layout", recoverable: false },
    });
    if (ev.type === "SessionFailed") expect(ev.error.recoverable).toBe(false);
  });

  it("rejects an unknown event type", () => {
    expect(RuntimeEventSchema.safeParse({ type: "Nope", sessionId: "s", at: "t" }).success).toBe(false);
  });
});

describe("agent models", () => {
  it("records a trace step with its cost", () => {
    const trace = AgentTraceSchema.parse({
      sessionId: "s1",
      steps: [
        { stepId: "1", locus: "server", toolName: "build_diagram", tokensIn: 100, tokensOut: 20, timestamp: "t" },
      ],
    });
    expect(trace.steps[0]).toMatchObject({ tokensIn: 100, tokensOut: 20, durationMs: 0 });
  });

  it("defaults budgets to the values in .env.example", () => {
    expect(AgentBudgetSchema.parse({})).toEqual({
      maxSteps: 40,
      maxTokens: 200_000,
      timeoutMs: 180_000,
    });
  });

  it("describes a tool without carrying its handler", () => {
    const spec = ToolSpecSchema.parse({
      name: "draw_shape",
      description: "Draw a shape on the board.",
      parameters: { type: "object", properties: {} },
      locus: "client",
    });
    expect(spec.readOnly).toBe(false);
    // The handler stays with whichever side executes it (see src/agent.ts).
    expect(spec).not.toHaveProperty("handler");
  });
});
