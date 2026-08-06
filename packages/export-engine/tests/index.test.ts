import { describe, it, expect } from "vitest";
import type { Stroke, StrokeAST } from "@sketchmind/shared-types";
import { createSvgRenderer } from "@sketchmind/renderer-svg";
import type { RendererAdapter } from "@sketchmind/renderer-core";
import {
  exportJSON,
  exportPNG,
  exportReplayPackage,
  exportSVG,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "../src/index.js";

function stroke(id: string, target: string): Stroke {
  return {
    id,
    type: "line",
    target,
    order: 0,
    dependencies: [],
    points: [
      { x: 0, y: 0 },
      { x: 40, y: 20 },
    ],
    style: { width: 2, jitter: 0, pressureProfile: "taperBoth", ink: "pen", dashed: false },
    timing: { delayMs: 0, durationMs: 400, pauseAfterMs: 0 },
  };
}

const AST: StrokeAST = {
  version: "1.0",
  diagramId: "pulley",
  strokes: [stroke("a", "ceiling"), { ...stroke("b", "load"), order: 1 }],
  totalDurationMs: 800,
};

function svgAdapter(): RendererAdapter {
  const result = createSvgRenderer({ size: { width: 100, height: 60 } });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  result.value.renderFrame({ timeMs: 0, completed: AST.strokes, inProgress: null, pending: 0 });
  return result.value;
}

describe("export-engine package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/export-engine");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});

describe("adapter-backed formats", () => {
  it("exports SVG through the adapter contract, naming no backend (D-6)", () => {
    const result = exportSVG(svgAdapter());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mimeType).toBe("image/svg+xml");
    const svg = new TextDecoder().decode(result.value.data);
    expect(svg).toContain('data-object="ceiling"');
    expect(svg).toContain('data-object="load"');
  });

  it("refuses PNG from a renderer that produces no pixels, and says which one", () => {
    const result = exportPNG(svgAdapter());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("EXPORT_UNSUPPORTED_FORMAT");
      expect(result.errors[0]?.details?.["renderer"]).toBe("svg");
      expect(result.errors[0]?.package).toBe("@sketchmind/export-engine");
    }
  });
});

describe("serialisation formats need no renderer at all", () => {
  it("round-trips the Stroke AST through JSON without loss", () => {
    const result = exportJSON(AST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.value)).toEqual(AST);
  });

  it("refuses to export a diagram with nothing in it", () => {
    const empty = exportJSON({ ...AST, strokes: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors[0]?.code).toBe("EXPORT_EMPTY_DIAGRAM");
  });

  it("builds a replay package that carries everything needed to play it back", () => {
    const result = exportReplayPackage(AST, { now: () => "2026-08-06T00:00:00.000Z" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      format: "sketchmind-replay",
      version: 1,
      diagramId: "pulley",
      strokeCount: 2,
      totalDurationMs: 800,
      exportedAt: "2026-08-06T00:00:00.000Z",
    });
    expect(result.value.ast.strokes).toHaveLength(2);
    expect(result.value.preview).toBeUndefined();
  });

  it("attaches a preview when an adapter can capture, base64-encoded with its type", () => {
    const result = exportReplayPackage(AST, { adapter: svgAdapter() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.preview?.mimeType).toBe("image/svg+xml");
    expect(atob(result.value.preview!.base64)).toContain("<svg");
  });

  it("is byte-reproducible given the same clock -- what Phase 12's caching needs", () => {
    const once = exportReplayPackage(AST, { now: () => "2026-08-06T00:00:00.000Z" });
    const twice = exportReplayPackage(AST, { now: () => "2026-08-06T00:00:00.000Z" });
    expect(once.ok && twice.ok && JSON.stringify(once.value)).toBe(
      twice.ok ? JSON.stringify(twice.value) : "",
    );
  });
});
