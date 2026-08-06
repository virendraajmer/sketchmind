/**
 * Renderer error codes.
 *
 * Same contract as every stage before it (Phase 7 D-1): a `ValidationResult`,
 * never a throw. A renderer that cannot mount is an agent observation -- Phase 10
 * needs to read "no container" as a fact about the world, not catch it.
 *
 * Errors that describe a *programming* mistake rather than bad input are
 * `recoverable: false`: no amount of the agent trying again fixes an adapter that
 * was never registered.
 */
import { makeError, type SketchMindError } from "@sketchmind/shared-types";

export const PACKAGE = "@sketchmind/renderer-core";

export type RenderErrorCode =
  | "RENDER_INVALID_OPTIONS"
  | "RENDER_CONTAINER_REQUIRED"
  | "RENDER_NOT_INITIALIZED"
  | "RENDER_ALREADY_INITIALIZED"
  | "RENDER_UNSUPPORTED_FORMAT"
  | "RENDER_UNKNOWN_LAYER"
  | "RENDER_ADAPTER_NOT_REGISTERED"
  | "RENDER_DUPLICATE_ADAPTER"
  | "RENDER_NO_COMPATIBLE_RENDERER"
  | "RENDER_CAPTURE_FAILED";

export function renderError(
  code: RenderErrorCode,
  message: string,
  options: {
    pkg?: string;
    path?: string;
    recoverable?: boolean;
    details?: Record<string, unknown>;
  } = {},
): SketchMindError {
  return makeError({
    code,
    message,
    package: options.pkg ?? PACKAGE,
    stage: "render",
    recoverable: options.recoverable ?? false,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.details === undefined ? {} : { details: options.details }),
  });
}
