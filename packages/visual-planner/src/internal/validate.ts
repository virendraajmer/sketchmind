/**
 * Semantic checks the schema cannot express.
 *
 * `VisualPlanSchema` guarantees a label has a `target` string. It cannot
 * guarantee that string names an object in the same plan, and a plan whose
 * labels point at objects that do not exist is the single most common way this
 * stage goes wrong -- the model renames an object between the `objects` array
 * and the `labels` array and nothing downstream notices until layout tries to
 * place a label on nothing.
 *
 * Every finding is a recoverable error naming the offending path, because the
 * agent's next step is to reissue the plan with the reference fixed (AD-2).
 */
import { makeError, type SketchMindError, type VisualPlan } from "@sketchmind/shared-types";

export const PACKAGE = "@sketchmind/visual-planner";

const origin = { package: PACKAGE, stage: "vil" } as const;

function danglingReference(path: string, target: string, known: readonly string[]): SketchMindError {
  return makeError({
    ...origin,
    code: "PLAN_UNKNOWN_TARGET",
    message:
      `"${target}" is not one of this plan's object ids. ` +
      `Known ids: ${known.join(", ")}. Either add the object or point at an existing one.`,
    recoverable: true,
    path,
  });
}

export function semanticErrors(plan: VisualPlan): SketchMindError[] {
  const errors: SketchMindError[] = [];
  const ids = plan.objects.map((object) => object.id);
  const known = new Set(ids);

  const seen = new Set<string>();
  for (const [index, object] of plan.objects.entries()) {
    if (seen.has(object.id)) {
      errors.push(
        makeError({
          ...origin,
          code: "PLAN_DUPLICATE_ID",
          message: `Object id "${object.id}" appears more than once. Ids must be unique.`,
          recoverable: true,
          path: `objects[${index}].id`,
        }),
      );
    }
    seen.add(object.id);
  }

  const targeted = [
    ["labels", plan.labels.map((label) => label.target)],
    ["highlights", plan.highlights.map((highlight) => highlight.target)],
    ["animations", plan.animations.map((animation) => animation.target)],
  ] as const;

  for (const [field, targets] of targeted) {
    for (const [index, target] of targets.entries()) {
      if (!known.has(target)) errors.push(danglingReference(`${field}[${index}].target`, target, ids));
    }
  }

  // An empty focusOrder is filled in by the caller, not reported: the model
  // declining to order six objects is not a mistake it needs to see. A
  // *partial* order is different -- it is a claim about draw order that
  // contradicts the object list, and rewriting it silently would discard the
  // model's actual intent for the objects it did name.
  if (plan.focusOrder.length > 0) {
    for (const [index, id] of plan.focusOrder.entries()) {
      if (!known.has(id)) errors.push(danglingReference(`focusOrder[${index}]`, id, ids));
    }
    const ordered = new Set(plan.focusOrder);
    const missing = ids.filter((id) => !ordered.has(id));
    if (missing.length > 0) {
      errors.push(
        makeError({
          ...origin,
          code: "PLAN_INCOMPLETE_FOCUS_ORDER",
          message:
            `focusOrder omits ${missing.join(", ")}. It must list every object exactly once, ` +
            `or be empty to accept the default order.`,
          recoverable: true,
          path: "focusOrder",
        }),
      );
    }
  }

  return errors;
}

/** Draw order by importance, then by declaration order within a tier. */
const IMPORTANCE_RANK = { primary: 0, secondary: 1, supporting: 2 } as const;

/**
 * The default draw order when the model supplies none.
 *
 * Structure before detail is V13's Visual Focus rule, and importance is the
 * field that carries it. Ties keep declaration order, so the fallback is
 * deterministic -- AD-6 applies from the AST down, but a stage that reordered
 * itself run to run would make the AST non-reproducible for no reason.
 */
export function defaultFocusOrder(plan: VisualPlan): string[] {
  return plan.objects
    .map((object, index) => ({ id: object.id, rank: IMPORTANCE_RANK[object.importance], index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.id);
}
