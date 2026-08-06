/**
 * Phase 7 acceptance: Diagram AST -> Constraint Graph -> Layout Model ->
 * Stroke AST -> playback, run through the real packages end to end.
 *
 * The per-package suites check each stage in isolation. This one checks what the
 * phase actually claims: that the movable-pulley AST every phase since 5 has
 * used comes out the far end as a drawing sequence a teacher would recognise,
 * plays deterministically, and survives undo/redo without collateral damage.
 */
import { describe, it, expect } from "vitest";
import { buildDiagramAST } from "@sketchmind/diagram-ast";
import { deriveConstraintGraph } from "@sketchmind/constraint-engine";
import { solveLayout } from "@sketchmind/layout-engine";
import { planStrokes, optimizeStrokes } from "@sketchmind/stroke-planner";
import { createStrokeRuntime, type StrokeRuntime } from "@sketchmind/stroke-runtime";
import type { DiagramObject, StrokeAST } from "@sketchmind/shared-types";

function unwrap<T>(result: { ok: boolean; value?: T; errors?: readonly unknown[] }): T {
  if (!result.ok) throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors, null, 2)}`);
  return result.value as T;
}

function object(id: string, type: string, name: string, anchors: string[] = [], labels: string[] = []): DiagramObject {
  return {
    id,
    type,
    name,
    category: "mechanical",
    anchors: anchors.map((a) => ({ name: a })),
    behaviors: [],
    labels: labels.map((text, index) => ({ id: `${id}_label_${index}`, text })),
    children: [],
  };
}

/** Same fixture as `tests/layout-pipeline.test.ts` and `tests/reasoning-pipeline.test.ts`. */
const PULLEY_AST = {
  id: "movable_pulley",
  subject: "movable pulley system",
  title: "Movable Pulley",
  category: "schematic" as const,
  objects: [
    object("ceiling", "surface", "Ceiling", ["mount"]),
    object("fixed_pulley", "pulley", "Fixed Pulley", ["axle", "rim"], ["Fixed pulley"]),
    object("movable_pulley", "pulley", "Movable Pulley", ["axle", "rim"], ["Movable pulley"]),
    object("rope", "rope", "Rope", ["free_end", "dead_end"]),
    object("load", "mass", "Load", ["hook"], ["Load"]),
  ],
  relationships: [
    { id: "r1", type: "attachedTo" as const, from: "fixed_pulley", to: "ceiling", fromAnchor: "axle", toAnchor: "mount" },
    { id: "r2", type: "wraps" as const, from: "rope", to: "fixed_pulley", toAnchor: "rim" },
    { id: "r3", type: "wraps" as const, from: "rope", to: "movable_pulley", toAnchor: "rim" },
    { id: "r4", type: "connectedTo" as const, from: "movable_pulley", to: "load", toAnchor: "hook" },
  ],
  groups: [],
  annotations: [],
};

function planPulley(): StrokeAST {
  const ast = unwrap(buildDiagramAST(PULLEY_AST));
  const graph = unwrap(deriveConstraintGraph(ast));
  const layout = unwrap(solveLayout(ast, graph));
  return unwrap(planStrokes(ast, layout));
}

const phaseOf = (metadata: Record<string, unknown> | undefined): string => String(metadata?.["phase"]);

describe("Phase 7: Layout Model -> Stroke AST", () => {
  it("draws the pulley in the order a teacher would: structure, then joins, then labels", () => {
    const strokes = planPulley().strokes;

    // Volume 06's own worked example: ceiling, pulleys, rope, load -- then the
    // connectors (the rope's joins and the force arrows), then labels last.
    const objectOrder = strokes.filter((s) => phaseOf(s.metadata) === "outline").map((s) => s.target);
    expect(objectOrder).toEqual(["ceiling", "fixed_pulley", "movable_pulley", "rope", "load"]);

    const phases = strokes.map((s) => phaseOf(s.metadata));
    const firstConnector = phases.indexOf("connector");
    const firstLabel = phases.indexOf("label");
    expect(firstConnector).toBeGreaterThan(phases.lastIndexOf("outline"));
    expect(firstLabel).toBeGreaterThan(firstConnector);
    expect(phases.lastIndexOf("label")).toBe(phases.length - 1);
  });

  it("draws every object and every connector exactly once", () => {
    const strokes = planPulley().strokes;

    const drawn = strokes.filter((s) => phaseOf(s.metadata) === "outline").map((s) => s.target);
    expect([...drawn].sort()).toEqual(PULLEY_AST.objects.map((o) => o.id).sort());

    const connectors = strokes
      .filter((s) => phaseOf(s.metadata) === "connector")
      .map((s) => s.metadata?.["relationshipId"]);
    expect([...connectors].sort()).toEqual(["r1", "r2", "r3", "r4"]);

    const labels = strokes.filter((s) => phaseOf(s.metadata) === "label");
    expect(labels.map((s) => s.text)).toEqual(["Fixed pulley", "Movable pulley", "Load"]);
  });

  it("is deterministic: the same request planned twice is byte-identical (AD-6)", () => {
    expect(JSON.stringify(planPulley())).toBe(JSON.stringify(planPulley()));
  });

  it("never lets the optimizer change which objects are drawn (object-coverage diff)", () => {
    const ast = unwrap(buildDiagramAST(PULLEY_AST));
    const graph = unwrap(deriveConstraintGraph(ast));
    const layout = unwrap(solveLayout(ast, graph));

    const unoptimized = unwrap(planStrokes(ast, layout, { optimize: false }));
    const optimized = unwrap(optimizeStrokes(unoptimized));

    const coverage = (strokes: StrokeAST["strokes"]): string[] =>
      [...new Set(strokes.map((s) => `${s.target}:${s.type}`))].sort();
    expect(coverage(optimized.strokes)).toEqual(coverage(unoptimized.strokes));
    expect(optimized.strokes.length).toBeLessThanOrEqual(unoptimized.strokes.length);
  });

  it("keeps the four pipeline models distinct -- no renderer commands reach the Stroke AST", () => {
    const serialized = JSON.stringify(planPulley());
    expect(serialized).not.toMatch(/Konva|ctx\.|<svg|beginPath|moveTo|lineTo|#[0-9a-fA-F]{6}/);
  });
});

describe("Phase 7: playback over the pulley drawing", () => {
  function runtime(): StrokeRuntime {
    return unwrap(createStrokeRuntime(planPulley()));
  }

  it("plays, pauses mid-sequence, resumes, and replays deterministically", () => {
    const script: Array<(r: StrokeRuntime) => void> = [
      (r) => r.play(),
      (r) => void r.advance(900),
      (r) => r.pause(),
      (r) => void r.advance(5000),
      (r) => r.resume(),
      (r) => void r.advance(1500),
      (r) => r.replay(),
      (r) => void r.advance(2400),
    ];

    const transcribe = (): string => {
      const r = runtime();
      const frames = script.map((step) => {
        step(r);
        const frame = r.frame();
        return {
          state: r.state(),
          completed: frame.completed.map((s) => s.id),
          inProgress: frame.inProgress && { id: frame.inProgress.stroke.id, points: frame.inProgress.points },
        };
      });
      return JSON.stringify(frames);
    };

    expect(transcribe()).toBe(transcribe());
  });

  it("pauses mid-stroke with a partially drawn path, not a half-drawn diagram", () => {
    const r = runtime();
    r.play();
    r.advance(r.state().totalDurationMs / 3);
    r.pause();

    const frame = r.frame();
    expect(r.state().status).toBe("paused");
    if (frame.inProgress) {
      expect(frame.inProgress.points.length).toBeLessThanOrEqual(frame.inProgress.stroke.points.length);
      expect(frame.inProgress.points[0]).toEqual(frame.inProgress.stroke.points[0]);
    }
    expect(frame.completed.length + (frame.inProgress ? 1 : 0) + frame.pending).toBe(
      r.state().strokeCount,
    );
  });

  it("undoes exactly the last stroke and redoes it with no side effects", () => {
    const r = runtime();
    const before = JSON.stringify(r.strokes());
    const last = r.strokes()[r.strokes().length - 1]!;

    const removed = r.undo()!;
    expect(removed.id).toBe(last.id);
    expect(r.strokes()).toHaveLength(JSON.parse(before).length - 1);
    expect(JSON.stringify(r.strokes())).toBe(
      JSON.stringify(JSON.parse(before).slice(0, -1)),
    );

    expect(r.redo()!.id).toBe(last.id);
    expect(JSON.stringify(r.strokes())).toBe(before);
  });

  it("reaches completion with every stroke drawn", () => {
    const r = runtime();
    r.play();
    r.advance(r.state().totalDurationMs + 1);
    expect(r.state().status).toBe("completed");
    expect(r.frame().completed).toHaveLength(r.state().strokeCount);
    expect(r.frame().pending).toBe(0);
  });
});
