/**
 * The half of every adapter that is not backend-specific (D-1).
 *
 * Lifecycle, options validation, the scene, the viewport, layer visibility, and
 * hit-testing are identical whether the surface is a canvas or an SVG document.
 * A backend extends this and implements four things: mount, unmount, paint a
 * diff, and produce bytes. `renderer-konva` is ~300 lines because of this class,
 * and `renderer-svg` is under 200.
 */
import type {
  BoundingBox,
  Point,
  Size,
  Stroke,
  ValidationResult,
} from "@sketchmind/shared-types";
import { fail, ok } from "@sketchmind/shared-types";
import type {
  CapturedImage,
  ExportFormat,
  RenderFrame,
  RendererAdapter,
  RendererCapabilities,
  RendererOptions,
} from "./adapter.js";
import { displayBounds, type DisplayStroke } from "./display.js";
import { renderError } from "./errors.js";
import { hitTest, type HitTestOptions, type HitTestResult } from "./hittest.js";
import { LAYER_ORDER, type LayerName } from "./layers.js";
import { Scene, type SceneDiff } from "./scene.js";
import { mergeTheme, type RendererTheme } from "./theme.js";
import { Viewport } from "./viewport.js";

export abstract class BaseRendererAdapter implements RendererAdapter {
  abstract readonly capabilities: RendererCapabilities;

  #scene: Scene | null = null;
  #viewport: Viewport | null = null;
  #options: RendererOptions | null = null;
  #hidden = new Set<LayerName>();

  // ------------------------------------------------------- backend contract

  /** Create the surface. Called once per `initialize`, after options validate. */
  protected abstract mount(options: RendererOptions, theme: RendererTheme): ValidationResult<void>;
  /** Tear the surface down. Must tolerate being called on a half-built adapter. */
  protected abstract unmount(): void;
  /** Reflect a diff on the surface. */
  protected abstract paint(diff: SceneDiff): void;
  /** Push the current viewport transform and canvas size onto the surface. */
  protected abstract applyViewport(): void;
  /** Show or hide a whole layer. */
  protected abstract applyLayerVisibility(layer: LayerName, visible: boolean): void;
  protected abstract capture(format: ExportFormat): ValidationResult<CapturedImage>;

  // -------------------------------------------------------------- lifecycle

