/**
 * Small directed-graph primitives shared by the hierarchical strategy's two
 * axes (vertical ranking from above/below, horizontal ordering from
 * leftOf/rightOf). Both reduce to the same two operations: drop whatever
 * edges would make the graph cyclic, then read an order out of what remains.
 */
export type Edge = readonly [string, string];

function hasCycle(nodeIds: readonly string[], edges: readonly Edge[]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const [from, to] of edges) adjacency.get(from)?.push(to);

  const state = new Map<string, "visiting" | "done">();
  const visit = (node: string): boolean => {
    if (state.get(node) === "done") return false;
    if (state.get(node) === "visiting") return true;
    state.set(node, "visiting");
    for (const next of adjacency.get(node) ?? []) {
      if (visit(next)) return true;
    }
    state.set(node, "done");
    return false;
  };
  return nodeIds.some((id) => state.get(id) !== "done" && visit(id));
}

/**
 * Add edges greedily in the given order, skipping any that would create a
 * cycle. Required constraints are expected to already be acyclic (constraint-
 * engine validates same-axis contradictions); this is what lets a `preferred`
 * edge -- a group's alignment, say -- yield to one that conflicts, per
 * Volume 14's "required must hold, preferred may be dropped".
 */
export function acyclicSubset(nodeIds: readonly string[], edges: readonly Edge[]): Edge[] {
  const kept: Edge[] = [];
  for (const edge of edges) {
    kept.push(edge);
    if (hasCycle(nodeIds, kept)) kept.pop();
  }
  return kept;
}

/** Longest-path rank from any source (0 in-degree), via topological DP. */
export function longestPathRank(nodeIds: readonly string[], edges: readonly Edge[]): Map<string, number> {
  const acyclic = acyclicSubset(nodeIds, edges);
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
    inDegree.set(id, 0);
  }
  for (const [from, to] of acyclic) {
    adjacency.get(from)?.push(to);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }

  const rank = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const queue = nodeIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const remaining = new Map(inDegree);

  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of adjacency.get(node) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(node) ?? 0) + 1));
      const left = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return rank;
}

/**
 * A total order over `nodeIds` respecting `edges` as precedence (`a -> b`
 * means "a before b"), ties broken by declaration order -- Kahn's algorithm
 * with a deterministic tie-break instead of an arbitrary one.
 */
export function topoOrder(
  nodeIds: readonly string[],
  edges: readonly Edge[],
  order: ReadonlyMap<string, number>,
): string[] {
  const acyclic = acyclicSubset(nodeIds, edges);
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
    inDegree.set(id, 0);
  }
  for (const [from, to] of acyclic) {
    adjacency.get(from)?.push(to);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }

  const byDeclaration = (a: string, b: string): number => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  const available = nodeIds.filter((id) => (inDegree.get(id) ?? 0) === 0).sort(byDeclaration);
  const result: string[] = [];

  while (available.length > 0) {
    const node = available.shift()!;
    result.push(node);
    const freed: string[] = [];
    for (const next of adjacency.get(node) ?? []) {
      const left = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, left);
      if (left === 0) freed.push(next);
    }
    freed.sort(byDeclaration);
    available.push(...freed);
    available.sort(byDeclaration);
  }
  return result;
}
