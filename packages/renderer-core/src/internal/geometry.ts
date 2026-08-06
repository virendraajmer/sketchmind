/**
 * Polyline maths shared by every backend.
 *
 * `stroke-planner` has its own geometry module and this is not a duplicate of it:
 * that one *builds* paths from layout boxes, this one *measures and cuts* paths
 * that already exist. The two never need the same function, which is why neither
 * imports the other (and could not -- `renderer` sits below `core`).
 */
import type { Point } from "@sketchmind/shared-types";

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Cumulative arc length at each vertex; `[0]` is always 0. */
export function arcLengths(points: readonly Point[]): number[] {
  const lengths = [0];
  for (let i = 1; i < points.length; i += 1) {
    lengths.push(lengths[i - 1]! + distance(points[i - 1]!, points[i]!));
  }
  return lengths;
}

export function pathLength(points: readonly Point[]): number {
  const lengths = arcLengths(points);
  return lengths[lengths.length - 1] ?? 0;
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * The leading `fraction` of a polyline, by arc length.
 *
 * This is how a partially-drawn stroke is produced (D-7): the *full* geometry is
 * jittered once and then cut, rather than jittering whatever prefix the runtime
 * handed over. Cutting a stable path keeps a stroke's shake identical from the
 * moment it starts to long after it finished; jittering each prefix would make
 * every stroke visibly settle as it completed.
 */
export function trimPolyline(points: readonly Point[], fraction: number): Point[] {
  if (points.length === 0) return [];
  const first = points[0]!;
  if (fraction <= 0) return [{ ...first }];
  if (fraction >= 1 || points.length === 1) return points.map((p) => ({ ...p }));

  const lengths = arcLengths(points);
  const total = lengths[lengths.length - 1]!;
  // A zero-length path (every point identical) has no arc to cut along.
  if (total === 0) return points.map((p) => ({ ...p }));

  const target = total * fraction;
  const out: Point[] = [{ ...first }];
  for (let i = 1; i < points.length; i += 1) {
    if (lengths[i]! < target) {
      out.push({ ...points[i]! });
      continue;
    }
    const segment = lengths[i]! - lengths[i - 1]!;
    const t = segment === 0 ? 0 : (target - lengths[i - 1]!) / segment;
    out.push(lerp(points[i - 1]!, points[i]!, t));
    break;
  }
  return out;
}

/** Distance from `p` to segment `ab`, and where along `ab` the nearest point sits. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distanceToPolyline(p: Point, points: readonly Point[]): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  if (points.length === 1) return distance(p, points[0]!);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i += 1) {
    const d = distanceToSegment(p, points[i - 1]!, points[i]!);
    if (d < best) best = d;
  }
  return best;
}

/** Unit normal (left-hand) of the direction through a vertex, for jitter offsets. */
export function normalAt(points: readonly Point[], index: number): Point {
  const before = points[Math.max(0, index - 1)]!;
  const after = points[Math.min(points.length - 1, index + 1)]!;
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: 0, y: 0 };
  return { x: -dy / length, y: dx / length };
}

export function boundsOf(points: readonly Point[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
