/**
 * The renderer adapter contract (Volume 08 §Renderer Adapter).
 *
 * Every backend implements exactly this, and nothing above the renderer layer
 * ever names a backend type. `apps/web` resolves an adapter through the registry
 * so Phase 12's plugin backends are a registration, not a code change.
 *
 * Volume 08's constraint holds here structurally, not just by convention: this
 * package's only dependency is `shared-types`, so a renderer *cannot* call an
 * LLM, compute layout, or generate strokes -- there is nothing here to call.
 */
import type {
  BoundingBox,
  DrawingFrame,
  Point,
  Size,
  Stroke,
  ValidationResult,
} from "@sketchmind/shared-types";
import type { DisplayStroke } from "./display.js";
import type { HitTestOptions, HitTestResult } from "./hittest.js";
import type { LayerName } from "./layers.js";
import type { RendererTheme } from "./theme.js";
import type { Viewport, ViewportOptions } from "./viewport.js";

/**
 * What a progressive renderer is given each tick.
 *
 * This was a hand-written twin of `stroke-runtime`'s `DrawingFrame`, duplicated
 * because `renderer` sits below `core` and importing across that line is an
 * upward dependency (D-2), with `tests/render-pipeline.test.ts` policing the
 * drift. Phase 9 put the frame on the wire, which earned it a real schema in
 * `shared-types` -- the one package both layers already depend on -- so the twin
 * is now an alias and there is nothing left to drift.
 *
 * The name stays: a backend receives a frame to *render*, and `RenderFrame` is
 * what the adapter contract has always called it.
 *
 * `inProgress.points` are advisory -- `progress` is what the renderer uses (D-3).
 */
export type RenderFrame = DrawingFrame;

export type ExportFormat = "png" | "svg";

/**
 * Raw bytes, not a data URL. Phase 10 puts this in a request body, and base64 is
 * 33% larger for no benefit at that boundary.
 */
export interface CapturedImage {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * Callers branch on capabilities, never on `id` -- the same rule the LLM provider
 * abstraction enforces, for the same reason.
 */
export interface RendererCapabilities {
  readonly id: string;
  /** Produces pixels (PNG). */
  readonly raster: boolean;
  /** Produces vector output (SVG, PDF). */
  readonly vector: boolean;
  /** Has a live surface that can receive pointer events. */
  readonly interactive: boolean;
  readonly exportFormats: readonly ExportFormat[];
  /** Supports `captureImage` -- required by Phase 10's vision critique (AD-3). */
  readonly captureImage: boolean;
}

export interface RendererOptions {
  readonly size: Size;
  /**
   * Backend-specific mount point (a DOM element for Konva). `unknown` because
   * `renderer-core` must not depend on the DOM: it is imported by `export-engine`,
   * which runs server-side.
   */
  readonly container?: unknown;
  readonly theme?: Partial<RendererTheme>;
  readonly viewport?: ViewportOptions;
  /** Device pixel ratio for raster output. Defaults to 1 for reproducible exports. */
  readonly pixelRatio?: number;
  /** Layers hidden from the start -- how the pixel-diff baseline excludes text (D-8). */
  readonly hiddenLayers?: readonly LayerName[];
}

export interface RendererAdapter {
  readonly capabilities: RendererCapabilities;

  // -------------------------------------------------------------- lifecycle
  initialize(options: RendererOptions): ValidationResult<void>;
  destroy(): void;

  // ----------------------------------------------------------------- drawing
  drawStroke(stroke: Stroke): void;
  eraseStroke(strokeId: string): void;
  updateStroke(stroke: Stroke): void;
  /** Reconcile the surface against a frame. Idempotent (D-7). */
  renderFrame(frame: RenderFrame): void;
  /** Remove every stroke, keeping the surface and viewport. */
  clear(): void;

  // ---------------------------------------------------------------- viewport
  resizeViewport(size: Size): void;
  viewport(): Viewport;
  fitToContent(bounds?: BoundingBox): void;

  // ------------------------------------------------------------------ layers
  setLayerVisible(layer: LayerName, visible: boolean): void;
  isLayerVisible(layer: LayerName): boolean;

  // ------------------------------------------------------- inspection & hits
  /** Currently drawn strokes as resolved geometry. What hit-testing and exports read. */
  displayStrokes(): readonly DisplayStroke[];
  /** `point` is layout space; a pointer event must go through `viewport().toWorld` first. */
  hitTest(point: Point, options?: HitTestOptions): HitTestResult | null;

  // ------------------------------------------------------------------ output
  export(format: ExportFormat): ValidationResult<CapturedImage>;
  /** The canvas as an image, for Phase 10's vision self-correction (AD-3). */
  captureImage(): ValidationResult<CapturedImage>;
}

/** A backend, as the registry sees it. */
export interface RendererFactory {
  readonly capabilities: RendererCapabilities;
  create(options: RendererOptions): ValidationResult<RendererAdapter>;
}
