/**
 * The containment forest a Constraint Graph implies.
 *
 * `constraint-engine` already deduped nesting and `inside` relationships into
 * one set of required `inside` edges, and its `nodes` array is a parents-
 * before-children DFS over the AST (Volume 04's declaration order). Layout
 * reuses that order as the single source of "stable tie-break" everywhere in
 * this package, rather than re-deriving it from the AST a second time.
 */
import type { Constraint, ConstraintGraph } from "@sketchmind/shared-types";

export interface ContainmentForest {
  readonly roots: readonly string[];
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  readonly parentOf: ReadonlyMap<string, string>;
  /** Declaration index, per `graph.nodes` order. */
  readonly order: ReadonlyMap<string, number>;
}

export function buildContainmentForest(graph: ConstraintGraph): ContainmentForest {
  const order = new Map(graph.nodes.map((id, i) => [id, i]));
  const parentOf = new Map<string, string>();

  const insideEdges = graph.constraints.filter(
    (c): c is Constraint => c.type === "inside" && c.priority === "required",
  );
  // Stable: a node named as `from` more than once keeps its first parent.
  for (const edge of insideEdges) {
    if (!parentOf.has(edge.from)) parentOf.set(edge.from, edge.to);
  }

  const childrenOf = new Map<string, string[]>();
  for (const id of graph.nodes) childrenOf.set(id, []);
  for (const [child, parent] of parentOf) {
    childrenOf.get(parent)?.push(child);
  }
  for (const children of childrenOf.values()) {
    children.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  const roots = graph.nodes.filter((id) => !parentOf.has(id));

  return { roots, childrenOf, parentOf, order };
}
