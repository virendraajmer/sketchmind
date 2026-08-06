import { describe, it, expect } from "vitest";
import type { Stroke } from "@sketchmind/shared-types";
import {
  applyJitter,
  displayBounds,
  hashStrokeId,
  hitTest,
  hitTestAll,
  hitTestRegion,
  layerForStroke,
  mulberry32,
  pathLength,
  resolveStroke,
  resolveTone,
  trimPolyline,
  DEFAULT_THEME,
  LAYER_ORDER,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  RendererRegistry,
  Scene,
  Viewport,
  mergeTheme,
} from "../src/index.js";
import type { RendererCapabilities, RendererFactory, RenderFrame } from "../src/index.js";

function stroke(overrides: Partial<Stroke> = {}): Stroke {
  return {
    id: "s1",
    type: "line",
    target: "obj_a",
    order: 0,
    dependencies: [],
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    style: {
      width: 2,
      jitter: 0,
      pressureProfile: "taperBoth",
      ink: "pen",
      dashed: false,
    },
    timing: { delayMs: 0, durationMs: 400, pauseAfterMs: 0 },
    ...overrides,
  };
}

describe("renderer-core package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/renderer-core");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});

describe("layer model (D-5)", () => {
  it("declares all eight of Volume 08's layers, back to front", () => {
    expect(LAYER_ORDER).toEqual([
      "background",
      "grid",
      "shapes",
      "connectors",
      "labels",
      "highlights",
      "animations",
      "debug",
    ]);
  });

  it("derives a stroke's layer from the drawing phase the planner stamped", () => {
    expect(layerForStroke(stroke({ metadata: { phase: "outline" } }))).toBe("shapes");
    expect(layerForStroke(stroke({ metadata: { phase: "detail" } }))).toBe("shapes");
    expect(layerForStroke(stroke({ metadata: { phase: "connector" } }))).toBe("connectors");
    expect(layerForStroke(stroke({ metadata: { phase: "annotation" } }))).toBe("labels");
    expect(layerForStroke(stroke({ metadata: { phase: "label" } }))).toBe("labels");
  });

  it("puts text on the labels layer whatever the phase claims, and defaults to shapes", () => {
    expect(layerForStroke(stroke({ type: "text", metadata: { phase: "outline" } }))).toBe("labels");
    expect(layerForStroke(stroke())).toBe("shapes");
  });
});

describe("jitter (D-3)", () => {
  const jittery = { width: 2, jitter: 0.5 };
  const square = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 50, y: 50 },
    { x: 0, y: 50 },
    { x: 0, y: 0 },
  ];

  it("is a pure function of the stroke id, not of call order", () => {
    const first = applyJitter(square, jittery, hashStrokeId("stroke_7"));
    const decoy = applyJitter(square, jittery, hashStrokeId("stroke_9"));
    const again = applyJitter(square, jittery, hashStrokeId("stroke_7"));
    expect(again).toEqual(first);
    expect(decoy).not.toEqual(first);
  });

  it("keeps a closed path closed", () => {
    const shaken = applyJitter(square, jittery, hashStrokeId("box"));
    expect(shaken[0]).toEqual(shaken[shaken.length - 1]);
  });

  it("pins the endpoints of an open path, so joins to other strokes survive", () => {
    const open = [
      { x: 0, y: 0 },
      { x: 30, y: 10 },
      { x: 60, y: 0 },
    ];
    const shaken = applyJitter(open, jittery, hashStrokeId("rope"));
    expect(shaken[0]).toEqual(open[0]);
    expect(shaken[shaken.length - 1]).toEqual(open[open.length - 1]);
    expect(shaken).not.toEqual(open);
  });

  it("leaves geometry untouched at jitter 0 -- a mechanical render is exact", () => {
    expect(applyJitter(square, { width: 2, jitter: 0 }, 1)).toEqual(square);
  });

  it("displaces by no more than the declared amplitude", () => {
    const straight = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ];
    const amplitude = 0.5 * 2 * 3; // jitter * width * JITTER_SCALE
    for (const point of applyJitter(straight, jittery, hashStrokeId("line"))) {
      expect(Math.abs(point.y)).toBeLessThanOrEqual(amplitude + 1e-9);
    }
  });

  it("hashes distinct ids to distinct seeds and produces a uniform-ish stream", () => {
    expect(hashStrokeId("a")).not.toBe(hashStrokeId("b"));
    const random = mulberry32(hashStrokeId("seed"));
    const draws = Array.from({ length: 500 }, () => random());
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
  });
});

