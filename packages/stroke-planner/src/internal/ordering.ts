/**
 * Drawing order (Volume 06 §Human Drawing Rules), decided semantically (D-3).
 *
 * Five phases run in sequence; within a phase, items are ordered by the layout's
 * own `zIndex`, which Phase 6 set to each object's index in
 * `ConstraintGraph.nodes` -- a parents-before-children DFS over the AST, i.e.
 * declaration order. Stable, predictable, and independent of geometry, so a
 * one-pixel layout change can never reshuffle the drawing.
 */
import type { DiagramAST, DiagramObject } from "@sketchmind/shared-types";

/** Order matters: this array *is* the sequence. */
export const DRAWING_PHASES = ["outline", "detail", "connector", "annotation", "label"] as const;
export type DrawingPhase = (typeof DRAWING_PHASES)[number];

export function phaseIndex(phase: DrawingPhase): number {
  return DRAWING_PHASES.indexOf(phase);
}

export interface FlatObject {
  readonly object: DiagramObject;
  /** Containment depth in the AST tree. 0 = nothing contains it. */
  readonly depth: number;
}

/** Depth-first walk of the AST's object tree, parents before children. */
export function flattenObjects(ast: DiagramAST): Map<string, FlatObject> {
  const out = new Map<string, FlatObject>();
  const visit = (object: DiagramObject, depth: number): void => {
    out.set(object.id, { object, depth });
    for (const child of object.children) visit(child, depth + 1);
  };
  for (const root of ast.objects) visit(root, 0);
  return out;
}

/**
 * "Draw large outlines first. Add details afterwards." A depth-0 object is an
 * outline; anything nested inside one is detail. This is the whole rule -- there
 * is no size heuristic, because Phase 6's D-7 made every leaf the same size, so
 * a size comparison would decide nothing while looking like it decided
 * something.
 */
export function phaseForDepth(depth: number): DrawingPhase {
  return depth === 0 ? "outline" : "detail";
}
