/**
 * Resolve declared anchor *names* (semantic, from the Shape Graph / Diagram
 * AST -- Volume 04 §Anchors) to points on a solved box.
 *
 * The AST only carries a name and description; nothing upstream says "the rim
 * anchor sits at 30 degrees". Absent that, anchors are distributed evenly
 * around the box perimeter in declaration order -- deterministic and distinct
 * per anchor, which is what routing needs, without pretending to know
 * per-shape geometry that only a primitive manifest (Phase 12) can supply.
 */
import type { BoundingBox, Point } from "@sketchmind/shared-types";

/** Clockwise from top-center: N, E, S, W, then the four corners. */
function perimeterPoint(box: BoundingBox, index: number): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const points: Point[] = [
    { x: cx, y: box.y },
    { x: box.x + box.width, y: cy },
    { x: cx, y: box.y + box.height },
    { x: box.x, y: cy },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
    { x: box.x, y: box.y },
  ];
  return points[index % points.length]!;
}

export function resolveAnchorPoint(box: BoundingBox, anchorIndex: number): Point {
  return perimeterPoint(box, anchorIndex);
}
