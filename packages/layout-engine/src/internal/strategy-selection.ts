/**
 * Strategy selection is driven by `DiagramAST.category` -- diagram metadata
 * the AST already carries -- never hardcoded at a call site (Phase 6
 * acceptance). An explicit `options.strategy` always wins, which is how a
 * caller opts into a plugin-registered strategy this table doesn't know about.
 */
import type { DiagramCategory } from "@sketchmind/shared-types";

export const DEFAULT_STRATEGY_FOR_CATEGORY: Readonly<Record<DiagramCategory, string>> = {
  schematic: "hierarchical",
  structural: "hierarchical",
  flow: "hierarchical",
  hierarchy: "hierarchical",
  timeline: "hierarchical",
  cycle: "grid",
  comparison: "grid",
  graph: "grid",
  map: "grid",
  freeform: "grid",
};

export function selectStrategyName(category: DiagramCategory, explicit?: string): string {
  return explicit ?? DEFAULT_STRATEGY_FOR_CATEGORY[category];
}
