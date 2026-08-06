/**
 * `Stroke` -> `DisplayStroke`: everything a backend needs, with nothing left to
 * decide (D-1).
 *
 * This is where the renderer stops being semantic. Upstream, a stroke is "the act
 * of drawing a circle in the accent tone"; below this line it is a list of points
 * and a colour. Putting the conversion in core rather than in each backend is what
 * makes `renderer-konva` and `renderer-svg` provably draw the same picture, and
 * what makes most of the renderer testable with no canvas in sight.
 */
import type { Point, Stroke, StrokeType } from "@sketchmind/shared-types";
import { boundsOf, trimPolyline } from "./geometry.js";
import { applyJitter, hashStrokeId } from "./jitter.js";
import { layerForStroke, type LayerName } from "./layers.js";
import { capForPressure, resolveTone, type LineCap, type RendererTheme } from "./theme.js";

export interface StrokePaint {
  readonly color: string;
  readonly width: number;
  readonly opacity: number;
  readonly lineCap: LineCap;
  readonly lineJoin: "round";
  /** Dash pattern in layout units, or undefined for a solid line. */
  readonly dash?: readonly number[];
  readonly fontFamily?: string;
  readonly fontSizePx?: number;
}

export interface DisplayStroke {
  readonly id: string;
  /** Diagram AST object this stroke belongs to -- what hit-testing reports. */
  readonly objectId: string;
  readonly type: StrokeType;
  readonly layer: LayerName;
  readonly order: number;
  /** World-space pen path with jitter already applied. */
  readonly points: readonly Point[];
  /** First point equals last: backends may close the sub-path rather than re-stroking the seam. */
  readonly closed: boolean;
  /** How much of the stroke is drawn, 0..1. Always 1 for a completed stroke. */
  readonly progress: number;
  readonly text?: string;
  readonly paint: StrokePaint;
}

/** `arrow` heads are the renderer's to size; this is the fraction of stroke width used. */
export const ARROWHEAD_WIDTH_FACTOR = 4;

function dashFor(width: number): readonly number[] {
  return [width * 4, width * 3];
}

function isClosed(points: readonly Point[]): boolean {
  if (points.length < 3) return false;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return first.x === last.x && first.y === last.y;
}

/**
 * Resolve one stroke for display.
 *
 * `progress` cuts the *jittered* path rather than jittering a prefix (see
 * `trimPolyline`), so a stroke's shake is fixed the instant it exists and does
 * not settle as it finishes drawing.
 */
export function resolveStroke(
  stroke: Stroke,
  theme: RendererTheme,
  progress = 1,
): DisplayStroke {
  const width = stroke.style.width * (theme.inkWidthScale[stroke.style.ink] ?? 1);
  const full =
    stroke.type === "text"
      ? stroke.points.map((p) => ({ ...p }))
      : applyJitter(stroke.points, stroke.style, hashStrokeId(stroke.id));

  const clamped = Math.max(0, Math.min(1, progress));
  // Text does not draw progressively along a path -- a half-written word is not
  // half a polyline. It appears once its stroke starts, which is what a teacher
  // writing a label looks like at playback speed.
  const points = stroke.type === "text" || clamped >= 1 ? full : trimPolyline(full, clamped);

  const paint: StrokePaint = {
    color: resolveTone(stroke.style.tone, theme),
    width,
    opacity: theme.inkOpacity[stroke.style.ink] ?? 1,
    lineCap: capForPressure(stroke.style.pressureProfile),
    lineJoin: "round",
    ...(stroke.style.dashed ? { dash: dashFor(width) } : {}),
    ...(stroke.type === "text"
      ? { fontFamily: theme.fontFamily, fontSizePx: theme.fontSizePx }
      : {}),
  };

  return {
    id: stroke.id,
    objectId: stroke.target,
    type: stroke.type,
    layer: layerForStroke(stroke),
    order: stroke.order,
    points,
    closed: isClosed(full),
    progress: clamped,
    ...(stroke.text === undefined ? {} : { text: stroke.text }),
    paint,
  };
}

/** Extent of a set of display strokes, for `fitToContent` when the AST carries no bounds. */
export function displayBounds(strokes: readonly DisplayStroke[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return boundsOf(strokes.flatMap((stroke) => stroke.points as Point[]));
}
