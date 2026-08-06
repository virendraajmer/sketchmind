/**
 * @sketchmind/stroke-runtime
 *
 * Playback and editing over a Stroke AST (Volume 06 §Stroke Runtime, §Editing,
 * §Incremental Rendering): play, pause, resume, seek, replay, undo, redo,
 * cancel, insert/delete/move/replace/reorder -- all while maintaining execution
 * state independently from rendering.
 *
 * Unlike every pipeline stage before it, this package is a stateful controller
 * rather than a transform. `createStrokeRuntime` validates once and returns a
 * `ValidationResult`; from there the runtime's methods return plain values,
 * because `pause()` returning a `ValidationResult` would be noise (Phase 7 D-1).
 *
 * The runtime owns no timers (D-8): it is a pure function of (strokes, timeMs)
 * driven by `advance(deltaMs)`, which the caller pumps. That is what makes
 * playback deterministic across runs, and what keeps a `core`-layer package from
 * assuming `requestAnimationFrame` exists.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */
import {
  StrokeASTSchema,
  parseWith,
  ok,
  type StrokeAST,
  type ValidationResult,
} from "@sketchmind/shared-types";
import { PACKAGE, StrokeRuntime, type StrokeRuntimeOptions } from "./internal/runtime.js";
import { buildTimeline } from "./internal/timeline.js";

export const PACKAGE_NAME = PACKAGE;
export const PACKAGE_VERSION = "0.0.1";

export { StrokeRuntime };
export type {
  DrawingFrame,
  PlaybackStatus,
  StrokeIndex,
  StrokeRuntimeOptions,
  StrokeRuntimeState,
} from "./internal/runtime.js";
export type { Timeline, TimelineEntry } from "./internal/timeline.js";
export { buildTimeline };

const origin = { package: PACKAGE, stage: "stroke" } as const;

/**
 * Build a runtime over a Stroke AST.
 *
 * Takes `unknown` because a Stroke AST commonly arrives over the wire (Phase 9's
 * SSE stream, a resumed checkpoint) rather than straight from `stroke-planner`,
 * and a client that trusted an unvalidated one would fail deep inside playback
 * instead of at the boundary.
 */
export function createStrokeRuntime(
  ast: unknown,
  options: StrokeRuntimeOptions = {},
): ValidationResult<StrokeRuntime> {
  const parsed = parseWith(StrokeASTSchema, ast, origin);
  if (!parsed.ok) return parsed;
  return ok(new StrokeRuntime(parsed.value as StrokeAST, options));
}
