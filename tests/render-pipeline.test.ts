/**
 * Phase 8 acceptance: Diagram AST -> Constraint Graph -> Layout Model -> Stroke
 * AST -> playback -> **pixels**, run through the real packages end to end.
 *
 * The per-package suites check each stage in isolation. This one checks what the
 * phase actually claims: that the movable-pulley diagram every phase since 5 has
 * used comes out the far end as an image, drawn in the right order, in the right
 * places, clickable, and exportable.
 *
 * Konva rasterises for real here (Phase 8 D-9) -- `tests/support/headless.ts`
 * points it at `node-canvas`, and every assertion below decodes actual PNG bytes.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDiagramAST } from "@sketchmind/diagram-ast";
import { deriveConstraintGraph } from "@sketchmind/constraint-engine";
import { solveLayout } from "@sketchmind/layout-engine";
import { planStrokes } from "@sketchmind/stroke-planner";
import { createStrokeRuntime, type StrokeRuntime } from "@sketchmind/stroke-runtime";
import { createKonvaRenderer } from "@sketchmind/renderer-konva";
import { createSvgRenderer } from "@sketchmind/renderer-svg";
import { exportJSON, exportPNG, exportReplayPackage } from "@sketchmind/export-engine";
import {
  distanceToPolyline,
  resolveStroke,
  DEFAULT_THEME,
  type RendererAdapter,
  type RenderFrame,
} from "@sketchmind/renderer-core";
import type { DiagramObject, LayoutModel, StrokeAST } from "@sketchmind/shared-types";
import { decodePNG, diffBitmaps, inkCount, inkInRect, type Bitmap } from "./support/png.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const BASELINE = join(FIXTURES, "pulley-baseline.png");

const CANVAS = { width: 640, height: 480 };

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

/** Same fixture as every pipeline test since Phase 5. */
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

let LAYOUT: LayoutModel;
let STROKES: StrokeAST;

beforeAll(() => {
  const ast = unwrap(buildDiagramAST(PULLEY_AST));
  const graph = unwrap(deriveConstraintGraph(ast));
  LAYOUT = unwrap(solveLayout(ast, graph));
  STROKES = unwrap(planStrokes(ast, LAYOUT));
});

const live: RendererAdapter[] = [];
afterEach(() => {
  while (live.length > 0) live.pop()!.destroy();
});

function mountKonva(options: { hiddenLayers?: readonly ("labels" | "shapes")[] } = {}): RendererAdapter {
  const adapter = unwrap(
    createKonvaRenderer({
      size: CANVAS,
      pixelRatio: 1,
      ...(options.hiddenLayers ? { hiddenLayers: options.hiddenLayers } : {}),
    }),
  );
  live.push(adapter);
  adapter.fitToContent(STROKES.bounds);
  return adapter;
}

function runtime(): StrokeRuntime {
  return unwrap(createStrokeRuntime(STROKES, { sessionId: "phase8" }));
}

/** Drive playback to completion at a fixed step -- no timers anywhere (Phase 7 D-8). */
function drawEverything(adapter: RendererAdapter): StrokeRuntime {
  const player = runtime();
  player.play();
  while (player.state().status === "playing") player.advance(50);
  adapter.renderFrame(player.frame());
  return player;
}

async function capture(adapter: RendererAdapter): Promise<Bitmap> {
  return decodePNG(unwrap(adapter.captureImage()).data);
}

describe("Phase 8: Stroke AST -> pixels", () => {
  it("the runtime's DrawingFrame satisfies the renderer's RenderFrame (D-2)", () => {
    // The renderer may not import `stroke-runtime` -- that is an upward
    // dependency and a CI failure -- so the two names were independently
    // declared twins, and this assignment was what stopped them drifting.
    // Phase 9 put the frame on the wire, so it became one schema in
    // `shared-types` (which both layers already depend on) and both names are
    // now aliases of it. The assignment is kept: it is the check that would
    // catch either package reintroducing a local declaration.
    const frame: RenderFrame = runtime().frame();
    expect(frame.completed).toBeDefined();
    expect(frame.pending).toBeGreaterThan(0);
  });

  it("draws the pulley in planned order, one node per stroke", () => {
    const adapter = mountKonva();
    drawEverything(adapter);

    const drawn = adapter.displayStrokes();
    expect(drawn).toHaveLength(STROKES.strokes.length);
    expect(drawn.map((stroke) => stroke.id)).toEqual(STROKES.strokes.map((stroke) => stroke.id));

    // Volume 06's teaching order survives all the way to the surface.
    const objects = drawn.filter((s) => s.layer === "shapes").map((s) => s.objectId);
    expect([...new Set(objects)]).toEqual([
      "ceiling",
      "fixed_pulley",
      "movable_pulley",
      "rope",
      "load",
    ]);
    expect(drawn.at(-1)?.layer).toBe("labels");
  });

  it("matches the reference PNG within pixel-diff tolerance (D-8)", async () => {
    // Text is excluded from the baseline: font rasterisation differs across OS
    // font stacks, and a baseline that fails on someone else's machine gets
    // deleted within a week. Labels are asserted structurally below instead.
    const adapter = mountKonva({ hiddenLayers: ["labels"] });
    drawEverything(adapter);
    const rendered = unwrap(adapter.captureImage()).data;

    if (!existsSync(BASELINE)) {
      mkdirSync(FIXTURES, { recursive: true });
      writeFileSync(BASELINE, rendered);
      console.warn(`Phase 8: wrote a new render baseline at ${BASELINE}. Review it before committing.`);
    }

    const diff = diffBitmaps(await decodePNG(rendered), await decodePNG(readFileSync(BASELINE)));
    expect(diff.comparable).toBe(true);
    expect(diff.ratio).toBeLessThan(0.005);
  });

  it("renders every label, at the point the planner put it", () => {
    const adapter = mountKonva();
    drawEverything(adapter);
    const labels = adapter.displayStrokes().filter((stroke) => stroke.type === "text");
    expect(labels.map((label) => label.text).sort()).toEqual([
      "Fixed pulley",
      "Load",
      "Movable pulley",
    ]);
    for (const label of labels) {
      const planned = STROKES.strokes.find((stroke) => stroke.id === label.id)!;
      expect(label.points[0]).toEqual(planned.points[0]);
    }
  });
});

