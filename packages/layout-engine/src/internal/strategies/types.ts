/**
 * The strategy interface (Volume 05 §Extensibility: "allow plugins to register
 * custom layout algorithms; core engine must remain unchanged"). Every
 * strategy arranges one sibling group at a time -- the recursive per-container
 * walk in `internal/solve.ts` is what makes a strategy apply at every nesting
 * level, not just the top one.
 */
import type { Constraint, Point, Size } from "@sketchmind/shared-types";

export interface StrategyInput {
  /** Sibling ids to arrange, already in declaration order. */
  readonly nodeIds: readonly string[];
  readonly sizes: ReadonlyMap<string, Size>;
  /** Constraints whose `from` and `to` are both in `nodeIds`. */
  readonly constraints: readonly Constraint[];
  readonly order: ReadonlyMap<string, number>;
}

export interface StrategyResult {
  /** Top-left position per node, in an arbitrary local frame -- the caller normalizes it. */
  readonly positions: ReadonlyMap<string, Point>;
}

export interface LayoutStrategy {
  readonly name: string;
  arrange(input: StrategyInput): StrategyResult;
}
