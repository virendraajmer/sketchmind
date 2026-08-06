/** SVG-specific error construction: `renderer-core`'s codes, this package's name. */
import { renderError, type RenderErrorCode } from "@sketchmind/renderer-core";
import type { SketchMindError } from "@sketchmind/shared-types";

export const PACKAGE = "@sketchmind/renderer-svg";

export function svgError(
  code: RenderErrorCode,
  message: string,
  options: { recoverable?: boolean; details?: Record<string, unknown> } = {},
): SketchMindError {
  return renderError(code, message, { ...options, pkg: PACKAGE });
}
