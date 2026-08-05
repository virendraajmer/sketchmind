/**
 * Shape Graph semantic validation (V14 §Graph Components).
 *
 * The schema says a graph has nodes and edges. It cannot say that `root` names
 * one of those nodes, that an edge connects two that exist, or that the
 * containment relation is not a loop -- and a graph claiming a wheel is inside
 * its own hub validates perfectly against the schema while being unsolvable by
 * every layout strategy Phase 6 will have.
 *
 * All findings are recoverable (AD-2): each one is a reference the agent wrote
 * and can rewrite.
 */
import { makeError, type ShapeGraph, type SketchMindError } from "@sketchmind/shared-types";

export const PACKAGE = "@sketchmind/shape-intelligence";

function err(code: string, message: string, path: string, details?: Record<string, unknown>): SketchMindError {
  return makeError({
    code,
    message,
    package: PACKAGE,
    stage: "shape-graph",
    recoverable: true,
    path,
    details,
  });
}

/** Edge types that assert one node lives inside another. A cycle here is absurd. */
const CONTAINMENT = new Set(["inside", "contains", "wraps"]);

function containmentCycles(graph: ShapeGraph): string[][] {
  // `inside` points child -> parent and `contains` points parent -> child, so
  // both are normalised to child -> parent before looking for a loop.
  const parents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!CONTAINMENT.has(edge.type)) continue;
    const [child, parent] = edge.type === "inside" ? [edge.from, edge.to] : [edge.to, edge.from];
    parents.set(child, [...(parents.get(child) ?? []), parent]);
  }

  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      cycles.push([...path.slice(path.indexOf(id)), id]);
      return;
    }
    state.set(id, "visiting");
    for (const parent of parents.get(id) ?? []) visit(parent, [...path, id]);
    state.set(id, "done");
  };

  for (const id of parents.keys()) visit(id, []);
  return cycles;
}

export function semanticErrors(graph: ShapeGraph): SketchMindError[] {
  const errors: SketchMindError[] = [];
  const ids = new Set<string>();

  graph.nodes.forEach((node, index) => {
    if (ids.has(node.id)) {
      errors.push(
        err("SHAPE_DUPLICATE_ID", `Duplicate node id '${node.id}'. Node ids must be unique.`, `nodes[${index}].id`, {
          id: node.id,
        }),
      );
    }
    ids.add(node.id);

    const anchors = new Set<string>();
    node.anchors.forEach((anchor, j) => {
      if (anchors.has(anchor.name)) {
        errors.push(
          err(
            "SHAPE_DUPLICATE_ANCHOR",
            `Node '${node.id}' declares the anchor '${anchor.name}' twice.`,
            `nodes[${index}].anchors[${j}].name`,
          ),
        );
      }
      anchors.add(anchor.name);
    });
  });

  if (!ids.has(graph.root)) {
    errors.push(
      err(
        "SHAPE_UNKNOWN_ROOT",
        `root '${graph.root}' does not name any node in this graph. The root is the node standing for the whole object.`,
        "root",
        { root: graph.root, available: [...ids] },
      ),
    );
  }

  const edgeIds = new Set<string>();
  graph.edges.forEach((edge, index) => {
    if (edgeIds.has(edge.id)) {
      errors.push(err("SHAPE_DUPLICATE_ID", `Duplicate edge id '${edge.id}'.`, `edges[${index}].id`));
    }
    edgeIds.add(edge.id);

    for (const end of ["from", "to"] as const) {
      if (!ids.has(edge[end])) {
        errors.push(
          err(
            "SHAPE_UNKNOWN_REFERENCE",
            `'${edge[end]}' does not name any node in this graph.`,
            `edges[${index}].${end}`,
            { id: edge[end] },
          ),
        );
      }
    }

    if (edge.from === edge.to) {
      errors.push(
        err("SHAPE_SELF_REFERENCE", `Edge '${edge.id}' connects '${edge.from}' to itself.`, `edges[${index}]`),
      );
    }
  });

  for (const cycle of containmentCycles(graph)) {
    errors.push(
      err(
        "SHAPE_CONTAINMENT_CYCLE",
        `Containment loops back on itself: ${cycle.join(" -> ")}. Nothing can be inside something inside it.`,
        "edges",
        { cycle },
      ),
    );
  }

  // Orphans, same rule as the Diagram AST: a lone node is a legitimate shape
  // ("a circle"), but the moment a graph claims composition, every part must be
  // attached to something or it will never be positioned.
  if (graph.nodes.length > 1) {
    const attached = new Set<string>([graph.root]);
    for (const edge of graph.edges) {
      attached.add(edge.from);
      attached.add(edge.to);
    }
    graph.nodes.forEach((node, index) => {
      if (!attached.has(node.id)) {
        errors.push(
          err(
            "SHAPE_ORPHAN_NODE",
            `Node '${node.id}' is not connected to anything. Add an edge relating it to another node, or remove it.`,
            `nodes[${index}]`,
            { id: node.id },
          ),
        );
      }
    });
  }

  return errors;
}
