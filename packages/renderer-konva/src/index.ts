/**
 * @sketchmind/renderer-konva
 *
 * The Konva rendering backend -- the first real pixels in the system.
 *
 * It is small on purpose. Phase 8 D-1 put the layer model, viewport transform,
 * jitter, tone resolution, hit-testing and stroke-to-geometry conversion in
 * `renderer-core`, so this package only knows how to put an already-computed
 * polyline on a Konva stage. That is what lets `renderer-svg` draw the same
 * picture rather than a similar one.
 *
 * Konva also runs headless under Node against `node-canvas`, which is how the
 * test suite asserts real PNG bytes and real hit-testing rather than a screenshot
 * someone eyeballs (D-9). The shim that arranges that lives in the tests; `src/`
 * has no idea Node exists and `canvas` is a devDependency, never in a bundle.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */
import {
  rendererRegistry,
  type RendererAdapter,
  type RendererFactory,
  type RendererOptions,
} from "@sketchmind/renderer-core";
import { fail, ok, type ValidationResult } from "@sketchmind/shared-types";
import { KonvaRendererAdapter, KONVA_CAPABILITIES, RENDERER_ID } from "./internal/adapter.js";

export const PACKAGE_NAME = "@sketchmind/renderer-konva";
export const PACKAGE_VERSION = "0.0.1";

export { KonvaRendererAdapter, KONVA_CAPABILITIES, RENDERER_ID };

/**
 * Build and initialize a Konva renderer.
 *
 * Construction and initialization are one call because a half-built adapter is
 * not something any caller wants to hold; the two-step form still exists on the
 * adapter for Volume 08's lifecycle contract.
 */
export function createKonvaRenderer(options: RendererOptions): ValidationResult<RendererAdapter> {
  const adapter = new KonvaRendererAdapter();
  const initialized = adapter.initialize(options);
  if (!initialized.ok) return fail(initialized.errors);
  return ok(adapter);
}

export const konvaRendererFactory: RendererFactory = {
  capabilities: KONVA_CAPABILITIES,
  create: createKonvaRenderer,
};

/**
 * Register with the process-wide registry.
 *
 * Explicit rather than an import side effect: a module that mutates global state
 * on import is invisible at the call site and impossible to opt out of, and
 * `apps/web` should be able to choose its backends.
 */
export function registerKonvaRenderer(): ValidationResult<void> {
  return rendererRegistry.register(konvaRendererFactory);
}
