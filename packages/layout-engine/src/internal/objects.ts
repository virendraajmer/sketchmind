/** Depth-first flatten of the AST's object tree, parents before children -- same shape as diagram-ast's own, kept local so this package's only dependency stays `shared-types` (Package Map: layout-engine solves `ConstraintGraph -> LayoutModel`). */
import type { DiagramAST, DiagramObject } from "@sketchmind/shared-types";

export function flattenObjects(ast: DiagramAST): DiagramObject[] {
  const out: DiagramObject[] = [];
  const walk = (objects: readonly DiagramObject[]): void => {
    for (const o of objects) {
      out.push(o);
      walk(o.children);
    }
  };
  walk(ast.objects);
  return out;
}

export function objectsById(ast: DiagramAST): Map<string, DiagramObject> {
  return new Map(flattenObjects(ast).map((o) => [o.id, o]));
}
