/**
 * The Konva backend.
 *
 * Everything semantic already happened in `renderer-core` (Phase 8 D-1): the
 * points arriving here are jittered, world-space, and painted. This file's whole
 * job is Konva's API -- create a node, repoint a node, destroy a node, and turn
 * the stage into bytes.
 *
 * Nothing above the renderer layer is importable from here, which is a CI-checked
 * fact rather than a habit: `renderer` sits below `core` in
 * `scripts/check-layering.mjs`, so an import of `stroke-runtime`, `layout-engine`
 * or anything agent-shaped fails the build.
 */
import Konva from "konva";
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
import { konvaError } from "./errors.js";

export const RENDERER_ID = "konva";

export const KONVA_CAPABILITIES: RendererCapabilities = {
  id: RENDERER_ID,
  raster: true,
  vector: false,
  interactive: true,
  exportFormats: ["png"],
  captureImage: true,
};

/** Arrowhead size, as a multiple of pen width. A visual decision, so it lives here. */
const ARROW_POINTER_LENGTH = 4;
const ARROW_POINTER_WIDTH = 3;

function flatten(points: readonly { x: number; y: number }[]): number[] {
  const flat: number[] = [];
  for (const p of points) flat.push(p.x, p.y);
  return flat;
}

export class KonvaRendererAdapter extends BaseRendererAdapter {
  readonly capabilities = KONVA_CAPABILITIES;

  #stage: Konva.Stage | null = null;
  #layer: Konva.Layer | null = null;
  #groups = new Map<LayerName, Konva.Group>();
  #nodes = new Map<string, Konva.Shape>();
  #background: Konva.Rect | null = null;

  /**
   * One `Konva.Layer` holding eight `Konva.Group`s, not eight Konva layers.
   *
   * Volume 08's eight logical layers are a z-order and visibility model; Konva's
   * layer is a separate `<canvas>` element, and Konva's own guidance is to stay
   * under 3-5 of them. Groups give independent visibility, z-order and caching --
   * everything Volume 08 §Layer Model actually asks for -- at the cost of a
   * whole-layer redraw, which `batchDraw` coalesces anyway.
   */
  protected mount(options: RendererOptions, theme: RendererTheme): ValidationResult<void> {
    const container = options.container;
    // Konva runs headless without a container (that is how the test suite gets
    // real pixels in Node). In a browser it needs one, and a silently invisible
    // canvas is a worse outcome than an error.
    const config: Konva.StageConfig = {
      width: options.size.width,
      height: options.size.height,
      ...(container === undefined ? {} : { container: container as HTMLDivElement }),
    };

    let stage: Konva.Stage;
    try {
      stage = new Konva.Stage(config);
    } catch (cause) {
      return fail([
        konvaError("RENDER_CONTAINER_REQUIRED", `Konva could not create a stage: ${String(cause)}`, {
          details: { container: typeof container },
        }),
      ]);
    }

    const layer = new Konva.Layer({ listening: true });
    stage.add(layer);

    const background = new Konva.Rect({ fill: theme.background, listening: false });
    layer.add(background);

    const groups = new Map<LayerName, Konva.Group>();
    for (const name of LAYER_ORDER) {
      const group = new Konva.Group({ name });
      groups.set(name, group);
      layer.add(group);
    }

    this.#stage = stage;
    this.#layer = layer;
    this.#groups = groups;
    this.#background = background;
    this.#nodes = new Map();
    return ok(undefined);
  }

  protected unmount(): void {
    this.#stage?.destroy();
    this.#stage = null;
    this.#layer = null;
    this.#groups = new Map();
    this.#nodes = new Map();
    this.#background = null;
  }

  /** Escape hatch for `apps/web` (pointer events) and for the test suite's cross-checks. */
  stage(): Konva.Stage | null {
    return this.#stage;
  }

  // ------------------------------------------------------------------ paint

  protected paint(diff: SceneDiff): void {
    const layer = this.#layer;
    if (!layer) return;
    if (diff.added.length === 0 && diff.updated.length === 0 && diff.removed.length === 0) return;

    for (const id of diff.removed) {
      this.#nodes.get(id)?.destroy();
      this.#nodes.delete(id);
    }
    for (const stroke of diff.added) this.#create(stroke);
    for (const stroke of diff.updated) this.#update(stroke);

    // `draw`, not `batchDraw`. Batching defers to `requestAnimationFrame`, which
    // leaves the hit graph and the exported bitmap describing a frame that has
    // not happened yet -- and there is nothing to batch: the caller already owns
    // the frame loop (Phase 7 D-8 put the clock there deliberately), so `paint`
    // runs once per frame either way.
    layer.draw();
  }

