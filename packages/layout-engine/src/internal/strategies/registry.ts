/**
 * Strategy registry (Volume 05 §Extensibility: "allow plugins to register
 * custom layout algorithms; core engine must remain unchanged"). Phase 6 ships
 * two -- `hierarchical` and `grid` -- and registers them the same way a future
 * `plugin-sdk` package would register a third, so that arrival changes no code
 * here.
 */
import { LayoutStrategySchema } from "@sketchmind/shared-types";
import { gridStrategy } from "./grid.js";
import { hierarchicalStrategy } from "./hierarchical.js";
import type { LayoutStrategy } from "./types.js";

const registry = new Map<string, LayoutStrategy>();

export function registerStrategy(strategy: LayoutStrategy): void {
  registry.set(strategy.name, strategy);
}

export function getStrategy(name: string): LayoutStrategy | undefined {
  return registry.get(name);
}

export function registeredStrategyNames(): string[] {
  return [...registry.keys()];
}

registerStrategy(hierarchicalStrategy);
registerStrategy(gridStrategy);

/** Every registered name must be one `LayoutModel.strategy` can actually carry. */
for (const name of registry.keys()) {
  if (!LayoutStrategySchema.safeParse(name).success) {
    throw new Error(`Registered strategy '${name}' is not a member of LayoutStrategySchema.`);
  }
}
