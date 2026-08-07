/**
 * Pen-path geometry. Every stroke type reduces to an ordered list of points
 * (Volume 06 §Stroke AST), so everything here operates on `Point[]` and nothing
 * here knows what the path represents.
 *
 * No Zod: these run on every point of every stroke, and validation happens once
 * at the boundary (D-1, index.ts).
 */
import type { BoundingBox, Point } from "@sketchmind/shared-types";

/** Coordinates are rounded to this many decimals so replays compare byte-identically (AD-6). */
const PRECISION = 4;

export function round(value: number): number {
  const factor = 10 ** PRECISION;
  // `+ 0` normalises -0 to 0, which JSON.stringify would otherwise render as "-0".
  return Math.round(value * factor) / factor + 0;
}

export function roundPoint(p: Point): Point {
  return { x: round(p.x), y: round(p.y) };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function samePoint(a: Point, b: Point, epsilon = 1e-3): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

export function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1]!, points[i]!);
  return total;
}

export function boundsOf(points: readonly Point[]): BoundingBox {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

export function unionBounds(boxes: readonly BoundingBox[]): BoundingBox | undefined {
  if (boxes.length === 0) return undefined;
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: round(minX), y: round(minY), width: round(maxX - minX), height: round(maxY - minY) };
}

/** Rectangle traversal: four corners, closed by repeating the first. */
export function rectanglePath(b: BoundingBox): Point[] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height },
    { x: b.x, y: b.y + b.height },
    { x: b.x, y: b.y },
  ].map(roundPoint);
}

/**
 * Ellipse inscribed in `b`, sampled at a fixed number of steps and closed.
 *
 * Fixed rather than curvature-adaptive: adaptive sampling would make a stroke's
 * point count depend on its size, so the same object at two scales would replay
 * with different data. A constant keeps the Stroke AST a pure function of the
 * layout (AD-6).
 */
export const ELLIPSE_STEPS = 32;

export function ellipsePath(b: BoundingBox, steps = ELLIPSE_STEPS): Point[] {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const rx = b.width / 2;
  const ry = b.height / 2;
  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    // Start at the top (-90 deg) -- where a right-handed writer starts a circle.
    const angle = -Math.PI / 2 + (i / steps) * Math.PI * 2;
    points.push(roundPoint({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }));
  }
  return points;
}

export function isClosed(points: readonly Point[]): boolean {
  return points.length > 2 && samePoint(points[0]!, points[points.length - 1]!);
}

/**
 * The largest box of the given width:height ratio that fits inside `b`, centred.
 *
 * A FreeformShape states the proportion it wants and the layout engine "scales,
 * never distorts" (AD-5), so a shape placed in a box of the wrong ratio is
 * letterboxed rather than stretched -- a hexagon in a wide box stays a hexagon.
 */
export function fitAspect(b: BoundingBox, aspectRatio: number): BoundingBox {
  if (!(aspectRatio > 0) || b.width <= 0 || b.height <= 0) return b;
  const width = Math.min(b.width, b.height * aspectRatio);
  const height = width / aspectRatio;
  return {
    x: round(b.x + (b.width - width) / 2),
    y: round(b.y + (b.height - height) / 2),
    width: round(width),
    height: round(height),
  };
}

/**
 * Samples per curve segment. Fixed for the same reason as `ELLIPSE_STEPS`: a
 * point count that varied with size would make the Stroke AST depend on the
 * layout's scale rather than only its shape (AD-6).
 */
export const CURVE_STEPS = 12;

/**
 * Centripetal Catmull-Rom through every control point, sampled into a polyline.
 *
 * Generators emit the pen's actual path, not control points -- `ellipsePath`
 * already works this way -- because a renderer backend only puts a polyline on a
 * surface and would otherwise draw a curve as straight segments.
 */
export function smoothPath(points: readonly Point[], steps = CURVE_STEPS): Point[] {
  if (points.length < 3) return points.map(roundPoint);

  const closed = isClosed(points);
  // A closed ring wraps for its phantom endpoints; an open path duplicates them.
  const ring = closed ? points.slice(0, -1) : points;
  const at = (i: number): Point =>
    closed
      ? ring[((i % ring.length) + ring.length) % ring.length]!
      : ring[Math.min(Math.max(i, 0), ring.length - 1)]!;

  const out: Point[] = [];
  const last = closed ? ring.length : ring.length - 1;
  for (let i = 0; i < last; i += 1) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(closed ? ring[0]! : ring[ring.length - 1]!);
  return out.map(roundPoint);
}

/**
 * Choose where the pen enters a path, given where it currently is (D-5).
 *
 * A closed path is rotated to begin at whichever vertex is nearest the pen; an
 * open path is reversed if its far end is nearer than its near end. This is the
 * only geometric decision the planner makes about drawing order -- object order
 * itself stays semantic (D-3), so a layout nudge can never reshuffle the
 * sequence.
 */
export function orientPath(points: readonly Point[], pen: Point | undefined): Point[] {
  if (pen === undefined || points.length < 2) return [...points];

  if (isClosed(points)) {
    const ring = points.slice(0, -1);
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < ring.length; i += 1) {
      const d = distance(pen, ring[i]!);
      // Strict `<` keeps the first of any tie, so equidistant vertices resolve
      // the same way on every run.
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    const rotated = [...ring.slice(best), ...ring.slice(0, best)];
    return [...rotated, rotated[0]!];
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;
  return distance(pen, last) < distance(pen, first) ? [...points].reverse() : [...points];
}

/** Cross product of (b-a) x (c-a); zero means the three points are collinear. */
function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * Drop interior points that lie on the straight line between their neighbours.
 * Endpoints are never dropped, so the path's start, end, and shape survive --
 * only its redundancy goes (Volume 06 §Stroke Optimizer).
 */
export function collapseCollinear(points: readonly Point[], epsilon = 1e-6): Point[] {
  if (points.length < 3) return [...points];
  const out: Point[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i += 1) {
    const previous = out[out.length - 1]!;
    const current = points[i]!;
    const next = points[i + 1]!;
    if (Math.abs(cross(previous, current, next)) > epsilon) out.push(current);
  }
  out.push(points[points.length - 1]!);
  return out;
}

/** Distinct points, by exact coordinate equality. Used to spot degenerate strokes. */
export function distinctPointCount(points: readonly Point[]): number {
  const seen = new Set(points.map((p) => `${p.x},${p.y}`));
  return seen.size;
}

