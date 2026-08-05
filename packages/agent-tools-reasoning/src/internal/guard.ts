/**
 * The geometry boundary, enforced on live tool output.
 *
 * `shared-types` already proves the *schemas* are geometry-free
 * (`tests/geometry-purity.test.ts`). That is a static guarantee about shapes we
 * declared. This is the runtime one, and they are not the same guarantee: every
 * semantic model carries an open `metadata` / `properties` / `parameters` bag,
 * and a model that decides to helpfully stash `{ x: 40, y: 120 }` in one of them
 * passes every schema in the repo.
 *
 * Global Constraints say no AI component outputs coordinates. This is the check
 * that makes that true of what the agent actually emits rather than of what we
 * intended it to emit.
 *
 * A violation is recoverable (AD-2): the model added a field it was told not to,
 * is told which one, and removes it on the next step.
 */
import { makeError, type PipelineStage, type SketchMindError } from "@sketchmind/shared-types";

export const PACKAGE = "@sketchmind/agent-tools-reasoning";

/**
 * Property names that mean "a place, a size, or a rendering instruction".
 *
 * Mirrors the list `shared-types` guards its schemas with, plus `svg` and
 * `canvasCommand` -- the two that only ever appear when a model has decided to
 * skip the pipeline and draw directly.
 */
export const BANNED_FIELDS: readonly string[] = [
  "x", "y", "cx", "cy", "dx", "dy",
  "width", "height", "rotation", "scale",
  "left", "top", "right", "bottom",
  "points", "path", "d", "transform",
  "bounds", "boundingBox", "viewBox", "coordinates",
  "position", "offset", "translate",
  "svg", "canvasCommand",
];

/**
 * The same list minus `points`, for `FreeformShape` (AD-5).
 *
 * A freeform shape's `points` are `{ u, v }` proportions inside the shape's own
 * 0..1 box -- closer to an SVG viewBox than to layout, and bounded by the schema
 * so nothing outside 0..1 survives parsing. `svg`, `path` and `transform` stay
 * banned even here: the relaxation is "proportions", not "draw it yourself".
 */
export const BANNED_FIELDS_UNIT_SPACE: readonly string[] = BANNED_FIELDS.filter(
  (field) => field !== "points",
);

/** Every path at which a banned property name appears. Depth-first, all of them. */
export function geometryViolations(
  value: unknown,
  banned: readonly string[] = BANNED_FIELDS,
): string[] {
  const bannedSet = new Set(banned);
  const found: string[] = [];

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (bannedSet.has(key)) found.push(childPath);
      walk(child, childPath);
    }
  };

  walk(value, "");
  return found;
}

export function geometryErrors(
  value: unknown,
  stage: PipelineStage,
  banned: readonly string[] = BANNED_FIELDS,
): SketchMindError[] {
  return geometryViolations(value, banned).map((path) =>
    makeError({
      code: "AI_EMITTED_GEOMETRY",
      message:
        `"${path.split(".").pop()}" is a geometry or rendering field, and no reasoning stage may ` +
        `produce one. Describe what exists; the layout engine decides where it goes. Remove this field.`,
      package: PACKAGE,
      stage,
      recoverable: true,
      path,
    }),
  );
}
