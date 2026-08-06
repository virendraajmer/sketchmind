/**
 * The planner (Volume 06 §Stroke Planner): Layout Model + Diagram AST -> an
 * ordered, timed drawing sequence.
 *
 * Three passes:
 *
 *   1. Collect every drawable thing -- objects, connectors, annotations,
 *      labels -- tagging each with its drawing phase (D-3) and a stable sort
 *      key. Nothing is generated yet.
 *   2. Sort by (phase, containment depth, layout order). This is the whole of
 *      "outlines first, details after, labels last", and it is decided without
 *      looking at a single coordinate, so a layout nudge cannot reshuffle it.
 *   3. Walk the sorted list generating pen paths, carrying the pen's position
 *      forward so each path can choose which end to start from (D-5), and
 *      assigning ids, order, dependencies, and timing once every stroke exists.
 *
 * The AST is needed alongside the layout for the same reason `layout-engine`
 * needed it alongside the constraint graph (Phase 6 D-5): geometry does not
 * carry meaning. See D-2.
 */
import {
  makeError,
  type BoundingBox,
  type DiagramAST,
  type DiagramObject,
  type LayoutLabel,
  type LayoutModel,
  type Point,
  type Relationship,
  type SketchMindError,
  type Stroke,
  type StrokeStyle,
  type StrokeType,
} from "@sketchmind/shared-types";
import { boundsOf, orientPath, roundPoint, unionBounds } from "./geometry.js";
import {
  generatorNameFor,
  getStrokeGenerator,
  registeredStrokeGeneratorNames,
} from "./generators/registry.js";
import type { GeneratedStroke } from "./generators/types.js";
import {
  flattenObjects,
  phaseForDepth,
  phaseIndex,
  type DrawingPhase,
  type FlatObject,
} from "./ordering.js";
import { PHASE_PAUSE_MS, durationFor } from "./timing.js";

export const PACKAGE = "@sketchmind/stroke-planner";

export function err(
  code: string,
  message: string,
  path = "",
  details?: Record<string, unknown>,
): SketchMindError {
  return makeError({ code, message, package: PACKAGE, stage: "stroke", recoverable: true, path, details });
}

export interface PlanOptions {
  /** Run the optimizer as part of planning. Default true (Volume 06 §Pipeline). */
  readonly optimize?: boolean;
  /**
   * Override generator selection per object -- the hook a primitive manifest or
   * a plugin uses. Returning `undefined` falls back to the type table (D-4).
   */
  readonly generatorFor?: (object: DiagramObject) => string | undefined;
  /** Merged over every stroke's phase defaults. Pen configuration, not appearance. */
  readonly style?: Partial<StrokeStyle>;
}

/**
 * Pen defaults per phase (Volume 06 §Pen Simulation). Outlines are drawn with a
 * heavier, shakier hand than labels, which is how a whiteboard actually looks:
 * you press harder on the structure and write text carefully.
 */
const PHASE_STYLE: Readonly<Record<DrawingPhase, Partial<StrokeStyle>>> = {
  outline: { width: 2.5, jitter: 0.18 },
  detail: { width: 2, jitter: 0.15 },
  connector: { width: 2, jitter: 0.12 },
  annotation: { width: 1.5, jitter: 0.06, ink: "pencil" },
  label: { width: 1.5, jitter: 0.05 },
};

const BASE_STYLE: StrokeStyle = {
  width: 2,
  jitter: 0.15,
  pressureProfile: "taperBoth",
  ink: "pen",
  dashed: false,
};

/** Only `pointsTo` asserts a direction; every other join is symmetric (see plan doc). */
function connectorStrokeType(relationship: Relationship | undefined): StrokeType {
  return relationship?.type === "pointsTo" ? "arrow" : "line";
}

