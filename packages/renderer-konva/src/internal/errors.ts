/**
 * Konva-specific error construction: the same codes `renderer-core` defines,
 * attributed to this package so a failure names the backend that produced it.
 */
import { renderError, type RenderErrorCode } from "@sketchmind/renderer-core";
import type { SketchMindError } from "@sketchmind/shared-types";

export const PACKAGE = "@sketchmind/renderer-konva";

export function konvaError(
  code: RenderErrorCode,
  message: string,
  options: { recoverable?: boolean; details?: Record<string, unknown> } = {},
): SketchMindError {
  return renderError(code, message, { ...options, pkg: PACKAGE });
}
