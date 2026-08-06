/**
 * Hand-drawn shake, synthesised deterministically from the stroke id (D-3).
 *
 * Phase 7 D-5 left this here on purpose: the planner emits exact points so an
 * export, a pixel-diff, or Phase 10's vision critique can recover true geometry,
 * and `shared-types/stroke.ts` states the rule -- replays seed their randomness
 * from the stroke id.
 *
 * Seeding from the id (not from a call counter, not from `Math.random`) is what
 * makes the shake a property of the *stroke* rather than of the render. Draw
 * stroke 40 first and it has exactly the points it would have had drawn last,
 * which is what keeps replay, seek-backwards, and undo/redo visually stable.
 *
 * It lives in `renderer-core` rather than in each backend so Konva and SVG shake
 * identically; a pixel-diff baseline is worthless if they do not.
 */
import type { Point, StrokeStyle } from "@sketchmind/shared-types";
import { distance, normalAt } from "./geometry.js";

/**
 * Shake amplitude is `jitter * width * JITTER_SCALE` in layout units. At the
 * defaults (jitter 0.15, width 2) that is ~0.9 units against leaf boxes Phase 6
 * sizes in the tens -- visible as a wobble, never as a different shape.
 */
export const JITTER_SCALE = 3;

/** Segments longer than this get interior points so long lines shake too. */
export const JITTER_SEGMENT_MAX = 40;

/** FNV-1a over the id. Cheap, well-distributed, and stable across engines. */
export function hashStrokeId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: 32 bits of state, uniform enough for visual noise. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Insert midpoints so no segment exceeds `JITTER_SEGMENT_MAX`. Purely visual and
 * purely local to the renderer -- the Stroke AST keeps its own point count, which
 * is what the optimizer's coverage invariant and the exporters read.
 */
function densify(points: readonly Point[], maxSegment: number): Point[] {
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const out: Point[] = [{ ...points[0]! }];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const steps = Math.max(1, Math.ceil(distance(a, b) / maxSegment));
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/**
 * Displace a path perpendicular to its own direction.
 *
 * Endpoints are pinned so joins between strokes stay closed, and a closed path
 * (first point equal to last) receives one displacement applied to both ends, so
 * a rectangle stays a rectangle rather than springing open at the corner where
 * the pen started.
 */
export function applyJitter(
  points: readonly Point[],
  style: Pick<StrokeStyle, "jitter" | "width">,
  seed: number,
): Point[] {
  const amplitude = style.jitter * style.width * JITTER_SCALE;
  if (amplitude <= 0 || points.length < 2) return points.map((p) => ({ ...p }));

  const dense = densify(points, JITTER_SEGMENT_MAX);
  const random = mulberry32(seed);
  const closed =
    dense.length > 2 &&
    dense[0]!.x === dense[dense.length - 1]!.x &&
    dense[0]!.y === dense[dense.length - 1]!.y;

  const offsets = dense.map(() => (random() * 2 - 1) * amplitude);
  if (!closed) {
    // An open path is anchored at both ends: those points are where it meets
    // whatever it connects to, and moving them breaks the join.
    offsets[0] = 0;
    offsets[offsets.length - 1] = 0;
  }

  const out = dense.map((point, index) => {
    const normal = normalAt(dense, index);
    const offset = offsets[index]!;
    return { x: point.x + normal.x * offset, y: point.y + normal.y * offset };
  });

  // The seam vertex of a closed path is one point visited twice. Copying rather
  // than offsetting equally is what actually closes it: the two visits have
  // different local directions, so an equal offset lands in two places.
  if (closed) out[out.length - 1] = { ...out[0]! };
  return out;
}
