/**
 * Semantic validation, beyond what the schema can express.
 *
 * The schema checks shape: is `objects` an array, is `type` a known
 * relationship. This file checks meaning: does that relationship point at an
 * object that exists, does that label name an anchor the object actually
 * exposes. Those are cross-references, and no per-field schema can see them.
 *
 * Every check accumulates into one array rather than returning on the first
 * failure. Per AD-2 these become agent observations, and an agent that gets one
 * error per round trip burns a round trip per mistake.
 */
import {
  makeError,
  type DiagramAST,
  type DiagramObject,
  type SketchMindError,
} from "@sketchmind/shared-types";

export const PACKAGE = "@sketchmind/diagram-ast";

function err(
  code: string,
  message: string,
  path: string,
  details?: Record<string, unknown>,
): SketchMindError {
  return makeError({
    code,
    message,
    package: PACKAGE,
    stage: "diagram-ast",
    // Every semantic failure is recoverable: the agent produced a wrong
    // reference and can produce the right one. None of these are fatal states.
    recoverable: true,
    path,
    details,
  });
}

/** Depth-first, parents before children -- the order a reader would expect. */
export function collectObjects(ast: DiagramAST): DiagramObject[] {
  const out: DiagramObject[] = [];
  const walk = (objects: DiagramObject[]): void => {
    for (const o of objects) {
      out.push(o);
      walk(o.children);
    }
  };
  walk(ast.objects);
  return out;
}

export function findObject(ast: DiagramAST, id: string): DiagramObject | undefined {
  return collectObjects(ast).find((o) => o.id === id);
}

function checkDuplicateIds(ast: DiagramAST, errors: SketchMindError[]): void {
  const seen = new Set<string>();
  const objects = collectObjects(ast);

  objects.forEach((o, i) => {
    if (seen.has(o.id)) {
      errors.push(
        err(
          "AST_DUPLICATE_ID",
          `Duplicate object id '${o.id}'. Object ids must be unique across the whole diagram, including nested children.`,
          `objects[${i}].id`,
          { id: o.id },
        ),
      );
    }
    seen.add(o.id);
  });

  const relIds = new Set<string>();
  ast.relationships.forEach((r, i) => {
    if (relIds.has(r.id)) {
      errors.push(
        err("AST_DUPLICATE_ID", `Duplicate relationship id '${r.id}'.`, `relationships[${i}].id`, {
          id: r.id,
        }),
      );
    }
    relIds.add(r.id);
  });
}

function checkReferences(ast: DiagramAST, errors: SketchMindError[]): void {
  const objects = collectObjects(ast);
  const ids = new Set(objects.map((o) => o.id));
  const anchorsOf = new Map(objects.map((o) => [o.id, new Set(o.anchors.map((a) => a.name))]));

  const requireObject = (id: string, path: string): boolean => {
    if (ids.has(id)) return true;
    errors.push(
      err("AST_UNKNOWN_REFERENCE", `'${id}' does not name any object in this diagram.`, path, {
        id,
      }),
    );
    return false;
  };

  const requireAnchor = (objectId: string, anchor: string, path: string): void => {
    const anchors = anchorsOf.get(objectId);
    if (anchors && !anchors.has(anchor)) {
      errors.push(
        err(
          "AST_UNKNOWN_ANCHOR",
          `Object '${objectId}' does not expose an anchor named '${anchor}'. Declare it in that object's anchors first.`,
          path,
          { objectId, anchor, available: [...anchors] },
        ),
      );
    }
  };

  ast.relationships.forEach((r, i) => {
    const fromOk = requireObject(r.from, `relationships[${i}].from`);
    const toOk = requireObject(r.to, `relationships[${i}].to`);

    if (r.from === r.to) {
      errors.push(
        err(
          "AST_SELF_REFERENCE",
          `Relationship '${r.id}' connects '${r.from}' to itself.`,
          `relationships[${i}]`,
          { id: r.id },
        ),
      );
    }
    if (fromOk && r.fromAnchor) requireAnchor(r.from, r.fromAnchor, `relationships[${i}].fromAnchor`);
    if (toOk && r.toAnchor) requireAnchor(r.to, r.toAnchor, `relationships[${i}].toAnchor`);
  });

  ast.groups.forEach((g, i) => {
    g.members.forEach((m, j) => requireObject(m, `groups[${i}].members[${j}]`));
  });

  ast.annotations.forEach((a, i) => {
    if (requireObject(a.target, `annotations[${i}].target`) && a.anchor) {
      requireAnchor(a.target, a.anchor, `annotations[${i}].anchor`);
    }
  });

  objects.forEach((o, i) => {
    o.labels.forEach((l, j) => {
      if (l.anchor) requireAnchor(o.id, l.anchor, `objects[${i}].labels[${j}].anchor`);
    });
  });
}

/**
 * Orphan detection (Volume 04 §Validation Rules).
 *
 * An object counts as connected if it appears in a relationship, is somebody's
 * child, has children of its own, or belongs to a group. A single-object
 * diagram is not an orphan -- "draw a circle" is a legitimate request, and
 * failing it would be the validator enforcing a rule the product does not have.
 */
function checkOrphans(ast: DiagramAST, errors: SketchMindError[]): void {
  const objects = collectObjects(ast);
  if (objects.length < 2) return;

  const connected = new Set<string>();
  for (const r of ast.relationships) {
    connected.add(r.from);
    connected.add(r.to);
  }
  for (const g of ast.groups) {
    for (const m of g.members) connected.add(m);
  }
  const walk = (parent: DiagramObject): void => {
    for (const child of parent.children) {
      connected.add(parent.id);
      connected.add(child.id);
      walk(child);
    }
  };
  ast.objects.forEach(walk);

  objects.forEach((o, i) => {
    if (!connected.has(o.id)) {
      errors.push(
        err(
          "AST_ORPHAN_OBJECT",
          `Object '${o.id}' has no relationship, parent, child, or group. Connect it or remove it.`,
          `objects[${i}]`,
          { id: o.id },
        ),
      );
    }
  });
}

export function semanticErrors(ast: DiagramAST): SketchMindError[] {
  const errors: SketchMindError[] = [];
  checkDuplicateIds(ast, errors);
  checkReferences(ast, errors);
  checkOrphans(ast, errors);
  return errors;
}
