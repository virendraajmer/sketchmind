/**
 * What the reasoning stages have produced so far, for this run.
 *
 * Without this, every stage's output would have to travel back through the model
 * and be re-sent as the next stage's arguments. That is not a small tax: a
 * ShapeGraph round trip is thousands of tokens the model already saw, and it
 * gives the model an opportunity to paraphrase its own prior output on the way
 * past.
 *
 * So artifacts stay server-side and the tools reference them. `plan_visual` is
 * called with no arguments and reads the intent from here. The model still sees
 * each result -- it just is not asked to carry it.
 *
 * This is per-run state, distinct from `agent-memory`'s `SessionMemory` (which
 * records what happened, in prose, for the model's benefit) and from its
 * `MemoryStore` (which outlives the session). Three lifetimes, three homes.
 */
import type {
  DiagramAST,
  FreeformShape,
  IntentModel,
  ShapeGraph,
  SketchMindError,
  VisualPlan,
} from "@sketchmind/shared-types";

/** The last AST that failed validation, kept so the next attempt can repair it. */
export interface FailedAttempt {
  readonly attempt: unknown;
  readonly errors: readonly SketchMindError[];
}

export class ReasoningWorkspace {
  intent?: IntentModel;
  plan?: VisualPlan;
  shapeGraph?: ShapeGraph;
  ast?: DiagramAST;
  lastFailure?: FailedAttempt;

  /** Generated primitives, by the name they were generated for. */
  readonly primitives = new Map<string, ShapeGraph>();
  /** Freeform compositions, by shape id (AD-5). */
  readonly freeforms = new Map<string, FreeformShape>();

  /**
   * Every query `search_primitives` has been asked, in order.
   *
   * V10's "search before you generate" is enforced by `generatePrimitive` running
   * the search itself, not by inspecting this list. It is here so the trace can
   * *show* that the search happened -- a guarantee nobody can observe is one
   * nobody will notice breaking.
   */
  readonly searches: string[] = [];

  recordSearch(query: string): void {
    this.searches.push(query);
  }

  recordFailure(attempt: unknown, errors: readonly SketchMindError[]): void {
    this.lastFailure = { attempt, errors };
  }

  clearFailure(): void {
    this.lastFailure = undefined;
  }

  /** A compact, serializable view. Phase 9's inspector renders exactly this. */
  snapshot(): {
    hasIntent: boolean;
    hasPlan: boolean;
    hasShapeGraph: boolean;
    hasAST: boolean;
    searches: string[];
    primitives: string[];
    freeforms: string[];
  } {
    return {
      hasIntent: this.intent !== undefined,
      hasPlan: this.plan !== undefined,
      hasShapeGraph: this.shapeGraph !== undefined,
      hasAST: this.ast !== undefined,
      searches: [...this.searches],
      primitives: [...this.primitives.keys()],
      freeforms: [...this.freeforms.keys()],
    };
  }
}
