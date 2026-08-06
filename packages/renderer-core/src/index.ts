/**
 * @sketchmind/renderer-core
 *
 * The renderer SDK (Volume 08): adapter contract, layer model, viewport,
 * hit-testing, registry -- plus everything that is not backend-specific.
 *
 * The split against the backends is deliberate and load-bearing (Phase 8 D-1).
 * The obvious division is "core defines interfaces, backends do the work"; that
 * produces two backends that quietly disagree about geometry and a pixel-diff
 * test that can only cover one of them. So core owns the layer model, the
 * viewport transform, jitter synthesis, tone resolution, hit-testing, and
 * stroke-to-geometry conversion, and a backend contributes exactly one thing:
 * how to put an already-computed polyline on its surface.
 *
 * Volume 08's constraint holds structurally, not by convention: this package
 * depends only on `shared-types`, so nothing here can call an LLM, compute a
 * layout, or generate a stroke. There is nothing to call.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */
export const PACKAGE_NAME = "@sketchmind/renderer-core";
export const PACKAGE_VERSION = "0.0.1";

// -------------------------------------------------------------- the contract
export type {
  CapturedImage,
  ExportFormat,
  RenderFrame,
  RendererAdapter,
  RendererCapabilities,
  RendererFactory,
  RendererOptions,
} from "./internal/adapter.js";
export { BaseRendererAdapter } from "./internal/base.js";

// --------------------------------------------------------------- layer model
export { LAYER_ORDER, isLayerName, layerDepth, layerForStroke } from "./internal/layers.js";
export type { LayerName } from "./internal/layers.js";

// ------------------------------------------------------------------ viewport
export {
  Viewport,
  DEFAULT_FIT_PADDING,
  DEFAULT_MAX_ZOOM,
  DEFAULT_MIN_ZOOM,
} from "./internal/viewport.js";
export type { ViewportOptions, ViewportState } from "./internal/viewport.js";

// ---------------------------------------------------------- display geometry
export { ARROWHEAD_WIDTH_FACTOR, displayBounds, resolveStroke } from "./internal/display.js";
export type { DisplayStroke, StrokePaint } from "./internal/display.js";
export { Scene, EMPTY_DIFF } from "./internal/scene.js";
export type { SceneDiff } from "./internal/scene.js";

// --------------------------------------------------------------------- theme
export { DEFAULT_THEME, capForPressure, mergeTheme, resolveTone } from "./internal/theme.js";
export type { LineCap, RendererTheme } from "./internal/theme.js";

// -------------------------------------------------------------------- jitter
export {
  JITTER_SCALE,
  JITTER_SEGMENT_MAX,
  applyJitter,
  hashStrokeId,
  mulberry32,
} from "./internal/jitter.js";

// --------------------------------------------------------------- hit-testing
export { DEFAULT_HIT_TOLERANCE, hitTest, hitTestAll, hitTestRegion } from "./internal/hittest.js";
export type { HitTestOptions, HitTestResult } from "./internal/hittest.js";

// --------------------------------------------------------------------- maths
export {
  arcLengths,
  boundsOf,
  distance,
  distanceToPolyline,
  distanceToSegment,
  normalAt,
  pathLength,
  trimPolyline,
} from "./internal/geometry.js";

// ------------------------------------------------------------------ registry
export { RendererRegistry, rendererRegistry } from "./internal/registry.js";
export type { RendererRequirements } from "./internal/registry.js";

// -------------------------------------------------------------------- errors
export { renderError } from "./internal/errors.js";
export type { RenderErrorCode } from "./internal/errors.js";
