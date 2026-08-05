/**
 * Semantic validation for a Constraint Graph, beyond what the schema can
 * express -- mirrors `@sketchmind/diagram-ast`'s split between shape and
 * meaning (schema checks the former, this file the latter).
 *
 * This runs on every graph, not only derived ones: per AD-1 the agent may
 * hand-compose a graph for a trivial request rather than spend a model call
 * deriving one, and a hand-composed graph is held to the same standard.
 *
 * Every check accumulates into one array. An agent that gets one error per
 * round trip burns a round trip per mistake (same rationale as diagram-ast).
 */
import type { Constraint, ConstraintGraph, SketchMindError } from "@sketchmind/shared-types";
import { err } from "./derive.js";

/** Axis-opposite constraint pairs: `type(a, b)` and `opposite(b, a)` claim the same thing. */
const ORDERING_AXES: ReadonlyArray<{ readonly forward: string; readonly backward: string }> = [
  { forward: "above", backward: "below" },
  { forward: "leftOf", backward: "rightOf" },
];

function checkUnknownNodes(graph: ConstraintGraph, errors: SketchMindError[]): void {
  const known = new Set(graph.nodes);
  graph.constraints.forEach((c, i) => {
    if (!known.has(c.from)) {
      errors.push(
        err(
          "CONSTRAINT_UNKNOWN_NODE",
          `Constraint '${c.id}' references '${c.from}', which is not a node in this graph.`,
          `constraints[${i}].from`,
          { id: c.from },
        ),
      );
    }
    if (!known.has(c.to)) {
      errors.push(
        err(
          "CONSTRAINT_UNKNOWN_NODE",
          `Constraint '${c.id}' references '${c.to}', which is not a node in this graph.`,
          `constraints[${i}].to`,
          { id: c.to },
        ),
      );
    }
  });
}

function checkSelfReference(graph: ConstraintGraph, errors: SketchMindError[]): void {
  graph.constraints.forEach((c, i) => {
    if (c.from === c.to) {
      errors.push(
        err(
          "CONSTRAINT_SELF_REFERENCE",
          `Constraint '${c.id}' relates '${c.from}' to itself.`,
          `constraints[${i}]`,
          { id: c.from },
        ),
      );
    }
  });
}

function checkDuplicateIds(graph: ConstraintGraph, errors: SketchMindError[]): void {
  const seen = new Set<string>();
  graph.constraints.forEach((c, i) => {
    if (seen.has(c.id)) {
      errors.push(
        err("CONSTRAINT_DUPLICATE_ID", `Duplicate constraint id '${c.id}'.`, `constraints[${i}].id`, {
          id: c.id,
        }),
      );
    }
    seen.add(c.id);
  });
}

/** Directed cycle detection shared by containment and ordering checks. */
function findCycle(nodes: readonly string[], edges: ReadonlyArray<[string, string]>): string[] | undefined {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const [from, to] of edges) adjacency.get(from)?.push(to);

  const state = new Map<string, "visiting" | "done">();

  const visit = (node: string, path: string[]): string[] | undefined => {
    if (state.get(node) === "done") return undefined;
    if (state.get(node) === "visiting") return [...path, node];
    state.set(node, "visiting");
    for (const next of adjacency.get(node) ?? []) {
      const found = visit(next, [...path, node]);
      if (found) return found;
    }
    state.set(node, "done");
    return undefined;
  };

  for (const node of nodes) {
    const found = visit(node, []);
    if (found) return found;
  }
  return undefined;
}

/**
 * A `required` containment cycle -- "A is inside B is inside A" -- validates
 * fine against the schema and is unsolvable by every layout strategy Phase 6
 * has, so it is caught here instead (Notes for Phase 6, phase-5 plan).
 */
function checkContainmentCycles(graph: ConstraintGraph, errors: SketchMindError[]): void {
  const edges: Array<[string, string]> = graph.constraints
    .filter((c): c is Constraint => c.type === "inside" && c.priority === "required")
    .map((c) => [c.from, c.to]);

  const cycle = findCycle(graph.nodes, edges);
  if (cycle) {
    errors.push(
      err(
        "CONSTRAINT_CONTAINMENT_CYCLE",
        `Containment cycle: ${cycle.join(" -> ")}. An object cannot be inside something that is (transitively) inside it.`,
        "constraints",
        { cycle },
      ),
    );
  }
}

/**
 * `above(a, b)` and `below(b, a)` say the same thing twice; `above(a, b)` and
 * `above(b, a)` (or `below(a, b)`) contradict it. Folding both directions of
 * one axis into a single directed graph turns "contradicts" into "creates a
 * cycle" -- the same primitive as containment, reused rather than
 * re-invented per axis.
 */
function checkOrderingContradictions(graph: ConstraintGraph, errors: SketchMindError[]): void {
  for (const axis of ORDERING_AXES) {
    const edges: Array<[string, string]> = [];
    for (const c of graph.constraints) {
      if (c.priority !== "required") continue;
      if (c.type === axis.forward) edges.push([c.from, c.to]);
      if (c.type === axis.backward) edges.push([c.to, c.from]);
    }
    const cycle = findCycle(graph.nodes, edges);
    if (cycle) {
      errors.push(
        err(
          "CONSTRAINT_ORDERING_CONTRADICTION",
          `Contradictory '${axis.forward}'/'${axis.backward}' constraints: ${cycle.join(" -> ")}.`,
          "constraints",
          { axis: axis.forward, cycle },
        ),
      );
    }
  }
}

export function semanticErrors(graph: ConstraintGraph): SketchMindError[] {
  const errors: SketchMindError[] = [];
  checkDuplicateIds(graph, errors);
  checkUnknownNodes(graph, errors);
  checkSelfReference(graph, errors);
  checkContainmentCycles(graph, errors);
  checkOrderingContradictions(graph, errors);
  return errors;
}
