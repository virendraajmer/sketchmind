/**
 * The stroke generator interface (Volume 06 §Extensibility: "Allow plugins for
 * ... stroke generators").
 *
 * A generator answers one question: given a placed object, what pen paths draw
 * it? It does not decide *when* the object is drawn -- that is the planner's
 * ordering pass (D-3) -- and it never sees the rest of the diagram, so two
 * objects of the same type always produce the same shape.
 */
import type {
  DiagramObject,
  FreeformShape,
  LayoutNode,
  Point,
  StrokeStyle,
  StrokeType,
} from "@sketchmind/shared-types";

export interface GeneratorInput {
  /** The object being drawn, for its type, name, and declared anchors. */
  readonly object: DiagramObject;
  /** Its solved geometry. The only place a generator may read coordinates from. */
  readonly node: LayoutNode;
  /** The one-off shape this object resolved to, when it has one (AD-5). */
  readonly shape?: FreeformShape;
}

/**
 * One pen path. No id, order, timing, or dependencies -- a generator has no way
 * to know those, and the planner assigns them once it has every stroke in hand.
 */
export interface GeneratedStroke {
  readonly type: StrokeType;
  readonly points: readonly Point[];
  /** Required when `type` is `text`. */
  readonly text?: string;
  /** Merged over the planner's defaults. Generators state intent, not appearance. */
  readonly style?: Partial<StrokeStyle>;
}

export interface StrokeGenerator {
  readonly name: string;
  generate(input: GeneratorInput): GeneratedStroke[];
}
