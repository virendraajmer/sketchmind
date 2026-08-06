/**
 * @sketchmind/agent-tools-geometry
 *
 * The geometry pipeline, exposed as agent tools (AD-1).
 *
 * Like `agent-tools-reasoning`, this package owns no pipeline logic of its own.
 * `constraint-engine`, `layout-engine` and `stroke-planner` keep their V12
 * contracts and know nothing about agents; this is the seam that turns them into
 * a tool catalogue.
 *
 * There is no render tool here, and that is not an omission. Rendering needs a
 * mounted `RendererAdapter`, which lives in the browser -- the server produces a
 * Stroke AST and streams it. There is nothing for a server-locus tool to call.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */

export const PACKAGE_NAME = "@sketchmind/agent-tools-geometry";
export const PACKAGE_VERSION = "0.0.1";

export { createGeometryTools, type GeometryToolsOptions } from "./tools.js";
export { GeometryWorkspace } from "./workspace.js";