describe("play, pause, resume visibly control the drawing", () => {
  it("adds ink while playing, freezes while paused, and resumes from where it stopped", async () => {
    const adapter = mountKonva();
    const player = runtime();
    player.play();

    for (let i = 0; i < 6; i += 1) player.advance(50);
    adapter.renderFrame(player.frame());
    const early = inkCount(await capture(adapter));
    const drawnEarly = adapter.displayStrokes().length;
    expect(early).toBeGreaterThan(0);

    for (let i = 0; i < 6; i += 1) player.advance(50);
    adapter.renderFrame(player.frame());
    const later = inkCount(await capture(adapter));
    expect(later).toBeGreaterThan(early);

    player.pause();
    for (let i = 0; i < 10; i += 1) player.advance(50);
    adapter.renderFrame(player.frame());
    const paused = inkCount(await capture(adapter));
    // Paused means paused: the clock does not move, so neither do the pixels.
    expect(paused).toBe(later);

    player.resume();
    for (let i = 0; i < 6; i += 1) player.advance(50);
    adapter.renderFrame(player.frame());
    expect(inkCount(await capture(adapter))).toBeGreaterThan(paused);
    expect(adapter.displayStrokes().length).toBeGreaterThan(drawnEarly);
  });

  it("seeking backwards removes strokes rather than leaving them behind", async () => {
    const adapter = mountKonva();
    const player = drawEverything(adapter);
    const complete = inkCount(await capture(adapter));

    player.seek(player.state().totalDurationMs * 0.3);
    adapter.renderFrame(player.frame());
    const partial = inkCount(await capture(adapter));
    expect(partial).toBeLessThan(complete);

    player.seek(player.state().totalDurationMs);
    adapter.renderFrame(player.frame());
    expect(inkCount(await capture(adapter))).toBe(complete);
  });

  it("replays to identical pixels -- determinism survives rasterisation", async () => {
    const first = mountKonva();
    drawEverything(first);
    const before = await capture(first);

    const second = mountKonva();
    drawEverything(second);
    const after = await capture(second);

    expect(diffBitmaps(before, after).differing).toBe(0);
  });
});

/**
 * A point unambiguously on `objectId`: one of its own vertices, chosen to be as
 * far as possible from every *other* object's ink.
 *
 * Picking a corner of the layout box instead looks tidier and tests less: in the
 * pulley diagram the rope runs through several boxes, so a fixed corner probe
 * lands on two objects at once and asserts nothing about hit-testing -- only
 * about which of two coincident strokes happened to sort first.
 */
function unambiguousProbe(adapter: RendererAdapter, objectId: string): { x: number; y: number } {
  const own = adapter.displayStrokes().filter((stroke) => stroke.objectId === objectId);
  const others = adapter.displayStrokes().filter((stroke) => stroke.objectId !== objectId);
  let best: { point: { x: number; y: number }; clearance: number } | null = null;
  for (const stroke of own) {
    for (const point of stroke.points) {
      const clearance = Math.min(
        ...others.map((other) => distanceToPolyline(point, other.points)),
        Number.POSITIVE_INFINITY,
      );
      if (!best || clearance > best.clearance) best = { point, clearance };
    }
  }
  if (!best) throw new Error(`no strokes drawn for ${objectId}`);
  expect(best.clearance, `${objectId} has no ink of its own to click`).toBeGreaterThan(8);
  return best.point;
}

