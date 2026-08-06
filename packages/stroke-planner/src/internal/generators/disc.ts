/**
 * `disc` -- an ellipse inscribed in the node's bounds, reported as `circle`
 * when the bounds are square and `ellipse` otherwise.
 *
 * The distinction is semantic, not visual: both replay from the same points, but
 * a renderer that wants to emit a real `<circle>` rather than a polyline needs
 * to be told which one it is looking at (Volume 06 §Stroke Types).
 */
import { ellipsePath } from "../geometry.js";
import type { GeneratedStroke, GeneratorInput, StrokeGenerator } from "./types.js";

export const discGenerator: StrokeGenerator = {
  name: "disc",
  generate({ node }: GeneratorInput): GeneratedStroke[] {
    const { width, height } = node.bounds;
    return [
      {
        type: Math.abs(width - height) < 1e-6 ? "circle" : "ellipse",
        points: ellipsePath(node.bounds),
      },
    ];
  },
};
