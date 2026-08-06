/**
 * What the geometry stages have produced so far, for this run.
 *
 * Same reasoning as `agent-tools-reasoning`'s `ReasoningWorkspace`, and
 * deliberately not the same object. A LayoutModel is thousands of coordinates;
 * asking the model to carry one back as the next tool's argument would burn
 * context on data it cannot usefully read and would give it the chance to
 * paraphrase geometry -- which is the one thing no model is allowed to author.
 *
 * So the artifacts stay here and the tools reference them. `solve_layout` takes
 * no graph argument; it reads the one `derive_constraints` produced.
 *
 * Kept separate from the reasoning workspace because the two tool packages know
 * nothing about each other. The join is one function passed in at construction
 * (`getAst`), supplied by whoever assembles the session.
 */
import type { ConstraintGraph, LayoutModel, StrokeAST } from "@sketchmind/shared-types";

export class GeometryWorkspace {
  constraintGraph?: ConstraintGraph;
  layout?: LayoutModel;
  strokeAST?: StrokeAST;

  /** A compact, serializable view. The Phase 9 inspector renders exactly this. */
  snapshot(): {
    hasConstraintGraph: boolean;
    hasLayout: boolean;
    hasStrokeAST: boolean;
    strokeCount: number;
  } {
    return {
      hasConstraintGraph: this.constraintGraph !== undefined,
      hasLayout: this.layout !== undefined,
      hasStrokeAST: this.strokeAST !== undefined,
      strokeCount: this.strokeAST?.strokes.length ?? 0,
    };
  }
}
