/**
 * The solver (Volume 05 §Layout Solver Responsibilities): Constraint Graph +
 * Diagram AST -> a fully placed, collision-resolved, connected, labelled
 * layout. The Constraint Graph carries relationships; the AST supplies what
 * the graph's bare node-id strings cannot -- each object's declared anchors
 * and labels, needed for anchor resolution and label placement.
 *
 * Two passes, bottom-up then top-down, same shape as any box-model layout:
 *
 *   1. `computeSize` walks the containment forest post-order. A leaf gets the
 *      fixed default box; a container arranges its own children first (which
 *      requires their sizes, hence post-order) and wraps them, so a
 *      container's size is only ever "big enough for what's actually inside
 *      it" (Volume 05 §Object Positioning).
 *   2. `place` walks the same forest pre-order, turning each container's
 *      locally-arranged children into absolute positions by adding the
 *      container's own absolute origin. A subtree therefore always moves as
 *      one rigid body -- which is also why collision resolution never needs
 *      an ancestor/descendant exemption (see `arrangeScope`): a container's
 *      wrapped size already encloses everything inside it, so if two
 *      *sibling* boxes don't overlap, nothing nested inside either of them
 *      can overlap the other subtree.
 */
import {
  makeError,
  type BoundingBox,
  type Constraint,
  type ConstraintGraph,
  type ConnectorPath,
  type DiagramAST,
  type LayoutLabel,
  type LayoutNode,
  type Point,
  type ResolvedAnchor,
  type SketchMindError,
  type Size,
} from "@sketchmind/shared-types";
import { overlapExemptions } from "@sketchmind/constraint-engine";
import { resolveAnchorPoint } from "./anchors.js";
import { box, union } from "./geometry.js";
import { buildConnectors } from "./connectors.js";
import { resolveOverlaps } from "./collision.js";
import { buildLabels } from "./labels.js";
import { objectsById } from "./objects.js";
import { CANVAS_MARGIN, CONTAINER_PADDING, leafSize } from "./sizing.js";
import { getStrategy, registeredStrategyNames } from "./strategies/registry.js";
import type { LayoutStrategy } from "./strategies/types.js";
import { selectStrategyName } from "./strategy-selection.js";
import { buildContainmentForest } from "./tree.js";

export const PACKAGE = "@sketchmind/layout-engine";

function err(code: string, message: string, path: string, details?: Record<string, unknown>): SketchMindError {
  return makeError({ code, message, package: PACKAGE, stage: "layout", recoverable: true, path, details });
}

export interface SolveOptions {
  readonly strategy?: string;
}

export interface SolvedLayout {
  readonly strategyName: string;
  readonly canvas: Size;
  readonly nodes: LayoutNode[];
  readonly connectors: ConnectorPath[];
  readonly labels: LayoutLabel[];
}

export type SolveOutcome = { readonly ok: true; readonly value: SolvedLayout } | { readonly ok: false; readonly errors: SketchMindError[] };

