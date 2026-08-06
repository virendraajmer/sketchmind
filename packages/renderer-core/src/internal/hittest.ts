/**
 * Hit-testing (Volume 08 §Hit Testing), done geometrically in core rather than
 * delegated to each backend (D-4).
 *
 * Volume 08 calls the implementation renderer-specific, and for a canvas hit
 * graph that is true. It is the wrong call here: Phase 11 needs the **object id**,
 * which is a Diagram AST fact no canvas knows; a backend hit graph only sees nodes
 * that happen to be registered, so a mid-flight or hidden stroke answers wrongly;
 * and `renderer-svg` has no hit graph at all. Doing it over `DisplayStroke`s makes
 * one answer that every backend shares and that a test can check without pixels.
 *
 * `renderer-konva`'s suite cross-checks this against Konva's own
 * `getIntersection`, which is a stronger assertion than either alone: one says
 * what the model believes, the other what the pixels show.
 */
import type { Point } from "@sketchmind/shared-types";
import { distanceToPolyline } from "./geometry.js";
import { layerDepth, type LayerName } from "./layers.js";
import type { DisplayStroke } from "./display.js";

export interface HitTestResult {
  /** Diagram AST object -- what Phase 11's canvas tools act on. */
  readonly objectId: string;
  readonly strokeId: string;
  readonly layer: LayerName;
  /** Layout-space distance from the probe to the stroke; 0 means directly on it. */
  readonly distance: number;
}

export interface HitTestOptions {
  /** Layout-space slop, so a 2-unit line is clickable. */
  readonly tolerance?: number;
  /** Restrict to these layers; omitted means all visible ones. */
  readonly layers?: readonly LayerName[];
}

export const DEFAULT_HIT_TOLERANCE = 8;

/**
 * Every stroke within tolerance, nearest first.
 *
 * Ties break by layer (a label beats the shape under it) and then by draw order
 * (the later stroke is on top), which is the same precedence the eye applies.
 */
export function hitTestAll(
  strokes: readonly DisplayStroke[],
  point: Point,
  options: HitTestOptions = {},
): HitTestResult[] {
  const tolerance = options.tolerance ?? DEFAULT_HIT_TOLERANCE;
  const allowed = options.layers ? new Set(options.layers) : null;

  const hits: Array<HitTestResult & { depth: number; order: number }> = [];
  for (const stroke of strokes) {
    if (allowed && !allowed.has(stroke.layer)) continue;
    // Half the pen width counts as the stroke itself: a marker line is genuinely
    // wider than a pen line and should be genuinely easier to click.
    const reach = tolerance + stroke.paint.width / 2;
    const distance = distanceToPolyline(point, stroke.points);
    if (distance > reach) continue;
    hits.push({
      objectId: stroke.objectId,
      strokeId: stroke.id,
      layer: stroke.layer,
      distance,
      depth: layerDepth(stroke.layer),
      order: stroke.order,
    });
  }

  hits.sort((a, b) => a.distance - b.distance || b.depth - a.depth || b.order - a.order);
  return hits.map(({ depth: _depth, order: _order, ...hit }) => hit);
}

/** The single best hit, or null. What a click handler wants. */
export function hitTest(
  strokes: readonly DisplayStroke[],
  point: Point,
  options: HitTestOptions = {},
): HitTestResult | null {
  return hitTestAll(strokes, point, options)[0] ?? null;
}

/** Distinct object ids whose strokes intersect a rectangle (Volume 08 §Region selection). */
export function hitTestRegion(
  strokes: readonly DisplayStroke[],
  region: { x: number; y: number; width: number; height: number },
  options: Pick<HitTestOptions, "layers"> = {},
): string[] {
  const allowed = options.layers ? new Set(options.layers) : null;
  const right = region.x + region.width;
  const bottom = region.y + region.height;
  const found = new Set<string>();
  for (const stroke of strokes) {
    if (allowed && !allowed.has(stroke.layer)) continue;
    const inside = stroke.points.some(
      (p) => p.x >= region.x && p.x <= right && p.y >= region.y && p.y <= bottom,
    );
    if (inside) found.add(stroke.objectId);
  }
  return [...found];
}
