/**
 * The SVG backend.
 *
 * The plan calls this a skeleton and the temptation is a file that throws
 * `NOT_IMPLEMENTED`. A second backend that does not run proves nothing about the
 * abstraction -- exactly the failure mode `llm-provider-anthropic` exists to
 * prevent one layer down. So it renders, and it is under 200 lines only because
 * D-1 left it nothing to do but emit `<path>` elements.
 *
 * It is also the backend that runs *anywhere*: no canvas, no DOM, no native
 * module. That is what lets the viewport, layer and hit-testing criteria be
 * asserted in environments where Konva cannot start at all.
 */
import {
  BaseRendererAdapter,
  LAYER_ORDER,
  type CapturedImage,
  type DisplayStroke,
  type ExportFormat,
  type LayerName,
  type RendererCapabilities,
  type RendererOptions,
  type RendererTheme,
  type SceneDiff,
} from "@sketchmind/renderer-core";
import { fail, ok, type ValidationResult } from "@sketchmind/shared-types";
import { svgError } from "./errors.js";

export const RENDERER_ID = "svg";

export const SVG_CAPABILITIES: RendererCapabilities = {
  id: RENDERER_ID,
  raster: false,
  vector: true,
  interactive: false,
  exportFormats: ["svg"],
  // True: `captureImage` returns image/svg+xml bytes rather than pixels (D-10).
  // A caller that needs a raster specifically asks for `raster: true`.
  captureImage: true,
};

export class SvgRendererAdapter extends BaseRendererAdapter {
  readonly capabilities = SVG_CAPABILITIES;

  #theme: RendererTheme | null = null;

  protected mount(_options: RendererOptions, theme: RendererTheme): ValidationResult<void> {
    this.#theme = theme;
    return ok(undefined);
  }

  protected unmount(): void {
    this.#theme = null;
  }

  /**
   * Serialisation happens on demand, not per stroke.
   *
   * A canvas backend must paint incrementally because its surface is stateful; an
   * SVG document is a pure function of the scene, so keeping a parallel DOM would
   * be a cache with nothing to gain. `renderFrame` therefore costs nothing here,
   * which is the property that makes this backend usable server-side.
   */
  protected paint(_diff: SceneDiff): void {
    // Intentionally empty -- see above.
  }

  protected applyViewport(): void {
    // The transform is read at serialisation time, from `viewport()`.
  }

  protected applyLayerVisibility(_layer: LayerName, _visible: boolean): void {
    // Read at serialisation time, from `isLayerVisible`.
  }

  /** The current scene as an SVG document. */
  toSVG(): string {
    const theme = this.#theme;
    if (!theme) return "";
    const { size, offset, zoom } = this.viewport().state();
    const byLayer = new Map<LayerName, DisplayStroke[]>();
    for (const stroke of this.displayStrokes()) {
      if (!this.isLayerVisible(stroke.layer)) continue;
      const bucket = byLayer.get(stroke.layer);
      if (bucket) bucket.push(stroke);
      else byLayer.set(stroke.layer, [stroke]);
    }

    const groups = LAYER_ORDER.filter((layer) => byLayer.has(layer))
      .map((layer) => {
        const body = byLayer
          .get(layer)!
          .map((stroke) => elementFor(stroke, theme))
          .join("\n      ");
        return `    <g data-layer="${layer}">\n      ${body}\n    </g>`;
      })
      .join("\n");

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`,
      `  <rect width="100%" height="100%" fill="${escapeAttr(theme.background)}"/>`,
      `  <g transform="translate(${round(offset.x)} ${round(offset.y)}) scale(${round(zoom)})">`,
      groups,
      `  </g>`,
      `</svg>`,
    ].join("\n");
  }

  protected capture(format: ExportFormat): ValidationResult<CapturedImage> {
    if (format !== "svg") {
      return fail([
        svgError(
          "RENDER_UNSUPPORTED_FORMAT",
          `The SVG backend produces vector output only; "${format}" needs a raster renderer.`,
          { details: { requested: format, supported: SVG_CAPABILITIES.exportFormats } },
        ),
      ]);
    }
    const size = this.viewport().size();
    return ok({
      mimeType: "image/svg+xml",
      width: size.width,
      height: size.height,
      data: new TextEncoder().encode(this.toSVG()),
    });
  }
}

function round(value: number): number {
  // Three decimals: below a pixel at any sane zoom, and it keeps the document
  // diffable, which is most of the point of having an SVG backend.
  return Math.round(value * 1000) / 1000;
}

function elementFor(stroke: DisplayStroke, theme: RendererTheme): string {
  if (stroke.type === "text") {
    const anchor = stroke.points[0] ?? { x: 0, y: 0 };
    return (
      `<text x="${round(anchor.x)}" y="${round(anchor.y)}" fill="${escapeAttr(stroke.paint.color)}" ` +
      `font-size="${stroke.paint.fontSizePx ?? theme.fontSizePx}" ` +
      `font-family="${escapeAttr(stroke.paint.fontFamily ?? theme.fontFamily)}" ` +
      `text-anchor="middle" dominant-baseline="middle" opacity="${stroke.paint.opacity}" ` +
      `data-object="${escapeAttr(stroke.objectId)}" data-stroke="${escapeAttr(stroke.id)}">` +
      `${escapeText(stroke.text ?? "")}</text>`
    );
  }

  const d = stroke.points
    .map((p, i) => `${i === 0 ? "M" : "L"}${round(p.x)} ${round(p.y)}`)
    .join(" ");
  const dash = stroke.paint.dash ? ` stroke-dasharray="${stroke.paint.dash.map(round).join(" ")}"` : "";
  return (
    `<path d="${d}${stroke.closed ? " Z" : ""}" fill="none" stroke="${escapeAttr(stroke.paint.color)}" ` +
    `stroke-width="${round(stroke.paint.width)}" stroke-linecap="${stroke.paint.lineCap}" ` +
    `stroke-linejoin="${stroke.paint.lineJoin}" opacity="${stroke.paint.opacity}"${dash} ` +
    `data-object="${escapeAttr(stroke.objectId)}" data-stroke="${escapeAttr(stroke.id)}"/>`
  );
}

/**
 * Object ids and label text come from a model the agent wrote (AD-5), so they are
 * untrusted markup as far as this file is concerned.
 */
function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}