interface PlanItem {
  readonly phase: DrawingPhase;
  /** Containment depth, so all depth-1 detail precedes all depth-2 detail. */
  readonly depth: number;
  /** Tie-break within a phase and depth: the layout's own ordering. */
  readonly rank: number;
  /** The AST object this stroke belongs to -- always an object id, never a relationship or label id. */
  readonly target: string;
  readonly strokes: readonly GeneratedStroke[];
  readonly metadata?: Record<string, unknown>;
  /** Contributed to the AST's overall bounds; a text stroke's single point understates its box. */
  readonly bounds: BoundingBox;
}

function styleFor(phase: DrawingPhase, object: DiagramObject | undefined, options: PlanOptions, generated: GeneratedStroke): StrokeStyle {
  const tone = object?.style?.tone;
  return {
    ...BASE_STYLE,
    ...PHASE_STYLE[phase],
    ...(tone === undefined ? {} : { tone }),
    ...generated.style,
    ...options.style,
  };
}

function objectItems(
  layout: LayoutModel,
  objects: ReadonlyMap<string, FlatObject>,
  options: PlanOptions,
): { items: PlanItem[]; errors: SketchMindError[] } {
  const items: PlanItem[] = [];
  const errors: SketchMindError[] = [];

  for (const node of layout.nodes) {
    const flat = objects.get(node.objectId);
    if (!flat) continue; // Already reported by the cross-check in `plan`.

    const name = options.generatorFor?.(flat.object) ?? generatorNameFor(flat.object.type);
    const generator = getStrokeGenerator(name);
    if (!generator) {
      errors.push(
        err(
          "STROKE_GENERATOR_NOT_IMPLEMENTED",
          `Stroke generator '${name}' is not registered. Available: ${registeredStrokeGeneratorNames().join(", ")}.`,
          `nodes.${node.objectId}`,
          { generator: name, objectId: node.objectId, available: registeredStrokeGeneratorNames() },
        ),
      );
      continue;
    }

    items.push({
      phase: phaseForDepth(flat.depth),
      depth: flat.depth,
      rank: node.zIndex,
      target: node.objectId,
      strokes: generator.generate({ object: flat.object, node }),
      metadata: { generator: name, objectType: flat.object.type },
      bounds: node.bounds,
    });
  }

  return { items, errors };
}

function connectorItems(ast: DiagramAST, layout: LayoutModel): PlanItem[] {
  const relationships = new Map(ast.relationships.map((r) => [r.id, r]));
  return layout.connectors.map((connector, index) => {
    const relationship = relationships.get(connector.relationshipId);
    const points = connector.points.map(roundPoint);
    return {
      phase: "connector" as const,
      depth: 0,
      rank: index,
      // The relationship's source object: `target` is defined as the AST object
      // a stroke belongs to, and keeping it one is what makes the optimizer's
      // coverage invariant (D-7) checkable.
      target: relationship?.from ?? connector.relationshipId,
      strokes: [{ type: connectorStrokeType(relationship), points }],
      metadata: {
        relationshipId: connector.relationshipId,
        relationshipType: relationship?.type,
        routing: connector.routing,
      },
      bounds: boundsOf(points),
    };
  });
}

function labelItems(ast: DiagramAST, layout: LayoutModel): PlanItem[] {
  const annotationIds = new Set(ast.annotations.map((a) => a.id));
  return layout.labels.map((label: LayoutLabel, index) => ({
    phase: annotationIds.has(label.labelId) ? ("annotation" as const) : ("label" as const),
    depth: 0,
    rank: index,
    target: label.targetId,
    strokes: [{ type: "text" as const, points: [roundPoint(label.position)], text: label.text }],
    metadata: { labelId: label.labelId },
    bounds: label.bounds,
  }));
}

function compare(a: PlanItem, b: PlanItem): number {
  return (
    phaseIndex(a.phase) - phaseIndex(b.phase) ||
    a.depth - b.depth ||
    a.rank - b.rank
  );
}

