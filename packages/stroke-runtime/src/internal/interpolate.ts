/**
 * Partial-path interpolation for progressive rendering (Volume 06 §Incremental
 * Rendering).
 *
 * Deliberately duplicated rather than imported from `stroke-planner`: the two
 * packages are siblings in the `core` layer and a dependency between them would
 * exist solely for twenty lines of arithmetic, while making the runtime unusable
 * without the planner -- which is exactly the coupling that would stop a client
 * from replaying a Stroke AST it received over the wire.
 */
import type { Point } from "@sketchmind/shared-types";

const PRECISION = 4;

function round(value: number): number {
  const factor = 10 ** PRECISION;
  return Math.round(value * factor) / factor + 0;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1]!, points[i]!);
  return total;
}

/**
 * The prefix of `points` reached after travelling `fraction` of the path,
 * including the interpolated point mid-segment. A pen has drawn a partial line,
 * not a partial vertex, so the returned path always ends exactly where the pen
 * is.
 */
export function partialPath(points: readonly Point[], fraction: number): Point[] {
  if (points.length === 0) return [];
  if (fraction <= 0) return [points[0]!];
  if (fraction >= 1) return [...points];

  const total = pathLength(points);
  // A zero-length path (a text stroke, a degenerate one) has no "partway".
  if (total === 0) return [points[0]!];

  const target = total * fraction;
  const out: Point[] = [points[0]!];
  let travelled = 0;

  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1]!;
    const to = points[i]!;
    const segment = distance(from, to);
    if (travelled + segment >= target) {
      const t = segment === 0 ? 0 : (target - travelled) / segment;
      out.push({ x: round(from.x + (to.x - from.x) * t), y: round(from.y + (to.y - from.y) * t) });
      return out;
    }
    travelled += segment;
    out.push(to);
  }

  return out;
}

export function translate(points: readonly Point[], dx: number, dy: number): Point[] {
  return points.map((p) => ({ x: round(p.x + dx), y: round(p.y + dy) }));
}
