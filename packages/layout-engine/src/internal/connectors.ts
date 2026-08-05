/**
 * Straight connector routing (Volume 05 §Connector Routing). Only the MVP
 * routing style is implemented -- orthogonal/curved/smart avoidance are
 * `RoutingStyleSchema` members this package does not yet produce, left for
 * whichever later phase needs a connector that steps around an obstacle
 * instead of crossing it.
 *
 * A relationship becomes a connector when it means "these two are joined",
 * not "these two are placed relative to one another" -- `above`, `leftOf`,
 * `centeredOn` and friends already spent themselves on position and draw
 * nothing. `intersects` draws nothing either: two shapes stated to overlap
 * are drawn overlapping, not joined by a line.
 */
import type { BoundingBox, ConnectorPath, DiagramAST, RelationshipType } from "@sketchmind/shared-types";
import { edgePointToward } from "./geometry.js";

const CONNECTOR_RELATIONSHIPS: ReadonlySet<RelationshipType> = new Set([
  "connectedTo",
  "attachedTo",
  "wraps",
  "parallelTo",
  "pointsTo",
]);

export function buildConnectors(ast: DiagramAST, boxes: ReadonlyMap<string, BoundingBox>): ConnectorPath[] {
  const paths: ConnectorPath[] = [];
  for (const relationship of ast.relationships) {
    if (!CONNECTOR_RELATIONSHIPS.has(relationship.type)) continue;
    const fromBox = boxes.get(relationship.from);
    const toBox = boxes.get(relationship.to);
    if (!fromBox || !toBox) continue;

    paths.push({
      relationshipId: relationship.id,
      routing: "straight",
      points: [edgePointToward(fromBox, toBox), edgePointToward(toBox, fromBox)],
    });
  }
  return paths;
}
