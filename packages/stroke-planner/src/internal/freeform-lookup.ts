/**
 * Which `FreeformShape` an object is drawn with (AD-5).
 *
 * Two ways in, because the composing and the composed are decided in different
 * tool calls and the model does not reliably connect them. An explicit
 * `properties.freeformId` is the contract; matching the object's own `type` or
 * `name` against the shape's is the fallback that makes "compose a hexagon,
 * then compose a diagram containing a hexagon" work without the model having to
 * remember to cross-reference an id it invented two turns ago.
 */
import type { DiagramObject, FreeformShape } from "@sketchmind/shared-types";

/** Ids, names and types are agent-authored, so `Lightning Bolt` must match `lightning-bolt`. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

export function resolveFreeform(
  object: DiagramObject,
  shapes: ReadonlyMap<string, FreeformShape> | undefined,
): FreeformShape | undefined {
  if (!shapes || shapes.size === 0) return undefined;

  const declared = object.properties?.["freeformId"];
  if (typeof declared === "string") {
    const exact = shapes.get(declared);
    if (exact) return exact;
  }

  const wanted = new Set(
    [typeof declared === "string" ? declared : undefined, object.type, object.name]
      .filter((value): value is string => typeof value === "string")
      .map(normalize),
  );

  for (const shape of shapes.values()) {
    if (wanted.has(normalize(shape.id)) || wanted.has(normalize(shape.name))) return shape;
  }
  return undefined;
}
