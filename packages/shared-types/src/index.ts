/**
 * @sketchmind/shared-types
 *
 * Canonical home for every model shared across SketchMind packages.
 * No other package may redefine these (Volume 11 §Shared Types, Volume 12).
 *
 * Every model is written once as a Zod schema, with its TypeScript type derived
 * via `z.infer` (D-1). Hand-writing the type alongside the schema gives you two
 * definitions that drift the first time someone edits one.
 *
 * The geometry boundary -- only `LayoutModel` and `StrokeAST` may contain
 * numeric geometry -- is enforced by `tests/geometry-purity.test.ts`, not by
 * convention.
 */

export const PACKAGE_NAME = "@sketchmind/shared-types";
export const PACKAGE_VERSION = "0.0.1";

export * from "./primitives";
export * from "./errors";
export * from "./relationships";
export * from "./intent";
export * from "./constraints";
export * from "./shape-graph";
export * from "./diagram";
export * from "./layout";
export * from "./stroke";
export * from "./freeform";
export * from "./runtime";
export * from "./agent";
