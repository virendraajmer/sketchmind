/**
 * Generator registry (D-4), the same extension-point shape `layout-engine` uses
 * for layout strategies.
 *
 * The type table below stays short on purpose: the AST's `type` is an open
 * string (AD-5), so a large built-in table would be inventing knowledge that
 * belongs to the shape itself. An object the table cannot name is not a box by
 * default -- it is a box only if nothing composed a `FreeformShape` for it, in
 * which case `freeform` draws whatever the agent worked out.
 * `registerStrokeGenerator` remains how a manifest or plugin supplies more.
 */
import { boxGenerator } from "./box.js";
import { discGenerator } from "./disc.js";
import { freeformGenerator } from "./freeform.js";
import type { StrokeGenerator } from "./types.js";

const registry = new Map<string, StrokeGenerator>();

export function registerStrokeGenerator(generator: StrokeGenerator): void {
  registry.set(generator.name, generator);
}

export function getStrokeGenerator(name: string): StrokeGenerator | undefined {
  return registry.get(name);
}

export function registeredStrokeGeneratorNames(): string[] {
  return [...registry.keys()].sort();
}

registerStrokeGenerator(boxGenerator);
registerStrokeGenerator(discGenerator);
registerStrokeGenerator(freeformGenerator);

export const DEFAULT_GENERATOR = "box";
export const FREEFORM_GENERATOR = "freeform";

/**
 * Semantic type -> generator. Short on purpose: these are the types where
 * "round" is inherent to the word rather than a styling choice. Everything else
 * is a box until a manifest says otherwise.
 */
export const GENERATOR_FOR_TYPE: Readonly<Record<string, string>> = {
  pulley: "disc",
  wheel: "disc",
  gear: "disc",
  circle: "disc",
  ellipse: "disc",
  disc: "disc",
  node: "disc",
  ball: "disc",
  sphere: "disc",
  atom: "disc",
  cell: "disc",
  nucleus: "disc",
  planet: "disc",
  orbit: "disc",
};

export function generatorNameFor(type: string): string {
  return GENERATOR_FOR_TYPE[type] ?? DEFAULT_GENERATOR;
}
