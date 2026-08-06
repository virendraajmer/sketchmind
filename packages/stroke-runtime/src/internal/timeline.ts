/**
 * The timeline (Volume 06 §Stroke Timing): absolute start and end times derived
 * from each stroke's own delay, duration, and trailing pause.
 *
 * Sequencing is expressed twice in the Stroke AST on purpose -- `dependencies`
 * is the semantic claim ("this stroke cannot start until that one finishes"),
 * the timeline is the operational one ("it starts at 3140ms"). A renderer that
 * streams out of order reads the first; a scrubber reads the second. This file
 * builds the second, and reads durations as given rather than recomputing them,
 * so an edited stroke keeps whatever timing the editor chose.
 */
import type { Stroke } from "@sketchmind/shared-types";

export interface TimelineEntry {
  readonly strokeId: string;
  /** Position in the sequence, identical to the stroke's `order`. */
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  /** End of this stroke's trailing pause -- when the next stroke may begin. */
  readonly settledMs: number;
}

export interface Timeline {
  readonly entries: readonly TimelineEntry[];
  readonly totalDurationMs: number;
}

export function buildTimeline(strokes: readonly Stroke[]): Timeline {
  const entries: TimelineEntry[] = [];
  let cursor = 0;

  strokes.forEach((stroke, index) => {
    const startMs = cursor + stroke.timing.delayMs;
    const endMs = startMs + stroke.timing.durationMs;
    const settledMs = endMs + stroke.timing.pauseAfterMs;
    entries.push({ strokeId: stroke.id, index, startMs, endMs, settledMs });
    cursor = settledMs;
  });

  return { entries, totalDurationMs: cursor };
}

/**
 * The stroke being drawn at `timeMs`, if any. Entries are non-overlapping and
 * ascending, so the first match is the only match -- a linear scan is correct
 * and, at diagram scale, faster than a binary search over a fresh array.
 */
export function entryAt(timeline: Timeline, timeMs: number): TimelineEntry | undefined {
  return timeline.entries.find((entry) => timeMs >= entry.startMs && timeMs < entry.endMs);
}

export function completedCount(timeline: Timeline, timeMs: number): number {
  let count = 0;
  for (const entry of timeline.entries) {
    if (entry.endMs > timeMs) break;
    count += 1;
  }
  return count;
}