describe("hit-testing returns the object that was clicked (required for Phase 11)", () => {
  it("names the object whose ink is under the probe", () => {
    const adapter = mountKonva();
    drawEverything(adapter);

    for (const id of ["ceiling", "fixed_pulley", "movable_pulley", "rope", "load"]) {
      const hit = adapter.hitTest(unambiguousProbe(adapter, id), { tolerance: 6 });
      expect(hit?.objectId, `probing ${id}`).toBe(id);
      // The stroke id comes back too, which is what an editing tool needs.
      expect(hit?.strokeId).toBeTruthy();
    }
  });

  it("takes layout-space coordinates, so a browser click must go through toWorld", () => {
    const adapter = mountKonva();
    drawEverything(adapter);
    const world = unambiguousProbe(adapter, "load");

    const screen = adapter.viewport().toScreen(world);
    expect(adapter.hitTest(adapter.viewport().toWorld(screen), { tolerance: 6 })?.objectId).toBe("load");
    // Feeding screen pixels straight in is the bug this exists to prevent.
    expect(adapter.hitTest(screen, { tolerance: 6 })?.objectId).not.toBe("load");
  });

  it("returns nothing where there is no ink", () => {
    const adapter = mountKonva();
    drawEverything(adapter);
    expect(adapter.hitTest({ x: -5000, y: -5000 })).toBeNull();
  });
});

describe("export", () => {
  it("produces a PNG containing every drawn object (not just a non-empty file)", async () => {
    const adapter = mountKonva();
    drawEverything(adapter);

    const png = unwrap(exportPNG(adapter));
    expect(png.mimeType).toBe("image/png");
    const bitmap = await decodePNG(png.data);
    expect(bitmap.width).toBe(CANVAS.width);
    expect(bitmap.height).toBe(CANVAS.height);

    // Every object's layout box, mapped to screen space, must contain ink.
    for (const node of LAYOUT.nodes) {
      const topLeft = adapter.viewport().toScreen({ x: node.bounds.x, y: node.bounds.y });
      const bottomRight = adapter.viewport().toScreen({
        x: node.bounds.x + node.bounds.width,
        y: node.bounds.y + node.bounds.height,
      });
      const ink = inkInRect(bitmap, {
        x: topLeft.x - 2,
        y: topLeft.y - 2,
        width: bottomRight.x - topLeft.x + 4,
        height: bottomRight.y - topLeft.y + 4,
      });
      expect(ink, `no ink drawn for ${node.objectId}`).toBeGreaterThan(0);
    }
  });

  it("captureImage returns a usable buffer (required for Phase 10)", async () => {
    const adapter = mountKonva();
    drawEverything(adapter);
    const captured = unwrap(adapter.captureImage());
    const bitmap = await decodePNG(captured.data);
    expect(bitmap.width * bitmap.height).toBe(CANVAS.width * CANVAS.height);
    // Not a blank canvas: a vision critique needs something to look at.
    expect(inkCount(bitmap)).toBeGreaterThan(200);
  });

  it("exports JSON and a replay package that carry the whole sequence", () => {
    const json = JSON.parse(unwrap(exportJSON(STROKES)));
    expect(json.strokes).toHaveLength(STROKES.strokes.length);

    const adapter = mountKonva();
    drawEverything(adapter);
    const replay = unwrap(exportReplayPackage(STROKES, { adapter, now: () => "2026-08-06T00:00:00.000Z" }));
    expect(replay.strokeCount).toBe(STROKES.strokes.length);
    expect(replay.preview?.mimeType).toBe("image/png");
  });
});

describe("backend independence", () => {
  it("renderer-konva depends on nothing above the renderer layer", () => {
    const manifest = JSON.parse(
      readFileSync(join(HERE, "..", "packages", "renderer-konva", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const forbidden = Object.keys(manifest.dependencies ?? {}).filter((dep) =>
      /agent|intent|visual-planner|diagram|constraint|layout|stroke|orchestrator|llm/.test(dep),
    );
    expect(forbidden).toEqual([]);
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([
      "@sketchmind/renderer-core",
      "@sketchmind/shared-types",
      "konva",
    ]);
  });

  it("Konva and SVG draw the same geometry, not merely a similar picture (D-1)", () => {
    const konva = mountKonva();
    drawEverything(konva);

    const svg = unwrap(createSvgRenderer({ size: CANVAS }));
    live.push(svg);
    svg.renderFrame({ timeMs: 0, completed: STROKES.strokes, inProgress: null, pending: 0 });

    const konvaStrokes = konva.displayStrokes();
    const svgStrokes = svg.displayStrokes();
    expect(svgStrokes.map((s) => s.id)).toEqual(konvaStrokes.map((s) => s.id));
    for (let i = 0; i < konvaStrokes.length; i += 1) {
      expect(svgStrokes[i]!.points).toEqual(konvaStrokes[i]!.points);
      expect(svgStrokes[i]!.paint.color).toEqual(konvaStrokes[i]!.paint.color);
    }
  });

  it("jitter is reproduced from the stroke id alone, so any backend agrees", () => {
    const adapter = mountKonva();
    drawEverything(adapter);
    for (const drawn of adapter.displayStrokes()) {
      const planned = STROKES.strokes.find((stroke) => stroke.id === drawn.id)!;
      expect(drawn.points).toEqual(resolveStroke(planned, DEFAULT_THEME).points);
    }
  });
});
