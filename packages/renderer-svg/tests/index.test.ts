import { describe, it, expect } from "vitest";
import type { Stroke } from "@sketchmind/shared-types";
import {
  resolveStroke,
  rendererRegistry,
  DEFAULT_THEME,
  type RenderFrame,
} from "@sketchmind/renderer-core";
import {
  createSvgRenderer,
  registerSvgRenderer,
  svgRendererFactory,
  SVG_CAPABILITIES,
  SvgRendererAdapter,
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
      { x: 90, y: 50 },
    ],
    style: { width: 2, jitter: 0, pressureProfile: "taperBoth", ink: "pen", dashed: false },
    timing: { delayMs: 0, durationMs: 400, pauseAfterMs: 0 },
    ...overrides,
  };
}

const frame = (completed: Stroke[]): RenderFrame => ({
  timeMs: 0,
  completed,
  inProgress: null,
  pending: 0,
});

function mount(): SvgRendererAdapter {
  const result = createSvgRenderer({ size: { width: 100, height: 60 } });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

describe("renderer-svg package identity", () => {
  it("exposes its name, version, and honest capabilities", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/renderer-svg");
    expect(PACKAGE_VERSION).toBe("0.0.1");
    // Vector, not raster. A caller that needs pixels asks for `raster: true` and
    // will not be handed this backend by the registry (D-10).
    expect(SVG_CAPABILITIES).toMatchObject({
      id: "svg",
      raster: false,
      vector: true,
      interactive: false,
      captureImage: true,
    });
  });
});

describe("serialisation", () => {
  it("emits one path per stroke, tagged with its object and stroke ids", () => {
    const adapter = mount();
    adapter.renderFrame(frame([stroke({ id: "a", target: "ceiling" })]));
    const svg = adapter.toSVG();
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('data-object="ceiling"');
    expect(svg).toContain('data-stroke="a"');
    expect(svg).toContain("M10 10 L90 50");
  });

  it("groups strokes by logical layer, in painter's order", () => {
    const adapter = mount();
    adapter.renderFrame(
      frame([
        stroke({ id: "label", type: "text", text: "Load", points: [{ x: 50, y: 30 }], metadata: { phase: "label" } }),
        stroke({ id: "shape", order: 1, metadata: { phase: "outline" } }),
        stroke({ id: "join", order: 2, metadata: { phase: "connector" } }),
      ]),
    );
    const svg = adapter.toSVG();
    expect(svg.indexOf('data-layer="shapes"')).toBeLessThan(svg.indexOf('data-layer="connectors"'));
    expect(svg.indexOf('data-layer="connectors"')).toBeLessThan(svg.indexOf('data-layer="labels"'));
  });

  it("omits hidden layers", () => {
    const adapter = mount();
    adapter.renderFrame(
      frame([
        stroke({ id: "shape", metadata: { phase: "outline" } }),
        stroke({ id: "label", order: 1, type: "text", text: "x", points: [{ x: 1, y: 1 }] }),
      ]),
    );
    adapter.setLayerVisible("labels", false);
    expect(adapter.toSVG()).not.toContain('data-layer="labels"');
  });

  it("carries the viewport as a transform rather than baking it into the points", () => {
    const adapter = mount();
    adapter.renderFrame(frame([stroke()]));
    adapter.viewport().setZoom(2);
    adapter.viewport().panTo({ x: 12, y: 4 });
    const svg = adapter.toSVG();
    expect(svg).toContain("translate(12 4) scale(2)");
    // The path itself is still in layout coordinates.
    expect(svg).toContain("M10 10");
  });

  it("escapes agent-authored text and ids rather than trusting them as markup", () => {
    const adapter = mount();
    adapter.renderFrame(
      frame([
        stroke({
          id: "evil",
          target: 'a"><script>x</script>',
          type: "text",
          text: "<b>Load & Lift</b>",
          points: [{ x: 5, y: 5 }],
        }),
      ]),
    );
    const svg = adapter.toSVG();
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;b&gt;Load &amp; Lift&lt;/b&gt;");
  });

  it("draws the same geometry renderer-core resolved, point for point (D-1)", () => {
    const shaky = stroke({ style: { ...stroke().style, jitter: 0.4 } });
    const adapter = mount();
    adapter.renderFrame(frame([shaky]));
    const expected = resolveStroke(shaky, DEFAULT_THEME);
    for (const point of expected.points) {
      expect(adapter.toSVG()).toContain(`${Math.round(point.x * 1000) / 1000} ${Math.round(point.y * 1000) / 1000}`);
    }
  });
});

describe("capture and hit-testing", () => {
  it("captures itself as image/svg+xml bytes", () => {
    const adapter = mount();
    adapter.renderFrame(frame([stroke()]));
    const captured = adapter.captureImage();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.value.mimeType).toBe("image/svg+xml");
    expect(new TextDecoder().decode(captured.value.data)).toContain("<svg");
  });

  it("refuses PNG, because it does not rasterise", () => {
    const adapter = mount();
    const result = adapter.export("png");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("RENDER_UNSUPPORTED_FORMAT");
  });

  it("hit-tests with no canvas at all -- the reason this backend earns its keep", () => {
    const adapter = mount();
    adapter.renderFrame(frame([stroke({ target: "rope" })]));
    expect(adapter.hitTest({ x: 50, y: 30 })?.objectId).toBe("rope");
    expect(adapter.hitTest({ x: 50, y: 5 })).toBeNull();
  });
});

describe("registry integration", () => {
  it("is selected for vector work and passed over when pixels are required", () => {
    expect(registerSvgRenderer().ok).toBe(true);

    const vector = rendererRegistry.select({ vector: true, exportFormats: ["svg"] });
    expect(vector.ok && vector.value).toBe(svgRendererFactory);

    const raster = rendererRegistry.select({ raster: true });
    expect(raster.ok).toBe(false);

    rendererRegistry.unregister("svg");
  });
});