describe("progressive geometry", () => {
  const path = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];

  it("cuts a polyline by arc length", () => {
    expect(pathLength(path)).toBe(200);
    expect(trimPolyline(path, 0.25)).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ]);
    expect(trimPolyline(path, 0.75)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
    ]);
  });

  it("clamps at both ends", () => {
    expect(trimPolyline(path, 0)).toEqual([{ x: 0, y: 0 }]);
    expect(trimPolyline(path, 1)).toEqual(path);
    expect(trimPolyline(path, 4)).toEqual(path);
  });

  it("cuts the jittered path rather than jittering the prefix, so shake never settles", () => {
    const shaky = stroke({ style: { ...stroke().style, jitter: 0.6 } });
    const half = resolveStroke(shaky, DEFAULT_THEME, 0.5);
    const whole = resolveStroke(shaky, DEFAULT_THEME, 1);
    // Every point of the partial render is a point (or a cut) of the final one.
    for (const point of half.points.slice(0, -1)) {
      expect(whole.points).toContainEqual(point);
    }
  });
});

describe("stroke resolution", () => {
  it("resolves tone through the theme, passes CSS colours through, falls back otherwise", () => {
    expect(resolveTone("accent", DEFAULT_THEME)).toBe(DEFAULT_THEME.tones["accent"]);
    expect(resolveTone("#ff0000", DEFAULT_THEME)).toBe("#ff0000");
    expect(resolveTone("whatever-the-agent-invented", DEFAULT_THEME)).toBe(
      DEFAULT_THEME.tones["default"],
    );
    expect(resolveTone(undefined, DEFAULT_THEME)).toBe(DEFAULT_THEME.tones["default"]);
  });

  it("scales pen width by ink and reports the labelled object as the hit target", () => {
    const marker = resolveStroke(
      stroke({ style: { ...stroke().style, ink: "marker" } }),
      DEFAULT_THEME,
    );
    expect(marker.paint.width).toBeCloseTo(2 * DEFAULT_THEME.inkWidthScale.marker);
    expect(marker.objectId).toBe("obj_a");
  });

  it("shows text whole rather than half-written", () => {
    const label = resolveStroke(
      stroke({ type: "text", text: "Load", points: [{ x: 10, y: 20 }] }),
      DEFAULT_THEME,
      0.3,
    );
    expect(label.text).toBe("Load");
    expect(label.points).toEqual([{ x: 10, y: 20 }]);
  });

  it("merges theme overrides without dropping the defaults they do not mention", () => {
    const theme = mergeTheme({ tones: { accent: "#123456" } });
    expect(theme.tones["accent"]).toBe("#123456");
    expect(theme.tones["muted"]).toBe(DEFAULT_THEME.tones["muted"]);
    expect(theme.background).toBe(DEFAULT_THEME.background);
  });
});

