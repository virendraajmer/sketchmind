/**
 * Stroke timing (Volume 06 §Stroke Timing), D-6.
 *
 * Duration tracks path length, so a rope spanning the diagram takes longer than
 * a small circle -- a fixed duration for every stroke reads as a slideshow, not
 * as drawing. Results are rounded to whole milliseconds so a timeline summed
 * from them is exactly reproducible in floating point (AD-6).
 */
import type { Point, StrokeType } from "@sketchmind/shared-types";
import { pathLength } from "./geometry.js";

/** Milliseconds of pen travel per diagram unit, and the bounds it is clamped to. */
export const MS_PER_UNIT = 1.6;
export const MIN_DURATION_MS = 120;
export const MAX_DURATION_MS = 2000;

/** Text is charged per character: a label's "path" is a single point. */
export const MS_PER_CHARACTER = 45;
export const MIN_TEXT_DURATION_MS = 200;

/**
 * The beat a teacher leaves before starting a new kind of thing -- after the
 * outlines, before the labels. Applied at phase boundaries only, not between
 * every stroke, which would just make playback slow.
 */
export const PHASE_PAUSE_MS = 220;

export function durationFor(type: StrokeType, points: readonly Point[], text?: string): number {
  if (type === "text") {
    return Math.round(Math.max(MIN_TEXT_DURATION_MS, (text?.length ?? 0) * MS_PER_CHARACTER));
  }
  const raw = pathLength(points) * MS_PER_UNIT;
  return Math.round(Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, raw)));
}
