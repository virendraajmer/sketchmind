/**
 * `box` -- a rectangle traversal of the node's bounds. The default generator
 * for every object type no primitive manifest has taught us about (D-4).
 */
import { rectanglePath } from "../geometry.js";
import type { GeneratedStroke, GeneratorInput, StrokeGenerator } from "./types.js";

export const boxGenerator: StrokeGenerator = {
  name: "box",
  generate({ node }: GeneratorInput): GeneratedStroke[] {
    return [{ type: "rectangle", points: rectanglePath(node.bounds) }];
  },
};