describe("viewport", () => {
  it("round-trips between layout space and screen space", () => {
    const viewport = new Viewport({ width: 800, height: 600 }, { zoom: 2, offset: { x: 40, y: 10 } });
    expect(viewport.toScreen({ x: 10, y: 5 })).toEqual({ x: 60, y: 20 });
    expect(viewport.toWorld({ x: 60, y: 20 })).toEqual({ x: 10, y: 5 });
  });

  it("keeps the anchor point under the cursor while zooming", () => {
    const viewport = new Viewport({ width: 800, height: 600 });
    const anchor = { x: 300, y: 200 };
    const before = viewport.toWorld(anchor);
    viewport.zoomBy(2.5, anchor);
    expect(viewport.toWorld(anchor).x).toBeCloseTo(before.x);
    expect(viewport.toWorld(anchor).y).toBeCloseTo(before.y);
  });

  it("fits content into the viewport with padding, centred", () => {
    const viewport = new Viewport({ width: 400, height: 400 });
    viewport.fitToContent({ x: 100, y: 100, width: 200, height: 100 });
    const topLeft = viewport.toScreen({ x: 100, y: 100 });
    const bottomRight = viewport.toScreen({ x: 300, y: 200 });
    expect(topLeft.x).toBeGreaterThan(0);
    expect(bottomRight.x).toBeLessThan(400);
    expect(topLeft.x + bottomRight.x).toBeCloseTo(400);
    expect(topLeft.y + bottomRight.y).toBeCloseTo(400);
  });

  it("clamps zoom and survives degenerate content", () => {
    const viewport = new Viewport({ width: 400, height: 400 }, { maxZoom: 4 });
    viewport.setZoom(1000);
    expect(viewport.state().zoom).toBe(4);
    viewport.fitToContent({ x: 5, y: 5, width: 0, height: 0 });
    expect(Number.isFinite(viewport.state().offset.x)).toBe(true);
  });
});

describe("hit-testing (D-4)", () => {
  const strokes = [
    resolveStroke(stroke({ id: "shape", target: "box", metadata: { phase: "outline" } }), DEFAULT_THEME),
    resolveStroke(
      stroke({
        id: "label",
        target: "box",
        type: "text",
        text: "Box",
        points: [{ x: 50, y: 0 }],
        order: 1,
        metadata: { phase: "label" },
      }),
      DEFAULT_THEME,
    ),
    resolveStroke(
      stroke({
        id: "far",
        target: "other",
        points: [
          { x: 0, y: 400 },
          { x: 100, y: 400 },
        ],
        order: 2,
      }),
      DEFAULT_THEME,
    ),
  ];

  it("returns the object id, not the stroke id, as the thing that was clicked", () => {
    const hit = hitTest(strokes, { x: 20, y: 1 });
    expect(hit?.objectId).toBe("box");
    expect(hit?.strokeId).toBe("shape");
  });

  it("misses cleanly when nothing is near", () => {
    expect(hitTest(strokes, { x: 20, y: 200 })).toBeNull();
  });

  it("prefers the label over the shape underneath it", () => {
    const hits = hitTestAll(strokes, { x: 50, y: 0 });
    expect(hits[0]?.strokeId).toBe("label");
    expect(hits.map((hit) => hit.strokeId)).toContain("shape");
  });

  it("honours a layer filter", () => {
    expect(hitTest(strokes, { x: 50, y: 0 }, { layers: ["shapes"] })?.strokeId).toBe("shape");
  });

  it("selects every object crossing a region", () => {
    expect(hitTestRegion(strokes, { x: -10, y: -10, width: 500, height: 500 }).sort()).toEqual([
      "box",
      "other",
    ]);
    expect(hitTestRegion(strokes, { x: -10, y: 300, width: 500, height: 200 })).toEqual(["other"]);
  });
});

