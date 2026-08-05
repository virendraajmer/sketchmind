/**
 * Pairwise overlap resolution (Volume 05 §Collision Detection). A fixed
 * number of passes over a fixed pair order, not an optimizer -- "automatically
 * resolve conflicts" is the requirement, not "find the global optimum", and a
 * bounded pass count is what keeps this a layout step instead of a solver that
 * might not terminate.
 */
import type { BoundingBox } from "@sketchmind/shared-types";
import { minimumSeparation, overlaps } from "./geometry.js";

const ITERATIONS = 4;

/**
 * Mutates `boxes` in place. `ids` fixes pair-enumeration order so two runs
 * over the same input push things apart identically (AD-6). `isExempt` covers
 * both ancestor/descendant pairs (a container legitimately overlaps its own
 * children) and `intersects` overlap exemptions from the constraint graph.
 */
export function resolveOverlaps(
  boxes: Map<string, BoundingBox>,
  ids: readonly string[],
  isExempt: (a: string, b: string) => boolean,
): void {
  for (let pass = 0; pass < ITERATIONS; pass += 1) {
    let moved = false;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i]!;
        const b = ids[j]!;
        if (isExempt(a, b)) continue;
        const boxA = boxes.get(a);
        const boxB = boxes.get(b);
        if (!boxA || !boxB || !overlaps(boxA, boxB)) continue;

        const push = minimumSeparation(boxA, boxB);
        if (push.x === 0 && push.y === 0) continue;
        boxes.set(b, { ...boxB, x: boxB.x + push.x, y: boxB.y + push.y });
        moved = true;
      }
    }
    if (!moved) break;
  }
}