function scopedConstraints(ids: readonly string[], all: readonly Constraint[]): Constraint[] {
  const set = new Set(ids);
  return all.filter((c) => set.has(c.from) && set.has(c.to));
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

export function solve(ast: DiagramAST, graph: ConstraintGraph, options: SolveOptions = {}): SolveOutcome {
  const objects = objectsById(ast);
  const errors: SketchMindError[] = [];

  const astIds = new Set(objects.keys());
  const graphIds = new Set(graph.nodes);
  for (const id of astIds) {
    if (!graphIds.has(id)) {
      errors.push(err("LAYOUT_UNKNOWN_OBJECT", `AST object '${id}' has no corresponding node in the constraint graph.`, "", { id }));
    }
  }
  for (const id of graphIds) {
    if (!astIds.has(id)) {
      errors.push(err("LAYOUT_UNKNOWN_OBJECT", `Constraint graph node '${id}' has no corresponding object in the diagram AST.`, "", { id }));
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const strategyName = selectStrategyName(ast.category, options.strategy);
  const strategy = getStrategy(strategyName);
  if (!strategy) {
    return {
      ok: false,
      errors: [
        err(
          "LAYOUT_STRATEGY_NOT_IMPLEMENTED",
          `Strategy '${strategyName}' is not registered. Available: ${registeredStrategyNames().join(", ")}.`,
          "",
          { strategy: strategyName, available: registeredStrategyNames() },
        ),
      ],
    };
  }

  // Rebind: TS does not carry the `!strategy` guard's narrowing into the
  // closures below, since a captured `let`/`const` could in principle change
  // before they run. This one cannot -- rebinding says so once, here.
  const activeStrategy: LayoutStrategy = strategy;

  const exempt = new Set(overlapExemptions(graph).map(([a, b]) => pairKey(a, b)));
  const isExempt = (a: string, b: string): boolean => exempt.has(pairKey(a, b));

  const forest = buildContainmentForest(graph);
  const sizes = new Map<string, Size>();
  const localPositions = new Map<string, Point>();

  function arrangeScope(ids: readonly string[], strat: LayoutStrategy): Map<string, Point> {
    if (ids.length === 0) return new Map();
    const scopeSizes = new Map(ids.map((id) => [id, sizes.get(id)!]));
    const raw = strat.arrange({
      nodeIds: ids,
      sizes: scopeSizes,
      constraints: scopedConstraints(ids, graph.constraints),
      order: forest.order,
    }).positions;

    const boxes = new Map(ids.map((id) => [id, box(raw.get(id)!, scopeSizes.get(id)!)]));
    resolveOverlaps(boxes, ids, isExempt);
    return new Map(ids.map((id) => [id, { x: boxes.get(id)!.x, y: boxes.get(id)!.y }]));
  }

  function computeSize(id: string): Size {
    const children = forest.childrenOf.get(id) ?? [];
    if (children.length === 0) {
      const size = leafSize();
      sizes.set(id, size);
      return size;
    }
    for (const child of children) computeSize(child);

    const positions = arrangeScope(children, activeStrategy);
    const childBoxes = children.map((c) => box(positions.get(c)!, sizes.get(c)!));
    const bbox = union(childBoxes);
    for (const child of children) {
      const p = positions.get(child)!;
      localPositions.set(child, { x: p.x - bbox.x + CONTAINER_PADDING, y: p.y - bbox.y + CONTAINER_PADDING });
    }
    const size: Size = { width: bbox.width + CONTAINER_PADDING * 2, height: bbox.height + CONTAINER_PADDING * 2 };
    sizes.set(id, size);
    return size;
  }

  for (const root of forest.roots) computeSize(root);

  const rootPositions = arrangeScope(forest.roots, activeStrategy);
  const absolute = new Map<string, Point>();
  function place(id: string, origin: Point): void {
    absolute.set(id, origin);
    for (const child of forest.childrenOf.get(id) ?? []) {
      const local = localPositions.get(child)!;
      place(child, { x: origin.x + local.x, y: origin.y + local.y });
    }
  }
  for (const root of forest.roots) place(root, rootPositions.get(root)!);

  const nodeBoxes = new Map<string, BoundingBox>(graph.nodes.map((id) => [id, box(absolute.get(id)!, sizes.get(id)!)]));
  const connectors = buildConnectors(ast, nodeBoxes);
  const flatObjects = [...objects.values()];
  const labels = buildLabels(ast, flatObjects, nodeBoxes);

  const bbox = union([...nodeBoxes.values(), ...labels.map((l) => l.bounds)]);
  const shift: Point = { x: CANVAS_MARGIN - bbox.x, y: CANVAS_MARGIN - bbox.y };

  const shiftPoint = (p: Point): Point => ({ x: p.x + shift.x, y: p.y + shift.y });
  const shiftBox = (b: BoundingBox): BoundingBox => ({ ...b, x: b.x + shift.x, y: b.y + shift.y });

  const nodes: LayoutNode[] = graph.nodes.map((id, index) => {
    const position = shiftPoint(absolute.get(id)!);
    const size = sizes.get(id)!;
    const bounds = shiftBox(nodeBoxes.get(id)!);
    const declaredAnchors = objects.get(id)?.anchors ?? [];
    const anchors: ResolvedAnchor[] = declaredAnchors.map((a, i) => ({
      name: a.name,
      point: resolveAnchorPoint(bounds, i),
    }));
    return { objectId: id, position, size, rotation: 0, bounds, anchors, zIndex: index };
  });

  return {
    ok: true,
    value: {
      strategyName,
      canvas: { width: bbox.width + CANVAS_MARGIN * 2, height: bbox.height + CANVAS_MARGIN * 2 },
      nodes,
      connectors: connectors.map((c) => ({ ...c, points: c.points.map(shiftPoint) })),
      labels: labels.map((l) => ({ ...l, position: shiftPoint(l.position), bounds: shiftBox(l.bounds) })),
    },
  };
}
