import { describe, it, expect, afterEach } from "vitest";
import Konva from "konva";
import type { Stroke } from "@sketchmind/shared-types";
import {
  rendererRegistry,
  type RendererAdapter,
  type RendererOptions,
  type RenderFrame,
} from "@sketchmind/renderer-core";
import {
  createKonvaRenderer,
  konvaRendererFactory,
  registerKonvaRenderer,
  KonvaRendererAdapter,
  KONVA_CAPABILITIES,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "../src/index.js";

function stroke(overrides: Partial<Stroke> = {}): Stroke {
  return {
    id: "s1",
    type: "line",
    target: "obj_a",
    order: 0,
    dependencies: [],
    points: [
      { x: 10, y: 10 },
      { x: 190, y: 90 },
    ],
    style: { width: 3, jitter: 0, pressureProfile: "taperBoth", ink: "pen", dashed: false },
    timing: { delayMs: 0, durationMs: 400, pauseAfterMs: 0 },
    ...overrides,
  };
}

const frame = (completed: Stroke[], inProgress: RenderFrame["inProgress"] = null): RenderFrame => ({
  timeMs: 0,
  completed,
  inProgress,
  pending: 0,
});

const live: RendererAdapter[] = [];

function mount(options: Partial<RendererOptions> = {}): RendererAdapter {
  const result = createKonvaRenderer({ size: { width: 200, height: 100 }, ...options });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  live.push(result.value);
  return result.value;
}

afterEach(() => {
  while (live.length > 0) live.pop()!.destroy();
});

/** Every stroke node currently on the stage; the background rect carries no id. */
function shapes(adapter: RendererAdapter): Konva.Shape[] {
  const stage = (adapter as KonvaRendererAdapter).stage();
  if (!stage) return [];
  return [
    ...stage.find((node: Konva.Node) => node instanceof Konva.Shape && node.id() !== ""),
  ] as Konva.Shape[];
}

describe("renderer-konva package identity", () => {
  it("exposes its name, version, and capabilities", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/renderer-konva");
    expect(PACKAGE_VERSION).toBe("0.0.1");
    expect(KONVA_CAPABILITIES).toMatchObject({
      id: "konva",
      raster: true,
      vector: false,
      interactive: true,
      captureImage: true,
    });
  });
});

