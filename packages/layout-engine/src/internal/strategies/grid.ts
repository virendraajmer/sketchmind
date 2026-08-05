/**
 * Grid strategy: row-major placement into a near-square grid, cell-sized to
 * the largest member so every cell lines up (Volume 05 §Layout Strategies).
 * No directional constraints are consulted -- `comparison`/`graph`/`map`
 * diagrams rarely state "above" or "leftOf" with any spatial intent, and a
 * grid that tried to honour them would just be a worse hierarchical strategy.
 * Declaration order is the only ordering signal, which is the same
 * determinism guarantee (AD-6) every other strategy gives.
 */
import type { Point } from "@sketchmind/shared-types";
import { SIBLING_GAP } from "../sizing.js";
import type { LayoutStrategy, StrategyInput, StrategyResult } from "./types.js";

export const gridStrategy: LayoutStrategy = {
  name: "grid",
  arrange(input: StrategyInput): StrategyResult {
    const ids = [...input.nodeIds].sort((a, b) => (input.order.get(a) ?? 0) - (input.order.get(b) ?? 0));
    const columns = Math.max(1, Math.ceil(Math.sqrt(ids.length)));

    let cellWidth = 0;
    let cellHeight = 0;
    for (const id of ids) {
      const size = input.sizes.get(id) ?? { width: 0, height: 0 };
      cellWidth = Math.max(cellWidth, size.width);
      cellHeight = Math.max(cellHeight, size.height);
    }

    const positions = new Map<string, Point>();
    ids.forEach((id, i) => {
      const row = Math.floor(i / columns);
      const col = i % columns;
      positions.set(id, {
        x: col * (cellWidth + SIBLING_GAP),
        y: row * (cellHeight + SIBLING_GAP),
      });
    });

    return { positions };
  },
};
