/**
 * The seven deterministic checks (Phase 10 tier 1).
 *
 * Each is a pure function from the models the pipeline already produced to a
 * list of findings, and each is independently switchable. They cost no tokens
 * and no model call, which is what lets them run on every diagram rather than on
 * the ones someone remembered to inspect.
 *
 * Every threshold is an option with a documented default. A check that needed a
 * magic number in its body would be untunable without an edit, and tuning is
 * exactly what these need as real diagrams arrive.
 */
import type {
  BoundingBox,
  CritiqueFinding,
  DiagramAST,
  LayoutModel,
  StrokeAST,
} from "@sketchmind/shared-types";
import {
  boxesOverlap,
  centroidOf,
  containsBox,
  distance,
  segmentsIntersect,
} from "./geometry.js";

export type CheckName =
  | "overlap"
  | "out-of-bounds"
  | "anchor-miss"
  | "connector-crossing"
  | "degenerate-size"
  | "whitespace-imbalance"
  | "stroke-coverage";

export interface GeometricCritiqueOptions {
  /** Linear slack before two boxes count as overlapping. */
  readonly overlapToleranceUnits?: number;
  /** How far a connector endpoint may sit from its declared anchor. */
  readonly anchorToleranceUnits?: number;
  /** Below this on either axis, a node is degenerate. */
  readonly minDimensionUnits?: number;
  /** Centroid offset from canvas centre, as a fraction of canvas size. */
  readonly whitespaceImbalanceRatio?: number;
  readonly checks?: Partial<Record<CheckName, boolean>>;
}

export const DEFAULT_OPTIONS: Required<Omit<GeometricCritiqueOptions, "checks">> & {
  checks: Record<CheckName, boolean>;
} = {
  overlapToleranceUnits: 0.5,
  anchorToleranceUnits: 2,
  minDimensionUnits: 1,
  whitespaceImbalanceRatio: 0.25,
  checks: {
    overlap: true,
    "out-of-bounds": true,
    "anchor-miss": true,
    "connector-crossing": true,
    "degenerate-size": true,
    "whitespace-imbalance": true,
    "stroke-coverage": true,
  },
};

export interface CheckInput {
  readonly ast: DiagramAST;
  readonly layout: LayoutModel;
  readonly strokes?: StrokeAST;
  readonly options: typeof DEFAULT_OPTIONS;
}

export interface Check {
  readonly name: CheckName;
  run(input: CheckInput): CritiqueFinding[];
}

/**
 * Ids are derived from the check and the objects rather than generated, so the
 * same problem produces the same id every round. The round-cap comparison does
 * not depend on this -- `findingsEqual` ignores ids -- but a stable id is what
 * lets a UI keep a finding selected across a re-critique.
 */
function finding(
  check: CheckName,
  severity: CritiqueFinding["severity"],
  message: string,
  objectIds: string[],
  proposal?: CritiqueFinding["proposal"],
): CritiqueFinding {
  return {
    id: `${check}:${objectIds.join("+") || "diagram"}`,
    tier: "geometric",
    check,
    severity,
    message,
    objectIds,
    ...(proposal ? { proposal } : {}),
  };
}

const canvasBox = (layout: LayoutModel): BoundingBox => ({
  x: 0,
  y: 0,
  width: layout.canvas.width,
  height: layout.canvas.height,
});

const overlap: Check = {
  name: "overlap",
  run({ layout, options }) {
    const found: CritiqueFinding[] = [];
    const { nodes, labels } = layout;

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        // Containment is a legitimate arrangement -- Phase 6's `intersects`
        // exemption -- so only partial overlap is a finding.
        if (containsBox(a.bounds, b.bounds) || containsBox(b.bounds, a.bounds)) continue;
        if (!boxesOverlap(a.bounds, b.bounds, options.overlapToleranceUnits)) continue;
        found.push(
          finding("overlap", "error", `"${a.objectId}" and "${b.objectId}" overlap on the board.`, [
            a.objectId,
            b.objectId,
          ], { kind: "move_object", objectId: b.objectId, hint: `move it clear of "${a.objectId}"` }),
        );
      }
    }

    for (const label of labels) {
      for (const nodeItem of nodes) {
        if (label.targetId === nodeItem.objectId) continue;
        if (!boxesOverlap(label.bounds, nodeItem.bounds, options.overlapToleranceUnits)) continue;
        found.push(
          finding(
            "overlap",
            "warning",
            `Label "${label.text}" sits on top of "${nodeItem.objectId}".`,
            [label.labelId, nodeItem.objectId],
            { kind: "reposition_label", labelId: label.labelId, hint: "move it to clear space" },
          ),
        );
      }
    }

    return found;
  },
};

const outOfBounds: Check = {
  name: "out-of-bounds",
  run({ layout }) {
    const canvas = canvasBox(layout);
    const found: CritiqueFinding[] = [];

    for (const nodeItem of layout.nodes) {
      if (containsBox(canvas, nodeItem.bounds)) continue;
      found.push(
        finding("out-of-bounds", "error", `"${nodeItem.objectId}" extends past the canvas edge.`, [
          nodeItem.objectId,
        ], { kind: "move_object", objectId: nodeItem.objectId, hint: "bring it inside the canvas" }),
      );
    }

    for (const label of layout.labels) {
      if (containsBox(canvas, label.bounds)) continue;
      found.push(
        finding("out-of-bounds", "warning", `Label "${label.text}" extends past the canvas edge.`, [
          label.labelId,
        ], { kind: "reposition_label", labelId: label.labelId, hint: "bring it inside the canvas" }),
      );
    }

    return found;
  },
};

