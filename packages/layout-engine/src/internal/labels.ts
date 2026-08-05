/**
 * Label placement (Volume 05 §Label Placement: "avoid overlaps, stay near
 * target object, maintain readability"). Every label and annotation gets a
 * text-derived box and a fixed, deterministic list of candidate positions
 * around its target, tried in order until one clears every object and label
 * placed so far. If none do, the first candidate is used anyway -- a
 * best-effort placement is still deterministic and still better than none,
 * and nothing in Volume 05 demands a proof of zero overlap.
 */
import type { BoundingBox, DiagramAST, LayoutLabel } from "@sketchmind/shared-types";
import { overlaps } from "./geometry.js";

const CHAR_WIDTH = 7;
const LINE_HEIGHT = 20;
const LABEL_PADDING = 6;
const LABEL_GAP = 8;

function labelBoxAt(topLeft: { x: number; y: number }, text: string): BoundingBox {
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: text.length * CHAR_WIDTH + LABEL_PADDING * 2,
    height: LINE_HEIGHT + LABEL_PADDING * 2,
  };
}

function candidates(target: BoundingBox, width: number, height: number): Array<{ x: number; y: number }> {
  const cx = target.x + target.width / 2 - width / 2;
  const cy = target.y + target.height / 2 - height / 2;
  return [
    { x: cx, y: target.y + target.height + LABEL_GAP }, // below-center
    { x: target.x + target.width + LABEL_GAP, y: cy }, // right-center
    { x: cx, y: target.y - height - LABEL_GAP }, // above-center
    { x: target.x - width - LABEL_GAP, y: cy }, // left-center
    { x: target.x + target.width * 0.6, y: target.y + target.height + LABEL_GAP }, // below-right
    { x: target.x - width * 0.6, y: target.y + target.height + LABEL_GAP }, // below-left
  ];
}

interface LabelRequest {
  readonly id: string;
  readonly targetId: string;
  readonly text: string;
}

function place(
  requests: readonly LabelRequest[],
  nodeBoxes: ReadonlyMap<string, BoundingBox>,
): LayoutLabel[] {
  const placed: BoundingBox[] = [];
  const labels: LayoutLabel[] = [];

  for (const request of requests) {
    const target = nodeBoxes.get(request.targetId);
    if (!target) continue;

    const probe = labelBoxAt({ x: 0, y: 0 }, request.text);
    const options = candidates(target, probe.width, probe.height);

    const obstacles = [...nodeBoxes.values(), ...placed];
    const chosen =
      options.find((topLeft) => {
        const box = labelBoxAt(topLeft, request.text);
        return !obstacles.some((o) => overlaps(box, o));
      }) ?? options[0]!;

    const bounds = labelBoxAt(chosen, request.text);
    placed.push(bounds);
    labels.push({ labelId: request.id, targetId: request.targetId, position: chosen, bounds, text: request.text });
  }

  return labels;
}

export function buildLabels(
  ast: DiagramAST,
  objects: ReadonlyArray<{ readonly id: string; readonly labels: ReadonlyArray<{ id: string; text: string }> }>,
  nodeBoxes: ReadonlyMap<string, BoundingBox>,
): LayoutLabel[] {
  const requests: LabelRequest[] = [];
  for (const object of objects) {
    for (const label of object.labels) {
      requests.push({ id: label.id, targetId: object.id, text: label.text });
    }
  }
  for (const annotation of ast.annotations) {
    requests.push({ id: annotation.id, targetId: annotation.target, text: annotation.text });
  }
  return place(requests, nodeBoxes);
}