  initialize(options: RendererOptions): ValidationResult<void> {
    if (this.#scene) {
      return fail([
        renderError("RENDER_ALREADY_INITIALIZED", "This adapter is already initialized; destroy it first."),
      ]);
    }
    const invalid = validateOptions(options);
    if (invalid) return fail([invalid]);

    const theme = mergeTheme(options.theme);
    const viewport = new Viewport(options.size, options.viewport);
    const mounted = this.mount(options, theme);
    if (!mounted.ok) return mounted;

    this.#options = options;
    this.#scene = new Scene(theme);
    this.#viewport = viewport;
    this.#hidden = new Set(options.hiddenLayers ?? []);

    this.applyViewport();
    for (const layer of LAYER_ORDER) this.applyLayerVisibility(layer, !this.#hidden.has(layer));
    return ok(undefined);
  }

  destroy(): void {
    this.unmount();
    this.#scene = null;
    this.#viewport = null;
    this.#options = null;
    this.#hidden = new Set();
  }

  protected get initialized(): boolean {
    return this.#scene !== null;
  }

  protected get options(): RendererOptions {
    if (!this.#options) throw new Error(`${this.capabilities.id}: adapter is not initialized`);
    return this.#options;
  }

  protected get theme(): RendererTheme {
    return this.#requireScene().theme();
  }

  #requireScene(): Scene {
    if (!this.#scene) throw new Error(`${this.capabilities.id}: adapter is not initialized`);
    return this.#scene;
  }

  /**
   * Drawing before `initialize` is a caller bug, not bad data, so it is dropped
   * with no error rather than crashing a render loop mid-frame. `export` and
   * `captureImage` do report it -- they have a `ValidationResult` to say it in.
   */
  #sceneOrNull(): Scene | null {
    return this.#scene;
  }

  // ----------------------------------------------------------------- drawing

  drawStroke(stroke: Stroke): void {
    const scene = this.#sceneOrNull();
    if (scene) this.paint(scene.set(stroke, 1));
  }

  updateStroke(stroke: Stroke): void {
    const scene = this.#sceneOrNull();
    if (scene) this.paint(scene.set(stroke, scene.get(stroke.id)?.progress ?? 1));
  }

  eraseStroke(strokeId: string): void {
    const scene = this.#sceneOrNull();
    if (scene) this.paint(scene.remove(strokeId));
  }

  renderFrame(frame: RenderFrame): void {
    const scene = this.#sceneOrNull();
    if (scene) this.paint(scene.applyFrame(frame));
  }

  clear(): void {
    const scene = this.#sceneOrNull();
    if (scene) this.paint(scene.clear());
  }

  // ---------------------------------------------------------------- viewport

  viewport(): Viewport {
    if (!this.#viewport) throw new Error(`${this.capabilities.id}: adapter is not initialized`);
    return this.#viewport;
  }

  resizeViewport(size: Size): void {
    if (!this.#viewport) return;
    this.#viewport.resize(size);
    this.applyViewport();
  }

  /**
   * Fit to explicit bounds, or to whatever is currently drawn. Calling it with no
   * bounds before anything is drawn is a no-op, not a divide-by-zero -- Phase 9
   * mounts the canvas before the first stroke arrives.
   */
  fitToContent(bounds?: BoundingBox): void {
    if (!this.#viewport) return;
    const target = bounds ?? displayBounds(this.displayStrokes());
    if (target.width === 0 && target.height === 0) return;
    this.#viewport.fitToContent(target);
    this.applyViewport();
  }

  // ------------------------------------------------------------------ layers

  setLayerVisible(layer: LayerName, visible: boolean): void {
    if (visible) this.#hidden.delete(layer);
    else this.#hidden.add(layer);
    if (this.initialized) this.applyLayerVisibility(layer, visible);
  }

  isLayerVisible(layer: LayerName): boolean {
    return !this.#hidden.has(layer);
  }

  protected hiddenLayers(): ReadonlySet<LayerName> {
    return this.#hidden;
  }

  // ------------------------------------------------------- inspection & hits

  displayStrokes(): readonly DisplayStroke[] {
    return this.#sceneOrNull()?.strokes() ?? [];
  }

  /** Hit-testing ignores hidden layers: you cannot click what you cannot see. */
  hitTest(point: Point, options: HitTestOptions = {}): HitTestResult | null {
    const layers = options.layers ?? LAYER_ORDER.filter((layer) => !this.#hidden.has(layer));
    return hitTest(this.displayStrokes(), point, { ...options, layers });
  }

  // ------------------------------------------------------------------ output

  export(format: ExportFormat): ValidationResult<CapturedImage> {
    if (!this.initialized) {
      return fail([renderError("RENDER_NOT_INITIALIZED", "Cannot export before initialize().")]);
    }
    if (!this.capabilities.exportFormats.includes(format)) {
      return fail([
        renderError("RENDER_UNSUPPORTED_FORMAT", `${this.capabilities.id} cannot export "${format}".`, {
          details: { requested: format, supported: this.capabilities.exportFormats },
        }),
      ]);
    }
    return this.capture(format);
  }

  captureImage(): ValidationResult<CapturedImage> {
    return this.export(this.capabilities.raster ? "png" : "svg");
  }
}

function validateOptions(options: RendererOptions): ReturnType<typeof renderError> | null {
  const { width, height } = options.size ?? {};
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return renderError("RENDER_INVALID_OPTIONS", "size.width and size.height must be positive numbers.", {
      path: "size",
      details: { size: options.size },
    });
  }
  if (options.pixelRatio !== undefined && (!Number.isFinite(options.pixelRatio) || options.pixelRatio <= 0)) {
    return renderError("RENDER_INVALID_OPTIONS", "pixelRatio must be a positive number.", {
      path: "pixelRatio",
      details: { pixelRatio: options.pixelRatio },
    });
  }
  return null;
}
