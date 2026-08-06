/**
 * The layer model (Volume 08 §Layer Model).
 *
 * All eight layers are declared now, including the three nothing draws to until
 * Phase 11's canvas tools exist. Adding a layer later reshuffles z-order for every
 * diagram already rendered, and a highlight that lands *under* the shape it is
 * highlighting is the kind of bug that only shows up in a demo.
 *
 * Which layer a stroke belongs to is a pure function of the stroke (D-5), not a
 * renderer setting: Phase 7 already stamped the drawing phase in `metadata.phase`,
 * which is exactly the semantic distinction the layer model wants.
 */
import type { Stroke } from "@sketchmind/shared-types";

/** Painter's order: index 0 is furthest back. */
export const LAYER_ORDER = [
  "background",
  "grid",
  "shapes",
  "connectors",
  "labels",
  "highlights",
  "animations",
  "debug",
] as const;

export type LayerName = (typeof LAYER_ORDER)[number];

export function isLayerName(value: string): value is LayerName {
  return (LAYER_ORDER as readonly string[]).includes(value);
}

/** Higher sits in front. Used to break hit-test ties (D-4). */
export function layerDepth(layer: LayerName): number {
  return LAYER_ORDER.indexOf(layer);
}

/**
 * Phase 7's five drawing phases collapse to three drawing layers: outlines and
 * details are both structure, annotations and labels are both text over the top.
 * A stroke with no phase metadata (hand-built, or from a future planner) is
 * structure, because that is the layer whose z-order assumption is safest.
 */
export function layerForStroke(stroke: Stroke): LayerName {
  if (stroke.type === "text") return "labels";
  const phase = stroke.metadata?.["phase"];
  switch (phase) {
    case "connector":
      return "connectors";
    case "label":
    case "annotation":
      return "labels";
    default:
      return "shapes";
  }
}
