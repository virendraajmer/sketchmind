/**
 * @sketchmind/export-engine
 *
 * Export to PNG, SVG, JSON, and replay packages (Volume 08 §Export).
 *
 * Phase 8 ships PNG, SVG, JSON and replay. PDF is Phase 12's, and deliberately
 * absent rather than stubbed: it needs a vector backend that can page, and
 * pretending otherwise would put a format in `RendererCapabilities` that no
 * renderer honours.
 *
 * The package is separate from the renderers because format policy is not backend
 * policy (Phase 8 D-6). Raster and vector exports go through the adapter contract;
 * JSON and replay packages are pure serialisation and need no renderer at all,
 * which is what lets `apps/api` export a diagram nobody is watching.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */
export const PACKAGE_NAME = "@sketchmind/export-engine";
export const PACKAGE_VERSION = "0.0.1";

export {
  exportJSON,
  exportPNG,
  exportReplayPackage,
  exportSVG,
  exportError,
} from "./internal/exporters.js";
export type {
  ExportErrorCode,
  ReplayPackage,
  ReplayPackageOptions,
} from "./internal/exporters.js";
