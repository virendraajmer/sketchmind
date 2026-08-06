/**
 * The arithmetic the checks share.
 *
 * `agent-vision` deliberately does not import `layout-engine`, even though the
 * layer graph would allow it. Critique is an observer: it reads the solver's
 * output as data and forms its own opinion. Reusing the solver's helpers would
 * make the two agree by construction, which is precisely the bug a critique tier
 * exists to catch.
 */
import type { BoundingBox, Point } from "@sketchmind/shared-types";

export function overlapArea(a: BoundingBox, b: BoundingBox): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Tolerance is a linear slack on each axis, not an area: two boxes sharing a
 * hairline edge are touching, and touching is how adjacent components are meant
 * to look.
 */
export function boxesOverlap(a: BoundingBox, b: BoundingBox, tolerance: number): boolean {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > tolerance && height > tolerance;
}

export function containsBox(outer: BoundingBox, inner: BoundingBox): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function orientation(a: Point, b: Point, c: Point): number {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : -1;
}

/**
 * Proper intersection only. Connectors that share an endpoint are joined at a
 * node, which is the normal case and not a crossing -- so collinear and
 * touching configurations return false rather than being reported to the agent
 * as something to fix.
 */
export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  if (o1 === 0 || o2 === 0 || o3 === 0 || o4 === 0) return false;
  return o1 !== o2 && o3 !== o4;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function centroidOf(boxes: readonly BoundingBox[]): Point {
  if (boxes.length === 0) return { x: 0, y: 0 };
  const sum = boxes.reduce(
    (acc, b) => ({ x: acc.x + b.x + b.width / 2, y: acc.y + b.y + b.height / 2 }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / boxes.length, y: sum.y / boxes.length };
}