  #create(stroke: DisplayStroke): void {
    // A repeat `add` for an id already on the surface is an update, not a
    // duplicate node -- which is what makes renderFrame idempotent (D-7).
    const existing = this.#nodes.get(stroke.id);
    if (existing) {
      this.#update(stroke);
      return;
    }
    const node = stroke.type === "text" ? textNode(stroke) : lineNode(stroke);
    this.#nodes.set(stroke.id, node);
    const group = this.#groups.get(stroke.layer);
    (group ?? this.#layer)?.add(node);
  }

  #update(stroke: DisplayStroke): void {
    const node = this.#nodes.get(stroke.id);
    if (!node) {
      this.#create(stroke);
      return;
    }
    if (node instanceof Konva.Text) {
      node.position({ x: stroke.points[0]!.x, y: stroke.points[0]!.y });
      node.text(stroke.text ?? "");
      centreText(node);
      return;
    }
    (node as Konva.Line).points(flatten(stroke.points));
    node.stroke(stroke.paint.color);
    node.strokeWidth(stroke.paint.width);
    node.opacity(stroke.paint.opacity);
  }

  // --------------------------------------------------------------- viewport

  protected applyViewport(): void {
    const stage = this.#stage;
    if (!stage) return;
    const { size, offset, zoom } = this.viewport().state();
    stage.size({ width: size.width, height: size.height });
    stage.scale({ x: zoom, y: zoom });
    stage.position(offset);

    // The background is a world-space rectangle covering the visible region, so
    // exported pixels have a background rather than alpha zero.
    const visible = this.viewport().visibleBounds();
    this.#background?.setAttrs({
      x: visible.x,
      y: visible.y,
      width: visible.width,
      height: visible.height,
      fill: this.theme.background,
    });
    this.#layer?.draw();
  }

  protected applyLayerVisibility(layer: LayerName, visible: boolean): void {
    this.#groups.get(layer)?.visible(visible);
    this.#layer?.draw();
  }

  // ----------------------------------------------------------------- output

  protected capture(format: ExportFormat): ValidationResult<CapturedImage> {
    const stage = this.#stage;
    if (!stage) {
      return fail([konvaError("RENDER_NOT_INITIALIZED", "Cannot capture before initialize().")]);
    }
    if (format !== "png") {
      return fail([
        konvaError("RENDER_UNSUPPORTED_FORMAT", `Konva cannot export "${format}"; it rasterises only.`),
      ]);
    }

    const pixelRatio = this.options.pixelRatio ?? 1;
    try {
      // `toDataURL` rather than a backend-specific buffer call: it is synchronous
      // and identical in Node and the browser, where `toBlob` is neither.
      const dataUrl = stage.toDataURL({ pixelRatio, mimeType: "image/png" });
      const size = this.viewport().size();
      return ok({
        mimeType: "image/png",
        width: Math.round(size.width * pixelRatio),
        height: Math.round(size.height * pixelRatio),
        data: decodeDataUrl(dataUrl),
      });
    } catch (cause) {
      return fail([
        konvaError("RENDER_CAPTURE_FAILED", `Konva failed to rasterise the stage: ${String(cause)}`, {
          recoverable: true,
        }),
      ]);
    }
  }
}

function lineNode(stroke: DisplayStroke): Konva.Line {
  const points = flatten(stroke.points);
  const config: Konva.LineConfig = {
    id: stroke.id,
    name: stroke.objectId,
    points,
    stroke: stroke.paint.color,
    strokeWidth: stroke.paint.width,
    opacity: stroke.paint.opacity,
    lineCap: stroke.paint.lineCap,
    lineJoin: stroke.paint.lineJoin,
    closed: stroke.closed,
    ...(stroke.paint.dash ? { dash: [...stroke.paint.dash] } : {}),
  };
  if (stroke.type !== "arrow") return new Konva.Line(config);
  return new Konva.Arrow({
    ...config,
    points,
    fill: stroke.paint.color,
    pointerLength: stroke.paint.width * ARROW_POINTER_LENGTH,
    pointerWidth: stroke.paint.width * ARROW_POINTER_WIDTH,
  });
}

function textNode(stroke: DisplayStroke): Konva.Text {
  const anchor = stroke.points[0] ?? { x: 0, y: 0 };
  const node = new Konva.Text({
    id: stroke.id,
    name: stroke.objectId,
    x: anchor.x,
    y: anchor.y,
    text: stroke.text ?? "",
    fill: stroke.paint.color,
    opacity: stroke.paint.opacity,
    fontSize: stroke.paint.fontSizePx ?? 13,
    fontFamily: stroke.paint.fontFamily ?? "sans-serif",
  });
  centreText(node);
  return node;
}

/** The planner emits a label's anchor point, which reads as its centre, not its corner. */
function centreText(node: Konva.Text): void {
  node.offsetX(node.width() / 2);
  node.offsetY(node.height() / 2);
}

/** `data:image/png;base64,...` -> bytes, without pulling in `Buffer`. */
function decodeDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const binary = atob(comma === -1 ? dataUrl : dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
