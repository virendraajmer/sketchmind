/**
 * Pure geometry helpers over the plain `Point` / `Size` / `BoundingBox` shapes
 * from `@sketchmind/shared-types`. No Zod here -- these run on every node of
 * every pass, and validation happens once, at the boundary (D-1, index.ts).
 */
import type { BoundingBox, Point, Size } from "@sketchmind/shared-types";

export function box(position: Point, size: Size): BoundingBox {
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

export function center(b: BoundingBox): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export function union(boxes: readonly BoundingBox[]): BoundingBox {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function translate(b: BoundingBox, dx: number, dy: number): BoundingBox {
  return { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height };
}

/** Overlap area on each axis; zero or negative means the boxes do not overlap on that axis. */
function axisOverlap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin);
}

export function overlaps(a: BoundingBox, b: BoundingBox): boolean {
  const ox = axisOverlap(a.x, a.x + a.width, b.x, b.x + b.width);
  const oy = axisOverlap(a.y, a.y + a.height, b.y, b.y + b.height);
  return ox > 0 && oy > 0;
}

/**
 * Minimum translation vector to separate `a` from `b` along whichever axis
 * needs the smaller push -- the standard cheap heuristic for pairwise
 * collision resolution (Volume 05 §Collision Detection: "automatically
 * resolve conflicts", not "prove a global optimum").
 */
export function minimumSeparation(a: BoundingBox, b: BoundingBox): Point {
  const ox = axisOverlap(a.x, a.x + a.width, b.x, b.x + b.width);
  const oy = axisOverlap(a.y, a.y + a.height, b.y, b.y + b.height);
  if (ox <= 0 || oy <= 0) return { x: 0, y: 0 };

  const aCenter = center(a);
  const bCenter = center(b);
  if (ox < oy) {
    return { x: bCenter.x >= aCenter.x ? ox : -ox, y: 0 };
  }
  return { x: 0, y: bCenter.y >= aCenter.y ? oy : -oy };
}

/** Point on `from`'s perimeter closest to `to`'s center -- the connector's edge anchor. */
export function edgePointToward(from: BoundingBox, to: BoundingBox): Point {
  const fromCenter = center(from);
  const toCenter = center(to);
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;

  if (dx === 0 && dy === 0) return fromCenter;

  const halfW = from.width / 2;
  const halfH = from.height / 2;
  // Scale to the box edge along the direction of travel, clamped to the box.
  const scale = Math.min(dx !== 0 ? Math.abs(halfW / dx) : Infinity, dy !== 0 ? Math.abs(halfH / dy) : Infinity);
  return { x: fromCenter.x + dx * scale, y: fromCenter.y + dy * scale };
}
