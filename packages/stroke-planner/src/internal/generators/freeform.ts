/**
 * `freeform` -- draws a `FreeformShape` (AD-5), which is how the agent draws an
 * object nobody wrote a generator for.
 *
 * The shape arrives in its own 0..1 box; this maps that box onto the node the
 * layout engine solved, and nothing else. The two responsibilities stay where
 * they were: layout decided *where and how big*, the shape decided *what it
 * looks like*, and neither learned the other's job.
 *
 * Every part is emitted as an explicit polyline. A sub-primitive's control
 * points are not the pen's path -- a `curve` through three points is a curve,
 * not two straight segments -- and a renderer backend only knows how to stroke a
 * polyline, so the sampling has to happen here.
 */
import type { FreeformShape, Point, SubPrimitive, UnitPoint } from "@sketchmind/shared-types";
import { boundsOf, ellipsePath, fitAspect, rectanglePath, roundPoint, smoothPath } from "../geometry.js";
import type { GeneratedStroke, GeneratorInput, StrokeGenerator } from "./types.js";

/** Closes a ring, unless it already ends where it began. */
function ring(points: readonly Point[]): Point[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 3) return [...points];
  return first.x === last.x && first.y === last.y ? [...points] : [...points, first];
}

function strokeFor(part: SubPrimitive, points: readonly Point[]): GeneratedStroke {
  switch (part.kind) {
    // Two-plus control points describe the box the shape is inscribed in; the
    // canonical path is then sampled the same way the `disc` generator does it.
    case "circle":
    case "ellipse":
      return { type: part.kind, points: ellipsePath(boundsOf(points)) };
    case "rectangle":
      return { type: "rectangle", points: rectanglePath(boundsOf(points)) };
    case "polygon":
      return { type: "polygon", points: ring(points) };
    case "curve":
    case "arc":
      return { type: part.kind, points: smoothPath(part.closed ? ring(points) : points) };
    // `polyline` has no stroke type of its own: a `line` carries as many points
    // as it needs, so the distinction exists only in the shape vocabulary.
    case "line":
    case "polyline":
      return { type: "line", points: part.closed ? ring(points) : [...points] };
  }
}

export function freeformStrokes(shape: FreeformShape, into: GeneratorInput["node"]["bounds"]): GeneratedStroke[] {
  const box = fitAspect(into, shape.aspectRatio);
  const toWorld = (p: UnitPoint): Point =>
    roundPoint({ x: box.x + p.u * box.width, y: box.y + p.v * box.height });

  return [...shape.parts]
    .sort((a, b) => a.order - b.order)
    .map((part) => strokeFor(part, part.points.map(toWorld)))
    .filter((stroke) => stroke.points.length > 1);
}

export const freeformGenerator: StrokeGenerator = {
  name: "freeform",
  generate({ node, shape }: GeneratorInput): GeneratedStroke[] {
    // Selected only when a shape resolved, but a plugin may name this generator
    // directly through `generatorFor`; a box is the same answer the type table
    // would have given.
    if (!shape) return [{ type: "rectangle", points: rectanglePath(node.bounds) }];
    return freeformStrokes(shape, node.bounds);
  },
};
