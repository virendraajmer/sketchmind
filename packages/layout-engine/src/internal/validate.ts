/**
 * Semantic validation for a Layout Model, beyond what the schema can express
 * -- same split as diagram-ast and constraint-engine (schema checks shape,
 * this checks meaning).
 *
 * Overlap is deliberately not re-checked here. `solveLayout`'s own collision
 * pass is best-effort by design (Volume 05 §Collision Detection: "resolve
 * conflicts", not "prove zero overlap") and an `intersects` relationship
 * produces a Layout Model with a real, intended overlap -- so a strict
 * overlap check here would fail output this package itself just produced
 * correctly. What *is* checked is unambiguous regardless of intent: no two
 * nodes claiming the same id, no label pointing at a node that doesn't exist,
 * nothing drawn outside the canvas the model itself declares.
 */
import type { LayoutModel, SketchMindError } from "@sketchmind/shared-types";
import { makeError } from "@sketchmind/shared-types";

export const PACKAGE = "@sketchmind/layout-engine";

function err(code: string, message: string, path: string, details?: Record<string, unknown>): SketchMindError {
  return makeError({ code, message, package: PACKAGE, stage: "layout", recoverable: true, path, details });
}

function checkDuplicateNodes(model: LayoutModel, errors: SketchMindError[]): void {
  const seen = new Set<string>();
  model.nodes.forEach((n, i) => {
    if (seen.has(n.objectId)) {
      errors.push(err("LAYOUT_DUPLICATE_NODE", `Duplicate node for object '${n.objectId}'.`, `nodes[${i}]`, { id: n.objectId }));
    }
    seen.add(n.objectId);
  });
}

function checkLabels(model: LayoutModel, errors: SketchMindError[]): void {
  const nodeIds = new Set(model.nodes.map((n) => n.objectId));
  const seenLabelIds = new Set<string>();
  model.labels.forEach((l, i) => {
    if (seenLabelIds.has(l.labelId)) {
      errors.push(err("LAYOUT_DUPLICATE_LABEL", `Duplicate label id '${l.labelId}'.`, `labels[${i}]`, { id: l.labelId }));
    }
    seenLabelIds.add(l.labelId);

    if (!nodeIds.has(l.targetId)) {
      errors.push(
        err(
          "LAYOUT_UNKNOWN_LABEL_TARGET",
          `Label '${l.labelId}' targets '${l.targetId}', which is not a node in this layout.`,
          `labels[${i}].targetId`,
          { targetId: l.targetId },
        ),
      );
    }
  });
}

function checkConnectors(model: LayoutModel, errors: SketchMindError[]): void {
  const seen = new Set<string>();
  model.connectors.forEach((c, i) => {
    if (seen.has(c.relationshipId)) {
      errors.push(
        err(
          "LAYOUT_DUPLICATE_CONNECTOR",
          `Duplicate connector for relationship '${c.relationshipId}'.`,
          `connectors[${i}]`,
          { relationshipId: c.relationshipId },
        ),
      );
    }
    seen.add(c.relationshipId);
  });
}

/**
 * Every node's bounds must fit within the canvas the model itself declares --
 * a claim only the model can contradict on its own (Volume 05 §Validation
 * "valid bounds"), unlike overlap, which needs outside context to judge.
 */
function checkBounds(model: LayoutModel, errors: SketchMindError[]): void {
  model.nodes.forEach((n, i) => {
    const withinX = n.bounds.x >= -0.01 && n.bounds.x + n.bounds.width <= model.canvas.width + 0.01;
    const withinY = n.bounds.y >= -0.01 && n.bounds.y + n.bounds.height <= model.canvas.height + 0.01;
    if (!withinX || !withinY) {
      errors.push(
        err(
          "LAYOUT_OUT_OF_BOUNDS",
          `Node '${n.objectId}' bounds fall outside the declared canvas (${model.canvas.width}x${model.canvas.height}).`,
          `nodes[${i}].bounds`,
          { objectId: n.objectId, bounds: n.bounds, canvas: model.canvas },
        ),
      );
    }
  });
}

export function semanticErrors(model: LayoutModel): SketchMindError[] {
  const errors: SketchMindError[] = [];
  checkDuplicateNodes(model, errors);
  checkLabels(model, errors);
  checkConnectors(model, errors);
  checkBounds(model, errors);
  return errors;
}
