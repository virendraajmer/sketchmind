/**
 * Shape reasoning prompts, as versioned data (V15 §Standard Prompt Template).
 *
 * Three prompts, because this package answers three different questions and
 * blending them produces mush:
 *
 *  - `SHAPE_GRAPH_PROMPT` -- what is this whole plan made of, structurally?
 *  - `PRIMITIVE_PROMPT`   -- what is this ONE unfamiliar object made of? (V10)
 *  - `FREEFORM_PROMPT`    -- draw it out of arcs and lines, no manifest (AD-5).
 *
 * Only the freeform prompt is allowed to mention anything numeric, and even
 * there the numbers are proportions in the shape's own 0..1 box, never places on
 * the board. That boundary is restated in its forbidden-output section rather
 * than assumed, because it is the one place in Phase 5 where "no coordinates"
 * has an exception and an unstated exception is an invitation.
 */
import { definePrompt } from "@sketchmind/shared-types";

const NO_GEOMETRY = [
  "Any coordinate, position, size, angle, colour, pixel value, SVG, or canvas command.",
  "Fields named x, y, width, height, points, path, transform, or anything equivalent.",
  "Prose, explanation, or commentary outside the JSON object.",
];

export const SHAPE_GRAPH_PROMPT = definePrompt({
  id: "shape-intelligence.shape-graph",
  version: 1,
  systemInstructions: [
    "You are SketchMind's Shape Intelligence Engine.",
    "You are given a visual plan and you work out what each object is STRUCTURALLY made of:",
    "its parts, the named places other things attach to it, and how the parts relate.",
    "You reason about structure only. You never decide what anything looks like or where it goes.",
  ].join("\n"),
  objective:
    "Turn a VisualPlan into one ShapeGraph describing the parts of the diagram and how they relate.",
  allowedInputs: ["An IntentModel as JSON.", "A VisualPlan as JSON."],
  expectedOutput: [
    "A JSON object with these fields:",
    "- id: a stable snake_case id for the graph as a whole.",
    "- root: the id of the node standing for the whole diagram subject.",
    "- nodes: each with `id`, `kind` (object, component, label, connector, annotation),",
    "  `type` (the semantic type, e.g. `pulley` -- invent one if no standard type fits),",
    "  `category` (the domain grouping, e.g. `mechanical`), `role` (this node's job, e.g. `support`),",
    "  `anchors` (named attachment points other things can connect to, e.g. `rim`, `hook`),",
    "  `behaviors` (semantic motions it has, e.g. `rotate`), and `repeat` when a part genuinely",
    "  recurs a fixed number of times (e.g. twelve gear teeth).",
    "- edges: each `{ id, type, from, to }` where `type` is one of connectedTo, inside, above,",
    "  below, leftOf, rightOf, wraps, attachedTo, intersects, parallelTo, centeredOn, alignedWith,",
    "  contains, pointsTo.",
  ].join("\n"),
  forbiddenOutput: [
    ...NO_GEOMETRY,
    "Any node id in an edge that is not declared in `nodes`.",
    "Containment that loops: nothing can be inside something that is inside it.",
  ],
  completionRules: [
    "Answer with exactly one JSON object and nothing else.",
    "Reuse the plan's object ids as node ids wherever a node stands for a planned object.",
    "Every node except the root must appear in at least one edge, or it can never be positioned.",
    "Declare an anchor whenever something else attaches there. A connector with nowhere to land is a broken diagram.",
    "A single-object plan gets a single node and no edges. Do not invent structure to look thorough.",
  ],
  examples: [
    {
      note: "anchors are declared because the rope needs somewhere to land",
      input: JSON.stringify({
        intent: { subject: "movable pulley system", domain: "physics" },
        plan: {
          objects: [
            { id: "ceiling", name: "Ceiling", importance: "supporting" },
            { id: "fixed_pulley", name: "Fixed Pulley", importance: "primary" },
            { id: "load", name: "Load", importance: "primary" },
          ],
        },
      }),
      output: JSON.stringify(
        {
          id: "pulley_system",
          root: "pulley_system",
          nodes: [
            { id: "pulley_system", kind: "object", type: "pulley_system", category: "mechanical", role: "assembly", anchors: [], behaviors: [] },
            { id: "ceiling", kind: "component", type: "surface", category: "mechanical", role: "support", anchors: [{ name: "mount", description: "Where the fixed pulley hangs." }], behaviors: [] },
            { id: "fixed_pulley", kind: "component", type: "pulley", category: "mechanical", role: "redirect", anchors: [{ name: "axle" }, { name: "rim" }], behaviors: ["rotate"] },
            { id: "load", kind: "component", type: "mass", category: "mechanical", role: "load", anchors: [{ name: "hook" }], behaviors: ["lift"] },
          ],
          edges: [
            { id: "e1", type: "contains", from: "pulley_system", to: "ceiling" },
            { id: "e2", type: "attachedTo", from: "fixed_pulley", to: "ceiling" },
            { id: "e3", type: "below", from: "load", to: "fixed_pulley" },
          ],
        },
        null,
        2,
      ),
    },
  ],
});