export interface PlannedStrokes {
  readonly strokes: Stroke[];
  readonly bounds: BoundingBox | undefined;
  readonly totalDurationMs: number;
}

export type PlanOutcome =
  | { readonly ok: true; readonly value: PlannedStrokes }
  | { readonly ok: false; readonly errors: SketchMindError[] };

export function plan(ast: DiagramAST, layout: LayoutModel, options: PlanOptions = {}): PlanOutcome {
  const objects = flattenObjects(ast);
  const errors: SketchMindError[] = [];

  if (layout.diagramId !== ast.id) {
    errors.push(
      err(
        "STROKE_DIAGRAM_MISMATCH",
        `Layout model was solved for diagram '${layout.diagramId}', not '${ast.id}'.`,
        "diagramId",
        { astId: ast.id, layoutId: layout.diagramId },
      ),
    );
  }
  for (const node of layout.nodes) {
    if (!objects.has(node.objectId)) {
      errors.push(
        err(
          "STROKE_UNKNOWN_OBJECT",
          `Layout node '${node.objectId}' has no corresponding object in the diagram AST.`,
          "nodes",
          { objectId: node.objectId },
        ),
      );
    }
  }
  const placed = new Set(layout.nodes.map((n) => n.objectId));
  for (const id of objects.keys()) {
    if (!placed.has(id)) {
      errors.push(
        err(
          "STROKE_UNKNOWN_OBJECT",
          `AST object '${id}' was never placed by the layout, so it cannot be drawn.`,
          "objects",
          { objectId: id },
        ),
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const fromObjects = objectItems(layout, objects, options);
  if (fromObjects.errors.length > 0) return { ok: false, errors: fromObjects.errors };

  const items = [
    ...fromObjects.items,
    ...connectorItems(ast, layout),
    ...labelItems(ast, layout),
  ].sort(compare);

  const strokes: Stroke[] = [];
  const perTarget = new Map<string, number>();
  let pen: Point | undefined;
  let previousId: string | undefined;

  for (const item of items) {
    for (const generated of item.strokes) {
      const points =
        generated.type === "text"
          ? [...generated.points]
          : orientPath(generated.points, pen).map(roundPoint);
      if (points.length === 0) continue;

      const index = perTarget.get(item.target) ?? 0;
      perTarget.set(item.target, index + 1);
      const id = `${item.target}_s${index}`;

      strokes.push({
        id,
        type: generated.type,
        target: item.target,
        order: strokes.length,
        dependencies: previousId === undefined ? [] : [previousId],
        points,
        ...(generated.text === undefined ? {} : { text: generated.text }),
        style: styleFor(item.phase, objects.get(item.target)?.object, options, generated),
        timing: {
          delayMs: 0,
          durationMs: durationFor(generated.type, points, generated.text),
          // Filled in below, once the next stroke's phase is known.
          pauseAfterMs: 0,
        },
        metadata: { ...item.metadata, phase: item.phase },
      });

      pen = points[points.length - 1]!;
      previousId = id;
    }
  }

  // The beat between phases (D-6 / Volume 06 §Stroke Timing). Known only in
  // retrospect: a stroke pauses after itself if the *next* one starts a new phase.
  for (let i = 0; i < strokes.length - 1; i += 1) {
    const here = strokes[i]!.metadata?.["phase"];
    const next = strokes[i + 1]!.metadata?.["phase"];
    if (here !== next) strokes[i]!.timing.pauseAfterMs = PHASE_PAUSE_MS;
  }

  return {
    ok: true,
    value: {
      strokes,
      bounds: unionBounds(items.map((i) => i.bounds)),
      totalDurationMs: totalDuration(strokes),
    },
  };
}

export function totalDuration(strokes: readonly Stroke[]): number {
  return strokes.reduce(
    (sum, stroke) => sum + stroke.timing.delayMs + stroke.timing.durationMs + stroke.timing.pauseAfterMs,
    0,
  );
}
