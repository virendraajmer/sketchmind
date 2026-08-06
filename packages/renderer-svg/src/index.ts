/**
 * @sketchmind/renderer-svg
 *
 * The SVG rendering backend -- the one that proves the SDK is backend-agnostic
 * rather than Konva with extra steps.
 *
 * It is a working renderer, not a stub (Phase 8 D-10): a second backend that does
 * not run proves nothing, which is precisely why `llm-provider-anthropic` exists
 * one layer down. It needs no canvas, no DOM and no native module, so it renders
 * server-side and in any test environment, and its output is a text document you
 * can diff.
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
import { SvgRendererAdapter, SVG_CAPABILITIES, RENDERER_ID } from "./internal/adapter.js";

export const PACKAGE_NAME = "@sketchmind/renderer-svg";
export const PACKAGE_VERSION = "0.0.1";

export { SvgRendererAdapter, SVG_CAPABILITIES, RENDERER_ID };

/** Build and initialize an SVG renderer. `options.container` is ignored. */
export function createSvgRenderer(options: RendererOptions): ValidationResult<SvgRendererAdapter> {
  const adapter = new SvgRendererAdapter();
  const initialized = adapter.initialize(options);
  if (!initialized.ok) return fail(initialized.errors);
  return ok(adapter);
}

export const svgRendererFactory: RendererFactory = {
  capabilities: SVG_CAPABILITIES,
  create: (options: RendererOptions): ValidationResult<RendererAdapter> => createSvgRenderer(options),
};

/** Register with the process-wide registry. Explicit, never an import side effect. */
export function registerSvgRenderer(): ValidationResult<void> {
  return rendererRegistry.register(svgRendererFactory);
}
