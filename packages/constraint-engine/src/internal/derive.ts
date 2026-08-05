/**
 * Diagram AST -> constraints. Spatial *intent* only; not a single number here.
 *
 * Three sources feed the graph, in a fixed order so the output is byte-stable
 * for a given AST (AD-6):
 *
 *   1. Nesting     -- a child object is `inside` its parent.
 *   2. Relationships -- the semantic vocabulary mapped to the spatial one.
 *   3. Groups      -- "treated together for layout" made explicit as alignment.
 *
 * Order matters beyond determinism: nesting is structural and must win the
 * dedup, because an AST can state the same containment twice (nested *and* as
 * an `inside` relationship) and the two must collapse to one constraint.
 */
import {
  makeError,
  type Constraint,
  type ConstraintPriority,
  type ConstraintType,
  type DiagramAST,
  type DiagramObject,
  type RelationshipType,
  type SketchMindError,
} from "@sketchmind/shared-types";

export const PACKAGE = "@sketchmind/constraint-engine";

/**
 * Where overlap exemptions live on the graph's metadata bag. Read it through
 * `overlapExemptions()` rather than by key -- see D-2 in the phase plan for why
 * `intersects` is an exemption instead of a constraint.
 */
export const OVERLAP_METADATA_KEY = "overlapPermitted";

export function err(
  code: string,
  message: string,
  path: string,
  details?: Record<string, unknown>,
): SketchMindError {
  return makeError({
    code,
    message,
    package: PACKAGE,
    stage: "constraint",
    recoverable: true,
    path,
    details,
  });
}

export interface FlatObject {
  readonly object: DiagramObject;
  readonly parentId?: string;
}

/** Depth-first, parents before children -- the order a reader would expect. */
export function flatten(ast: DiagramAST): FlatObject[] {
  const out: FlatObject[] = [];
  const walk = (objects: readonly DiagramObject[], parentId?: string): void => {
    for (const object of objects) {
      out.push({ object, parentId });
      walk(object.children, object.id);
    }
  };
  walk(ast.objects);
  return out;
}

interface Mapping {
  readonly constraint: ConstraintType;
  /** The constraint points the other way, e.g. `A contains B` is `B inside A`. */
  readonly reversed?: boolean;
  readonly priority?: ConstraintPriority;
  readonly parameters?: Record<string, unknown>;
}

/**
 * The semantic-to-spatial translation, stated once.
 *
 * `intersects` is deliberately absent: it is a real relationship with no single
 * spatial constraint behind it (two overlapping circles in a Venn diagram are
 * not "connected", "inside", or "centered on" each other). Mapping it to the
 * nearest constraint would make the solver route a connector between shapes
 * that are meant to sit on top of one another. It becomes an overlap exemption
 * instead.
 */
export const RELATIONSHIP_CONSTRAINTS: Readonly<Partial<Record<RelationshipType, Mapping>>> = {
  above: { constraint: "above" },
  below: { constraint: "below" },
  leftOf: { constraint: "leftOf" },
  rightOf: { constraint: "rightOf" },
  inside: { constraint: "inside" },
  contains: { constraint: "inside", reversed: true },
  connectedTo: { constraint: "connectedTo" },
  attachedTo: { constraint: "attachedTo" },
  wraps: { constraint: "wrapAround" },
  parallelTo: { constraint: "parallelTo" },
  centeredOn: { constraint: "centeredOn" },
  alignedWith: { constraint: "alignedWith" },
  pointsTo: { constraint: "connectedTo", parameters: { directed: true } },
};

function constraintId(type: ConstraintType, from: string, to: string): string {
  return `c_${type}_${from}_${to}`;
}

function make(
  type: ConstraintType,
  from: string,
  to: string,
  priority: ConstraintPriority,
  parameters?: Record<string, unknown>,
): Constraint {
  return { id: constraintId(type, from, to), type, from, to, priority, ...(parameters ? { parameters } : {}) };
}

/**
 * Collapse duplicates, keeping the first occurrence but never letting a later
 * `preferred` duplicate downgrade an earlier `required` one -- or the reverse.
 * A constraint stated twice, once as structure and once as a preference, is
 * still structural.
 */
function dedupe(constraints: readonly Constraint[]): Constraint[] {
  const byId = new Map<string, Constraint>();
  for (const constraint of constraints) {
    const existing = byId.get(constraint.id);
    if (!existing) {
      byId.set(constraint.id, constraint);
      continue;
    }
    if (existing.priority === "preferred" && constraint.priority === "required") {
      byId.set(constraint.id, { ...existing, priority: "required" });
    }
  }
  return [...byId.values()];
}

export interface Derivation {
  readonly nodes: string[];
  readonly constraints: Constraint[];
  readonly overlapPermitted: Array<[string, string]>;
}

export function derive(ast: DiagramAST): Derivation {
  const flat = flatten(ast);
  const nodes = flat.map((f) => f.object.id);
  const known = new Set(nodes);
  const constraints: Constraint[] = [];
  const overlapPermitted: Array<[string, string]> = [];

  for (const { object, parentId } of flat) {
    if (parentId) constraints.push(make("inside", object.id, parentId, "required"));
  }

  for (const relationship of ast.relationships) {
    if (relationship.type === "intersects") {
      overlapPermitted.push([relationship.from, relationship.to]);
      continue;
    }
    const mapping = RELATIONSHIP_CONSTRAINTS[relationship.type];
    if (!mapping) continue;
    const [from, to] = mapping.reversed
      ? [relationship.to, relationship.from]
      : [relationship.from, relationship.to];
    constraints.push(make(mapping.constraint, from, to, mapping.priority ?? "required", mapping.parameters));
  }

  /**
   * A group is "a named set of objects treated together for layout". Alignment
   * is what that means spatially. All members align to the first rather than
   * chaining, because a chain drifts: each link is satisfied against an
   * already-moved neighbour, so the last member ends up nowhere near the first.
   *
   * `preferred`, because a group is a presentational grouping and must never be
   * the reason a diagram fails to lay out.
   */
  for (const group of ast.groups) {
    const members = group.members.filter((m) => known.has(m));
    const [anchor, ...rest] = members;
    if (anchor === undefined) continue;
    for (const member of rest) {
      constraints.push(make("alignedWith", member, anchor, "preferred"));
    }
    for (let i = 0; i + 1 < members.length; i += 1) {
      if (members.length >= 3) {
        constraints.push(make("equalSpacing", members[i]!, members[i + 1]!, "preferred"));
      }
    }
  }

  return { nodes, constraints: dedupe(constraints), overlapPermitted };
}