describe("lifecycle", () => {
  it("rejects a zero-sized canvas rather than mounting an invisible one", () => {
    const result = createKonvaRenderer({ size: { width: 0, height: 100 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("RENDER_INVALID_OPTIONS");
  });

  it("refuses to initialize twice", () => {
    const adapter = mount();
    const again = (adapter as KonvaRendererAdapter).initialize({ size: { width: 10, height: 10 } });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.errors[0]?.code).toBe("RENDER_ALREADY_INITIALIZED");
  });

  it("tears the stage down on destroy and tolerates a second destroy", () => {
    const adapter = mount();
    adapter.drawStroke(stroke());
    adapter.destroy();
    live.length = 0;
    expect((adapter as KonvaRendererAdapter).stage()).toBeNull();
    expect(() => adapter.destroy()).not.toThrow();
  });

  it("reports why it cannot export before initialization", () => {
    const result = new KonvaRendererAdapter().captureImage();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("RENDER_NOT_INITIALIZED");
  });
});

describe("drawing", () => {
  it("puts one Konva node on the stage per stroke, in the right layer group", () => {
    const adapter = mount();
    adapter.renderFrame(
      frame([
        stroke({ id: "outline", metadata: { phase: "outline" } }),
        stroke({ id: "join", order: 1, type: "arrow", metadata: { phase: "connector" } }),
        stroke({
          id: "label",
          order: 2,
          type: "text",
          text: "Load",
          points: [{ x: 100, y: 50 }],
          metadata: { phase: "label" },
        }),
      ]),
    );

    const nodes = shapes(adapter);
    expect(nodes.map((node) => node.id()).sort()).toEqual(["join", "label", "outline"]);
    expect(nodes.find((node) => node.id() === "outline")?.getParent()?.name()).toBe("shapes");
    expect(nodes.find((node) => node.id() === "join")?.getParent()?.name()).toBe("connectors");
    expect(nodes.find((node) => node.id() === "label")?.getParent()?.name()).toBe("labels");
  });

  it("draws an arrow as an arrow and a text stroke as text", () => {
    const adapter = mount();
    adapter.renderFrame(
      frame([
        stroke({ id: "arrow", type: "arrow" }),
        stroke({ id: "text", order: 1, type: "text", text: "F", points: [{ x: 50, y: 50 }] }),
      ]),
    );
    const nodes = shapes(adapter);
    expect(nodes.find((node) => node.id() === "arrow")).toBeInstanceOf(Konva.Arrow);
    expect(nodes.find((node) => node.id() === "text")).toBeInstanceOf(Konva.Text);
  });

  it("carries the diagram object id on the node, which is what Phase 11 acts on", () => {
    const adapter = mount();
    adapter.drawStroke(stroke({ target: "movable_pulley" }));
    expect(shapes(adapter)[0]?.name()).toBe("movable_pulley");
  });

  it("is idempotent: the same frame twice leaves the same nodes (D-7)", () => {
    const adapter = mount();
    const strokes = [stroke({ id: "a" }), stroke({ id: "b", order: 1 })];
    adapter.renderFrame(frame(strokes));
    const before = shapes(adapter).map((node) => node._id);
    adapter.renderFrame(frame(strokes));
    expect(shapes(adapter).map((node) => node._id)).toEqual(before);
  });

  it("destroys nodes when the playhead moves backwards", () => {
    const adapter = mount();
    const a = stroke({ id: "a" });
    const b = stroke({ id: "b", order: 1 });
    adapter.renderFrame(frame([a, b]));
    expect(shapes(adapter)).toHaveLength(2);
    adapter.renderFrame(frame([a]));
    expect(shapes(adapter).map((node) => node.id())).toEqual(["a"]);
  });

  it("grows the in-progress stroke without recreating its node", () => {
    const adapter = mount();
    const growing = stroke({ id: "growing" });
    adapter.renderFrame(frame([], { stroke: growing, progress: 0.25, points: [] }));
    const node = shapes(adapter)[0] as Konva.Line;
    const identity = node._id;
    const penAt = (line: Konva.Line): number => line.points()[line.points().length - 2]!;
    const early = penAt(node);

    adapter.renderFrame(frame([], { stroke: growing, progress: 0.9, points: [] }));
    const grown = shapes(adapter)[0] as Konva.Line;
    // Same node, pen further along: an update, not a rebuild.
    expect(grown._id).toBe(identity);
    expect(penAt(grown)).toBeGreaterThan(early);

    adapter.renderFrame(frame([growing]));
    expect((shapes(adapter)[0] as Konva.Line)._id).toBe(identity);
    expect(penAt(shapes(adapter)[0] as Konva.Line)).toBe(190);
  });

  it("erases and clears", () => {
    const adapter = mount();
    adapter.drawStroke(stroke({ id: "a" }));
    adapter.drawStroke(stroke({ id: "b", order: 1 }));
    adapter.eraseStroke("a");
    expect(shapes(adapter).map((node) => node.id())).toEqual(["b"]);
    adapter.clear();
    expect(shapes(adapter)).toHaveLength(0);
  });
});

describe("viewport and layers", () => {
  it("pushes the viewport transform onto the stage", () => {
    const adapter = mount();
    adapter.viewport().setZoom(2);
    adapter.viewport().panTo({ x: 30, y: 15 });
    adapter.resizeViewport({ width: 400, height: 300 });

    const stage = (adapter as KonvaRendererAdapter).stage()!;
    expect(stage.width()).toBe(400);
    expect(stage.height()).toBe(300);
    expect(stage.scaleX()).toBe(2);
    expect(stage.position()).toEqual({ x: 30, y: 15 });
  });

  it("hides a whole layer, and hidden layers stop answering hit tests", () => {
    const adapter = mount();
    adapter.renderFrame(
      frame([
        stroke({
          id: "shape",
          target: "box",
          points: [
            { x: 0, y: 50 },
            { x: 200, y: 50 },
          ],
          metadata: { phase: "outline" },
        }),
        stroke({
          id: "label",
          order: 1,
          target: "box",
          type: "text",
          text: "Box",
          points: [{ x: 100, y: 50 }],
          metadata: { phase: "label" },
        }),
      ]),
    );

    expect(adapter.hitTest({ x: 100, y: 50 })?.strokeId).toBe("label");
    adapter.setLayerVisible("labels", false);
    expect(adapter.isLayerVisible("labels")).toBe(false);
    expect(adapter.hitTest({ x: 100, y: 50 })?.strokeId).toBe("shape");

    const stage = (adapter as KonvaRendererAdapter).stage()!;
    expect(stage.findOne((node: Konva.Node) => node.name() === "labels")?.visible()).toBe(false);
  });

  it("fits drawn content into view", () => {
    const adapter = mount();
    adapter.drawStroke(
      stroke({
        points: [
          { x: 1000, y: 1000 },
          { x: 1200, y: 1100 },
        ],
      }),
    );
    adapter.fitToContent();
    const screen = adapter.viewport().toScreen({ x: 1100, y: 1050 });
    expect(screen.x).toBeCloseTo(100);
    expect(screen.y).toBeCloseTo(50);
  });
});

describe("hit-testing agrees with the pixels (D-4)", () => {
  it("returns the object id that Konva's own hit graph finds at that point", () => {
    const adapter = mount({ size: { width: 200, height: 200 } });
    const thick = { width: 6, jitter: 0, pressureProfile: "uniform", ink: "pen", dashed: false } as const;
    adapter.renderFrame(
      frame([
        stroke({
          id: "left",
          target: "left_object",
          points: [
            { x: 20, y: 20 },
            { x: 20, y: 180 },
          ],
          style: thick,
        }),
        stroke({
          id: "right",
          order: 1,
          target: "right_object",
          points: [
            { x: 180, y: 20 },
            { x: 180, y: 180 },
          ],
          style: thick,
        }),
      ]),
    );

    const stage = (adapter as KonvaRendererAdapter).stage()!;
    for (const probe of [
      { point: { x: 20, y: 100 }, expected: "left_object" },
      { point: { x: 180, y: 100 }, expected: "right_object" },
    ]) {
      expect(adapter.hitTest(probe.point)?.objectId).toBe(probe.expected);
      // Konva reports what is actually painted there. The two must not disagree.
      expect(stage.getIntersection(probe.point)?.name()).toBe(probe.expected);
    }

    // Empty space: core says nothing is there, and so do the pixels.
    expect(adapter.hitTest({ x: 100, y: 100 })).toBeNull();
    expect(stage.getIntersection({ x: 100, y: 100 })).toBeNull();
  });
});

describe("capture and export", () => {
  it("returns decodable PNG bytes at the requested size", () => {
    const adapter = mount({ size: { width: 120, height: 80 }, pixelRatio: 2 });
    adapter.drawStroke(
      stroke({
        points: [
          { x: 10, y: 10 },
          { x: 110, y: 70 },
        ],
      }),
    );

    const captured = adapter.captureImage();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.value.mimeType).toBe("image/png");
    expect(captured.value.width).toBe(240);
    expect(captured.value.height).toBe(160);
    // PNG magic number: bytes 1-3 spell "PNG".
    expect(String.fromCharCode(...captured.value.data.subarray(1, 4))).toBe("PNG");
    expect(captured.value.data.length).toBeGreaterThan(100);
  });

  it("refuses a format it cannot produce, naming the ones it can", () => {
    const adapter = mount();
    const result = adapter.export("svg");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("RENDER_UNSUPPORTED_FORMAT");
      expect(result.errors[0]?.details?.["supported"]).toEqual(["png"]);
    }
  });
});

describe("registry integration", () => {
  it("registers under its capabilities and is selectable without naming it", () => {
    expect(registerKonvaRenderer().ok).toBe(true);
    const selected = rendererRegistry.select({ raster: true, captureImage: true });
    expect(selected.ok && selected.value).toBe(konvaRendererFactory);
    // Registration is explicit, so a repeat is a caller error rather than a no-op.
    expect(registerKonvaRenderer().ok).toBe(false);
    rendererRegistry.unregister("konva");
  });
});
