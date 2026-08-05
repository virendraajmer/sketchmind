/**
 * Base sizing for objects that carry no geometry of their own.
 *
 * Nothing upstream of this package is allowed to emit a number (Global
 * Constraints: only `LayoutModel` may). So a leaf object's box is a fixed,
 * deterministic default rather than anything derived from its semantic type --
 * teaching the solver "a pulley is bigger than a gear" is `primitive-sdk`'s job
 * (Phase 12), not this one's. Containers size to wrap their arranged children.
 */
import type { Size } from "@sketchmind/shared-types";

export const DEFAULT_LEAF_SIZE: Size = { width: 140, height: 90 };
export const CONTAINER_PADDING = 24;
export const SIBLING_GAP = 32;
export const CANVAS_MARGIN = 40;

export function leafSize(): Size {
  return { ...DEFAULT_LEAF_SIZE };
}
