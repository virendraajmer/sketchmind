/**
 * Generator registry (D-4), the same extension-point shape `layout-engine` uses
 * for layout strategies.
 *
 * Two generators ship. That is not an oversight: nothing upstream of this
 * package knows an object's shape -- the AST's `type` is an open string (AD-5)
 * and Phase 6 gave every leaf the same box -- so a larger built-in table would
 * be inventing knowledge that belongs in a primitive manifest (`primitive-sdk`,
 * Phase 12). `registerStrokeGenerator` is how a manifest, or a plugin, supplies
 * the real thing without this package changing.
 */
import { boxGenerator } from "./box.js";
import { discGenerator } from "./disc.js";
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

export const DEFAULT_GENERATOR = "box";

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
