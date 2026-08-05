/**
 * Hierarchical strategy: rank nodes vertically from `above`/`below`, order
 * each rank horizontally from `leftOf`/`rightOf`, then apply the remaining
 * positional constraints (`centeredOn`, `alignedWith`, `equalSpacing`) as
 * post-passes over the row/column placement (Volume 05 §Layout Strategies,
 * §Object Positioning). Suits `schematic`/`structural`/`flow`/`hierarchy`/
 * `timeline` diagrams, where "what's above what" carries real meaning.
 */
import type { Point, Size } from "@sketchmind/shared-types";
import { longestPathRank, topoOrder, type Edge } from "../dag.js";
import { SIBLING_GAP } from "../sizing.js";
import type { LayoutStrategy, StrategyInput, StrategyResult } from "./types.js";

function edgesOf(input: StrategyInput, forward: string, backward: string): Edge[] {
  const edges: Edge[] = [];
  for (const c of input.constraints) {
    if (c.type === forward) edges.push([c.from, c.to]);
    if (c.type === backward) edges.push([c.to, c.from]);
  }
  return edges;
}

function groupByRank(nodeIds: readonly string[], rank: ReadonlyMap<string, number>): string[][] {
  const rows = new Map<number, string[]>();
  for (const id of nodeIds) {
    const r = rank.get(id) ?? 0;
    const row = rows.get(r) ?? [];
    row.push(id);
    rows.set(r, row);
  }
  return [...rows.keys()].sort((a, b) => a - b).map((r) => rows.get(r)!);
}

function applyAlignedWith(input: StrategyInput, positions: Map<string, Point>): void {
  const pairs = input.constraints.filter((c) => c.type === "alignedWith");
  // Two passes: lets a chain (a aligned to b, b aligned to c) settle without
  // needing a full dependency sort for what is, in practice, a shallow relation.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const c of pairs) {
      const target = positions.get(c.to);
      const source = positions.get(c.from);
      if (target && source) positions.set(c.from, { x: source.x, y: target.y });
    }
  }
}

function applyCenteredOn(input: StrategyInput, positions: Map<string, Point>, sizes: ReadonlyMap<string, Size>): void {
  const pairs = input.constraints.filter((c) => c.type === "centeredOn");
  for (let pass = 0; pass < 2; pass += 1) {
    for (const c of pairs) {
      const target = positions.get(c.to);
      const source = positions.get(c.from);
      const targetSize = sizes.get(c.to);
      const sourceSize = sizes.get(c.from);
      if (!target || !source || !targetSize || !sourceSize) continue;
      const targetCenterX = target.x + targetSize.width / 2;
      positions.set(c.from, { x: targetCenterX - sourceSize.width / 2, y: source.y });
    }
  }
}

/**
 * Equal spacing along whichever axis the chain actually varies on -- a
 * horizontal group stays horizontal, a vertical one stays vertical. The first
 * member holds still; the rest are redistributed at the chain's average gap.
 */
function applyEqualSpacing(
  input: StrategyInput,
  positions: Map<string, Point>,
  sizes: ReadonlyMap<string, Size>,
): void {
  const pairs = input.constraints.filter((c) => c.type === "equalSpacing");
  if (pairs.length === 0) return;

  // Chain segments are declared consecutively (constraint-engine emits
  // members[i]-members[i+1]); walk them in that order to rebuild each chain.
  const chains: string[][] = [];
  let current: string[] = [];
  for (const c of pairs) {
    if (current.length === 0 || current[current.length - 1] !== c.from) {
      if (current.length > 1) chains.push(current);
      current = [c.from, c.to];
    } else {
      current.push(c.to);
    }
  }
  if (current.length > 1) chains.push(current);

  for (const chain of chains) {
    const pts = chain.map((id) => positions.get(id)).filter((p): p is Point => p !== undefined);
    if (pts.length !== chain.length) continue;

    const dx = Math.abs((pts.at(-1)?.x ?? 0) - (pts[0]?.x ?? 0));
    const dy = Math.abs((pts.at(-1)?.y ?? 0) - (pts[0]?.y ?? 0));
    const horizontal = dx >= dy;

    const first = pts[0]!;
    let cursor = horizontal ? first.x : first.y;
    positions.set(chain[0]!, first);
    for (let i = 1; i < chain.length; i += 1) {
      const id = chain[i]!;
      const size = sizes.get(chain[i - 1]!) ?? { width: 0, height: 0 };
      cursor += horizontal ? size.width + SIBLING_GAP : size.height + SIBLING_GAP;
      const existing = positions.get(id);
      if (!existing) continue;
      positions.set(id, horizontal ? { x: cursor, y: existing.y } : { x: existing.x, y: cursor });
    }
  }
}

export const hierarchicalStrategy: LayoutStrategy = {
  name: "hierarchical",
  arrange(input: StrategyInput): StrategyResult {
    const verticalEdges = edgesOf(input, "above", "below");
    const rank = longestPathRank(input.nodeIds, verticalEdges);
    const rows = groupByRank(input.nodeIds, rank);

    const horizontalEdges = edgesOf(input, "leftOf", "rightOf");
    const positions = new Map<string, Point>();

    let y = 0;
    for (const row of rows) {
      const ordered = topoOrder(row, horizontalEdges, input.order);
      let x = 0;
      let rowHeight = 0;
      for (const id of ordered) {
        const size = input.sizes.get(id) ?? { width: 0, height: 0 };
        positions.set(id, { x, y });
        x += size.width + SIBLING_GAP;
        rowHeight = Math.max(rowHeight, size.height);
      }
      y += rowHeight + SIBLING_GAP;
    }

    applyAlignedWith(input, positions);
    applyCenteredOn(input, positions, input.sizes);
    applyEqualSpacing(input, positions, input.sizes);

    return { positions };
  },
};
