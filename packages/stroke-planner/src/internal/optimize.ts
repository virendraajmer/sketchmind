/**
 * Stroke optimizer (Volume 06 §Stroke Optimizer): "merge compatible strokes,
 * remove redundant strokes, preserve natural drawing order, improve playback
 * performance -- must never change semantic meaning."
 *
 * The last clause is the hard one, and stroke count is the wrong way to check
 * it: merging two collinear segments into one is precisely what this pass is
 * for. What must hold is **object coverage** (D-7) -- every target that had
 * strokes still has strokes, drawn with the same set of stroke types. That
 * invariant is asserted here, not only in a test, so a future pass that breaks
 * it fails loudly at the point of breakage.
 *
 * Every pass preserves relative order, so "natural drawing order" survives by
 * construction rather than by re-sorting afterwards.
 */
import type { SketchMindError, Stroke, StrokeStyle } from "@sketchmind/shared-types";
import { collapseCollinear, distinctPointCount, samePoint } from "./geometry.js";
import { err, totalDuration } from "./plan.js";
import { durationFor } from "./timing.js";

/**
 * Stroke types whose points are a free polyline, so two of them can become one.
 * `arrow` is deliberately absent: merging two arrows would leave one arrowhead
 * where the diagram asked for two.
 */
const MERGEABLE: ReadonlySet<Stroke["type"]> = new Set(["line", "curve", "freehand"]);

/** Types whose interior points may be thinned without changing the shape drawn. */
const THINNABLE: ReadonlySet<Stroke["type"]> = new Set(["line", "curve", "freehand", "polygon", "arrow"]);

/** target -> the set of stroke types drawn for it. The thing that must not change. */
type Coverage = Map<string, Set<string>>;

function coverageOf(strokes: readonly Stroke[]): Coverage {
  const coverage: Coverage = new Map();
  for (const stroke of strokes) {
    const types = coverage.get(stroke.target) ?? new Set<string>();
    types.add(stroke.type);
    coverage.set(stroke.target, types);
  }
  return coverage;
}

function coverageDiff(before: Coverage, after: Coverage): string[] {
  const changed: string[] = [];
  for (const [target, types] of before) {
    const now = after.get(target);
    if (!now || [...types].some((t) => !now.has(t))) changed.push(target);
  }
  for (const target of after.keys()) {
    if (!before.has(target)) changed.push(target);
  }
  return [...new Set(changed)].sort();
}

function sameStyle(a: StrokeStyle, b: StrokeStyle): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Remove strokes whose path has fewer than two distinct points -- a pen put
 * down and lifted without moving. Text is exempt (a label is legitimately one
 * point), and a stroke is kept regardless if it is the last one its target has:
 * a degenerate drawing of an object is still a drawing of it, and silently
 * dropping the object would be exactly the semantic change this pass forbids.
 */
function dropDegenerate(strokes: readonly Stroke[]): Stroke[] {
  const remaining = new Map<string, number>();
  for (const stroke of strokes) remaining.set(stroke.target, (remaining.get(stroke.target) ?? 0) + 1);

  const kept: Stroke[] = [];
  for (const stroke of strokes) {
    const degenerate = stroke.type !== "text" && distinctPointCount(stroke.points) < 2;
    const count = remaining.get(stroke.target) ?? 0;
    if (degenerate && count > 1) {
      remaining.set(stroke.target, count - 1);
      continue;
    }
    kept.push(stroke);
  }
  return kept;
}

/** Drop a stroke that redraws exactly what the stroke before it just drew. */
function dropDuplicates(strokes: readonly Stroke[]): Stroke[] {
  const kept: Stroke[] = [];
  for (const stroke of strokes) {
    const previous = kept[kept.length - 1];
    const duplicate =
      previous !== undefined &&
      previous.target === stroke.target &&
      previous.type === stroke.type &&
      JSON.stringify(previous.points) === JSON.stringify(stroke.points);
    if (!duplicate) kept.push(stroke);
  }
  return kept;
}

/**
 * Join consecutive polyline strokes on the same target when the pen never left
 * the surface between them -- the second starts exactly where the first ended.
 * This is Volume 06's "draw connected objects continuously" realised as data
 * rather than as a hope about ordering.
 */
function mergeCompatible(strokes: readonly Stroke[]): Stroke[] {
  const kept: Stroke[] = [];
  for (const stroke of strokes) {
    const previous = kept[kept.length - 1];
    const mergeable =
      previous !== undefined &&
      previous.target === stroke.target &&
      previous.type === stroke.type &&
      MERGEABLE.has(stroke.type) &&
      previous.timing.pauseAfterMs === 0 &&
      sameStyle(previous.style, stroke.style) &&
      // Metadata identifies *what* a stroke realises -- which relationship, which
      // label. Two strokes carrying different metadata are two different claims
      // about the diagram, and merging them would drop one of them.
      JSON.stringify(previous.metadata ?? null) === JSON.stringify(stroke.metadata ?? null) &&
      samePoint(previous.points[previous.points.length - 1]!, stroke.points[0]!);

    if (!mergeable) {
      kept.push(stroke);
      continue;
    }

    const points = [...previous.points, ...stroke.points.slice(1)];
    kept[kept.length - 1] = {
      ...previous,
      points,
      timing: {
        ...previous.timing,
        durationMs: durationFor(previous.type, points),
        pauseAfterMs: stroke.timing.pauseAfterMs,
      },
    };
  }
  return kept;
}

function thinPoints(strokes: readonly Stroke[]): Stroke[] {
  return strokes.map((stroke) => {
    if (!THINNABLE.has(stroke.type)) return stroke;
    const points = collapseCollinear(stroke.points);
    return points.length === stroke.points.length ? stroke : { ...stroke, points };
  });
}

/** Renumber `order` and rewire `dependencies` onto the surviving predecessor. */
function resequence(strokes: readonly Stroke[]): Stroke[] {
  return strokes.map((stroke, index) => ({
    ...stroke,
    order: index,
    dependencies: index === 0 ? [] : [strokes[index - 1]!.id],
  }));
}

export interface OptimizedStrokes {
  readonly strokes: Stroke[];
  readonly totalDurationMs: number;
}

export type OptimizeOutcome =
  | { readonly ok: true; readonly value: OptimizedStrokes }
  | { readonly ok: false; readonly errors: SketchMindError[] };

export function optimize(strokes: readonly Stroke[]): OptimizeOutcome {
  const before = coverageOf(strokes);
  const optimized = resequence(thinPoints(mergeCompatible(dropDuplicates(dropDegenerate(strokes)))));
  const changed = coverageDiff(before, coverageOf(optimized));

  if (changed.length > 0) {
    return {
      ok: false,
      errors: [
        err(
          "STROKE_OPTIMIZER_COVERAGE_CHANGED",
          `Optimization would change which objects are drawn: ${changed.join(", ")}. The unoptimized plan is the correct output.`,
          "strokes",
          { targets: changed },
        ),
      ],
    };
  }

  return { ok: true, value: { strokes: optimized, totalDurationMs: totalDuration(optimized) } };
}