describe("scene reconciliation (D-7)", () => {
  const frame = (completed: Stroke[], inProgress: RenderFrame["inProgress"] = null): RenderFrame => ({
    timeMs: 0,
    completed,
    inProgress,
    pending: 0,
  });

  it("reports each stroke as added exactly once", () => {
    const scene = new Scene(DEFAULT_THEME);
    const a = stroke({ id: "a" });
    const b = stroke({ id: "b", order: 1 });
    expect(scene.applyFrame(frame([a])).added.map((s) => s.id)).toEqual(["a"]);
    const second = scene.applyFrame(frame([a, b]));
    expect(second.added.map((s) => s.id)).toEqual(["b"]);
    expect(second.updated).toEqual([]);
  });

  it("is idempotent: the same frame twice changes nothing", () => {
    const scene = new Scene(DEFAULT_THEME);
    const a = stroke({ id: "a" });
    scene.applyFrame(frame([a]));
    const repeat = scene.applyFrame(frame([a]));
    expect(repeat.added).toEqual([]);
    expect(repeat.updated).toEqual([]);
    expect(repeat.removed).toEqual([]);
  });

  it("updates the in-progress stroke and promotes it when it completes", () => {
    const scene = new Scene(DEFAULT_THEME);
    const a = stroke({ id: "a" });
    scene.applyFrame(frame([], { stroke: a, progress: 0.3, points: [] }));
    expect(scene.get("a")?.progress).toBe(0.3);
    const mid = scene.applyFrame(frame([], { stroke: a, progress: 0.6, points: [] }));
    expect(mid.updated.map((s) => s.id)).toEqual(["a"]);
    scene.applyFrame(frame([a]));
    expect(scene.get("a")?.progress).toBe(1);
  });

  it("removes strokes when the playhead moves backwards", () => {
    const scene = new Scene(DEFAULT_THEME);
    const a = stroke({ id: "a" });
    const b = stroke({ id: "b", order: 1 });
    scene.applyFrame(frame([a, b]));
    expect(scene.applyFrame(frame([a])).removed).toEqual(["b"]);
    expect(scene.strokes().map((s) => s.id)).toEqual(["a"]);
  });

  it("reports the extent of what is drawn", () => {
    const scene = new Scene(DEFAULT_THEME);
    scene.applyFrame(frame([stroke({ id: "a" })]));
    expect(displayBounds(scene.strokes())).toEqual({ x: 0, y: 0, width: 100, height: 0 });
  });
});

describe("renderer registry", () => {
  const capabilities = (overrides: Partial<RendererCapabilities>): RendererCapabilities => ({
    id: "fake",
    raster: false,
    vector: false,
    interactive: false,
    exportFormats: [],
    captureImage: false,
    ...overrides,
  });

  const factory = (caps: RendererCapabilities): RendererFactory => ({
    capabilities: caps,
    create: () => {
      throw new Error("not used in this test");
    },
  });

  it("selects by capability, never by name", () => {
    const registry = new RendererRegistry();
    registry.register(factory(capabilities({ id: "vector-only", vector: true, exportFormats: ["svg"] })));
    registry.register(
      factory(capabilities({ id: "raster", raster: true, captureImage: true, exportFormats: ["png"] })),
    );

    const raster = registry.select({ raster: true, captureImage: true });
    expect(raster.ok && raster.value.capabilities.id).toBe("raster");

    const svg = registry.select({ exportFormats: ["svg"] });
    expect(svg.ok && svg.value.capabilities.id).toBe("vector-only");
  });

  it("reports what it has when nothing fits, so the caller can say why", () => {
    const registry = new RendererRegistry();
    registry.register(factory(capabilities({ id: "vector-only", vector: true })));
    const result = registry.select({ raster: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("RENDER_NO_COMPATIBLE_RENDERER");
      expect(result.errors[0]?.details?.["registered"]).toHaveLength(1);
    }
  });

  it("refuses a duplicate registration rather than silently replacing it", () => {
    const registry = new RendererRegistry();
    const one = factory(capabilities({ id: "dup" }));
    expect(registry.register(one).ok).toBe(true);
    const second = registry.register(one);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.errors[0]?.code).toBe("RENDER_DUPLICATE_ADAPTER");
    registry.replace(factory(capabilities({ id: "dup", raster: true })));
    expect(registry.list()).toHaveLength(1);
  });

  it("names what is registered when an id is missing", () => {
    const registry = new RendererRegistry();
    const result = registry.get("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("RENDER_ADAPTER_NOT_REGISTERED");
  });
});
