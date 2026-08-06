/**
 * Semantic validation of a Stroke AST -- the checks a Zod schema structurally
 * cannot express, because they are about relationships *between* strokes.
 *
 * The theme is the same as `layout-engine`'s D-10: only check what the model can
 * contradict on its own. Whether a stroke is drawn in a *good* order needs
 * outside context to judge and is not checked here; whether it depends on a
 * stroke that does not exist, or that has not happened yet, does not.
 */
import { makeError, type SketchMindError, type StrokeAST } from "@sketchmind/shared-types";

const PACKAGE = "@sketchmind/stroke-planner";

function err(code: string, message: string, path: string, details?: Record<string, unknown>): SketchMindError {
  return makeError({ code, message, package: PACKAGE, stage: "stroke", recoverable: true, path, details });
}

export function semanticErrors(ast: StrokeAST): SketchMindError[] {
  const errors: SketchMindError[] = [];
  const seen = new Set<string>();

  ast.strokes.forEach((stroke, index) => {
    const path = `strokes[${index}]`;

    if (seen.has(stroke.id)) {
      errors.push(err("STROKE_DUPLICATE_ID", `Duplicate stroke id '${stroke.id}'.`, `${path}.id`, { id: stroke.id }));
    }

    if (stroke.order !== index) {
      errors.push(
        err(
          "STROKE_ORDER_INVALID",
          `Stroke '${stroke.id}' claims order ${stroke.order} but sits at position ${index}. Order is the drawing sequence and must match it.`,
          `${path}.order`,
          { id: stroke.id, order: stroke.order, index },
        ),
      );
    }

    if (stroke.type === "text" && (stroke.text === undefined || stroke.text.length === 0)) {
      errors.push(
        err("STROKE_TEXT_MISSING", `Text stroke '${stroke.id}' carries no text.`, `${path}.text`, { id: stroke.id }),
      );
    }

    for (const dependency of stroke.dependencies) {
      if (!seen.has(dependency)) {
        errors.push(
          err(
            "STROKE_DEPENDENCY_INVALID",
            `Stroke '${stroke.id}' depends on '${dependency}', which is not an earlier stroke.`,
            `${path}.dependencies`,
            { id: stroke.id, dependency },
          ),
        );
      }
    }

    // Added after the dependency check, so a stroke depending on itself is
    // reported rather than silently accepted.
    seen.add(stroke.id);
  });

  return errors;
}