export const PRIMITIVE_PROMPT = definePrompt({
  id: "shape-intelligence.primitive",
  version: 1,
  systemInstructions: [
    "You are SketchMind's Shape Intelligence Engine, reasoning about one object you have never",
    "drawn before. Work out what it is made of, well enough that it could be drawn from your",
    "description alone -- parts, attachment points, and how the parts relate.",
    "You reason about structure only.",
  ].join("\n"),
  objective: "Produce a reusable ShapeGraph for a single named object.",
  allowedInputs: ["The object's name.", "A short description of what it is."],
  expectedOutput:
    "A ShapeGraph JSON object, exactly as described for the shape-graph task: id, root, nodes, edges.",
  forbiddenOutput: [
    ...NO_GEOMETRY,
    "A graph for anything other than the single object you were asked about.",
  ],
  completionRules: [
    "Answer with exactly one JSON object and nothing else.",
    "The root node stands for the whole object; its parts are the other nodes.",
    "Name anchors after what they are for (`inlet`, `rim`, `hinge`), not after where they sit.",
    "If the object genuinely has no parts, return one node and no edges.",
  ],
  examples: [],
});

export const FREEFORM_PROMPT = definePrompt({
  id: "shape-intelligence.freeform",
  version: 1,
  systemInstructions: [
    "You are SketchMind's Shape Intelligence Engine, composing a shape that has no registered",
    "primitive (AD-5). You describe it as a small set of geometric parts -- lines, arcs, curves,",
    "circles, polygons -- laid out in the shape's OWN unit box.",
    "",
    "The unit box runs 0 to 1 in u and 0 to 1 in v, with (0,0) top-left. These are proportions",
    "INSIDE the shape, like an SVG viewBox. They say nothing about where the shape goes on the",
    "board or how large it is: the layout engine decides both, and will scale your shape without",
    "distorting it.",
  ].join("\n"),
  objective:
    "Compose a one-off FreeformShape from geometric sub-primitives, so an unregistered object can still be drawn.",
  allowedInputs: ["The shape's name.", "A short description of what it should look like."],
  expectedOutput: [
    "A JSON object with these fields:",
    "- id: a stable snake_case id.",
    "- name: the semantic name, e.g. `lightning-bolt`.",
    "- rationale: one sentence on why a new shape was needed.",
    "- parts: each with `id`, `kind` (line, polyline, curve, arc, circle, ellipse, rectangle,",
    "  polygon), `points` as `{ u, v }` control points in the order a pen would travel them,",
    "  `closed`, and `order` (ascending; this is the order a teacher would draw them).",
    "- anchors: each `{ name, at: { u, v } }`, for labels and connectors to attach to.",
    "- aspectRatio: the width:height the shape wants, e.g. 1 for square, 2 for twice as wide.",
  ].join("\n"),
  forbiddenOutput: [
    "Any u or v outside the range 0 to 1. These are proportions, not pixels.",
    "Any pixel, point, em, or absolute unit anywhere.",
    "Any SVG path string, canvas command, colour, or stroke width.",
    "Prose, explanation, or commentary outside the JSON object.",
  ],
  completionRules: [
    "Answer with exactly one JSON object and nothing else.",
    "Use the fewest parts that still read as the thing -- this is a sketch, not an illustration.",
    "Fill the unit box: the shape should span roughly 0 to 1 in its longer dimension.",
    "Order parts the way a person would draw them: outline first, detail after.",
  ],
  examples: [
    {
      note: "four parts, drawn outline-first, spanning the box",
      input: JSON.stringify({ name: "lightning-bolt", description: "A jagged downward bolt." }),
      output: JSON.stringify(
        {
          id: "lightning_bolt",
          name: "lightning-bolt",
          rationale: "No registered primitive exists for a lightning bolt.",
          parts: [
            {
              id: "outline",
              kind: "polygon",
              closed: true,
              order: 0,
              points: [
                { u: 0.55, v: 0 },
                { u: 0.2, v: 0.55 },
                { u: 0.45, v: 0.55 },
                { u: 0.35, v: 1 },
                { u: 0.8, v: 0.4 },
                { u: 0.5, v: 0.4 },
              ],
            },
          ],
          anchors: [
            { name: "tip", at: { u: 0.35, v: 1 } },
            { name: "top", at: { u: 0.55, v: 0 } },
          ],
          aspectRatio: 0.6,
        },
        null,
        2,
      ),
    },
  ],
});
