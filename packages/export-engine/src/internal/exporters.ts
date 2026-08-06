/**
 * Export formats (Volume 08 §Export): PNG, SVG, JSON, replay package.
 *
 * This is a separate package from the renderers because format policy is not
 * backend policy (D-6). Two of these formats need a surface and go through the
 * adapter; the other two are pure serialisation of the Stroke AST and would work
 * with no renderer in the process at all -- which is exactly what `apps/api` will
 * want when it exports a diagram nobody is currently watching.
 *
 * `export-engine` sits in `core`, one layer above `renderer`, so depending on
 * `renderer-core` is legal. Depending on a *specific* backend would not be, and
 * is not needed: `RendererAdapter` is the whole contract.
 */
import type { CapturedImage, RendererAdapter } from "@sketchmind/renderer-core";
import {
  fail,
  makeError,
  ok,
  type SketchMindError,
  type StrokeAST,
  type ValidationResult,
} from "@sketchmind/shared-types";

export const PACKAGE = "@sketchmind/export-engine";

export type ExportErrorCode =
  | "EXPORT_UNSUPPORTED_FORMAT"
  | "EXPORT_EMPTY_DIAGRAM"
  | "EXPORT_ADAPTER_FAILED";

export function exportError(
  code: ExportErrorCode,
  message: string,
  details?: Record<string, unknown>,
): SketchMindError {
  return makeError({
    code,
    message,
    package: PACKAGE,
    stage: "export",
    recoverable: false,
    ...(details === undefined ? {} : { details }),
  });
}

/**
 * Rasterise the current canvas.
 *
 * Delegates to `captureImage` rather than re-rendering: the pixels a user is
 * looking at are the pixels they expect to get, and a second render path is a
 * second thing that can disagree.
 */
export function exportPNG(adapter: RendererAdapter): ValidationResult<CapturedImage> {
  if (!adapter.capabilities.raster) {
    return fail([
      exportError(
        "EXPORT_UNSUPPORTED_FORMAT",
        `Renderer "${adapter.capabilities.id}" produces no raster output; PNG export needs one that does.`,
        { renderer: adapter.capabilities.id },
      ),
    ]);
  }
  const captured = adapter.export("png");
  if (!captured.ok) return captured;
  if (captured.value.data.length === 0) {
    return fail([exportError("EXPORT_ADAPTER_FAILED", "The renderer returned an empty image.")]);
  }
  return ok(captured.value);
}

export function exportSVG(adapter: RendererAdapter): ValidationResult<CapturedImage> {
  if (!adapter.capabilities.vector) {
    return fail([
      exportError(
        "EXPORT_UNSUPPORTED_FORMAT",
        `Renderer "${adapter.capabilities.id}" produces no vector output; SVG export needs one that does.`,
        { renderer: adapter.capabilities.id },
      ),
    ]);
  }
  return adapter.export("svg");
}

/**
 * The Stroke AST itself, pretty-printed.
 *
 * "Export must preserve diagram fidelity" (Volume 08) is trivially satisfied by
 * the model that *is* the diagram, and this is the format Phase 12's checkpoints
 * and caches read.
 */
export function exportJSON(ast: StrokeAST): ValidationResult<string> {
  if (ast.strokes.length === 0) {
    return fail([exportError("EXPORT_EMPTY_DIAGRAM", "This diagram has no strokes to export.")]);
  }
  return ok(JSON.stringify(ast, null, 2));
}

export interface ReplayPackage {
  readonly format: "sketchmind-replay";
  readonly version: 1;
  readonly diagramId: string;
  readonly totalDurationMs: number;
  readonly strokeCount: number;
  readonly ast: StrokeAST;
  /** Optional still of the finished drawing, base64-encoded with its mime type. */
  readonly preview?: { readonly mimeType: string; readonly base64: string };
  readonly exportedAt: string;
}

export interface ReplayPackageOptions {
  /** Include a rendered still. Requires an adapter that can capture. */
  readonly adapter?: RendererAdapter;
  /** Injectable clock, so a replay package can be byte-reproducible in a test. */
  readonly now?: () => string;
}

/**
 * A self-contained replay: the drawing sequence plus enough metadata to play it
 * back without the pipeline that produced it.
 *
 * The preview is optional and failure to capture it is not an export failure --
 * a replay package without a thumbnail still replays, and refusing to export
 * because a canvas was busy would be the wrong trade.
 */
export function exportReplayPackage(
  ast: StrokeAST,
  options: ReplayPackageOptions = {},
): ValidationResult<ReplayPackage> {
  if (ast.strokes.length === 0) {
    return fail([exportError("EXPORT_EMPTY_DIAGRAM", "This diagram has no strokes to export.")]);
  }

  let preview: ReplayPackage["preview"];
  if (options.adapter?.capabilities.captureImage) {
    const captured = options.adapter.captureImage();
    if (captured.ok) {
      preview = { mimeType: captured.value.mimeType, base64: toBase64(captured.value.data) };
    }
  }

  return ok({
    format: "sketchmind-replay",
    version: 1,
    diagramId: ast.diagramId,
    totalDurationMs: ast.totalDurationMs ?? 0,
    strokeCount: ast.strokes.length,
    ast,
    ...(preview === undefined ? {} : { preview }),
    exportedAt: (options.now ?? (() => new Date().toISOString()))(),
  });
}

/** `btoa` over bytes, chunked so a large PNG does not blow the argument limit. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