const anchorMiss: Check = {
  name: "anchor-miss",
  run({ layout, options }) {
    const found: CritiqueFinding[] = [];
    const byId = new Map(layout.nodes.map((n) => [n.objectId, n]));

    for (const connector of layout.connectors) {
      // The solver records which anchor each end was routed to. Without that
      // there is nothing to check against -- an endpoint in open space is a
      // routing choice, not a miss.
      const meta = connector.metadata ?? {};
      for (const [key, index] of [
        ["sourceAnchor", 0],
        ["targetAnchor", connector.points.length - 1],
      ] as const) {
        const ref = meta[key];
        if (typeof ref !== "string") continue;
        const [objectId, anchorName] = ref.split(":");
        if (!objectId || !anchorName) continue;

        const target = byId.get(objectId);
        const anchor = target?.anchors.find((a) => a.name === anchorName);
        if (!anchor) continue;

        const endpoint = connector.points[index]!;
        const gap = distance(endpoint, anchor.point);
        if (gap <= options.anchorToleranceUnits) continue;

        found.push(
          finding(
            "anchor-miss",
            "error",
            `Connector "${connector.relationshipId}" does not meet "${objectId}"'s ` +
              `"${anchorName}" anchor.`,
            [objectId, connector.relationshipId],
            {
              kind: "move_object",
              objectId,
              hint: `attach the connector to the "${anchorName}" anchor`,
            },
          ),
        );
      }
    }

    return found;
  },
};

const connectorCrossing: Check = {
  name: "connector-crossing",
  run({ layout }) {
    const found: CritiqueFinding[] = [];
    const connectors = layout.connectors;

    for (let i = 0; i < connectors.length; i += 1) {
      for (let j = i + 1; j < connectors.length; j += 1) {
        const a = connectors[i]!;
        const b = connectors[j]!;
        if (!crosses(a.points, b.points)) continue;
        found.push(
          finding(
            "connector-crossing",
            "warning",
            `Connectors "${a.relationshipId}" and "${b.relationshipId}" cross.`,
            [a.relationshipId, b.relationshipId],
            {
              kind: "redraw_object",
              objectId: b.relationshipId,
              hint: "route it around the other connector",
            },
          ),
        );
      }
    }

    return found;
  },
};

function crosses(a: readonly { x: number; y: number }[], b: readonly { x: number; y: number }[]): boolean {
  for (let i = 0; i < a.length - 1; i += 1) {
    for (let j = 0; j < b.length - 1; j += 1) {
      if (segmentsIntersect(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!)) return true;
    }
  }
  return false;
}

const degenerateSize: Check = {
  name: "degenerate-size",
  run({ layout, options }) {
    return layout.nodes
      .filter(
        (n) => n.size.width < options.minDimensionUnits || n.size.height < options.minDimensionUnits,
      )
      .map((n) =>
        finding("degenerate-size", "error", `"${n.objectId}" has no usable size.`, [n.objectId], {
          kind: "resize_object",
          objectId: n.objectId,
          hint: "give it a visible width and height",
        }),
      );
  },
};

const whitespaceImbalance: Check = {
  name: "whitespace-imbalance",
  run({ layout, options }) {
    if (layout.nodes.length === 0) return [];

    const centre = centroidOf(layout.nodes.map((n) => n.bounds));
    const dx = Math.abs(centre.x - layout.canvas.width / 2) / layout.canvas.width;
    const dy = Math.abs(centre.y - layout.canvas.height / 2) / layout.canvas.height;
    if (dx <= options.whitespaceImbalanceRatio && dy <= options.whitespaceImbalanceRatio) return [];

    // Advisory only, and deliberately without a proposal: which object should
    // move to balance a diagram is a judgement, and inventing one here would
    // send the agent chasing a number rather than looking at the picture.
    return [
      finding(
        "whitespace-imbalance",
        "info",
        "The diagram's content is bunched to one side; the board looks unbalanced.",
        [],
      ),
    ];
  },
};

const strokeCoverage: Check = {
  name: "stroke-coverage",
  run({ layout, strokes }) {
    if (!strokes) return [];
    const drawn = new Set(strokes.strokes.map((s) => s.target));
    return layout.nodes
      .filter((n) => !drawn.has(n.objectId))
      .map((n) =>
        finding("stroke-coverage", "error", `Nothing was drawn for "${n.objectId}".`, [n.objectId], {
          kind: "redraw_object",
          objectId: n.objectId,
          hint: "plan strokes for it",
        }),
      );
  },
};

export const CHECKS: readonly Check[] = [
  overlap,
  outOfBounds,
  anchorMiss,
  connectorCrossing,
  degenerateSize,
  whitespaceImbalance,
  strokeCoverage,
];
