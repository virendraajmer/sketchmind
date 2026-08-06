/**
 * A server wired for tests: no network, no credentials, no disk.
 *
 * The provider is a `FakeProvider` driven by a canned tool-call queue, so the
 * agent walks the real pipeline -- compose, constraints, layout, strokes -- with
 * the real tools and the real runtime, and only the model is simulated. That is
 * the point: everything under test here is the wiring, and wiring is exactly
 * what a mocked pipeline would hide.
 */
import { FakeProvider, type ToolCall } from "@sketchmind/llm-provider";
import { InMemoryStore } from "@sketchmind/agent-memory";
import { buildServer, type SketchMindServer } from "../src/server.js";
import { loadConfig, type ApiConfig } from "../src/config.js";

export const PULLEY_AST = {
  id: "pulley_system",
  subject: "movable pulley",
  title: "Movable Pulley",
  category: "schematic",
  objects: [
    {
      id: "pulley",
      type: "pulley",
      name: "Pulley",
      category: "mechanical",
      anchors: [{ name: "rim" }],
      behaviors: ["rotate"],
      labels: [{ id: "l1", text: "Pulley" }],
      children: [],
    },
    {
      id: "load",
      type: "mass",
      name: "Load",
      category: "mechanical",
      anchors: [{ name: "top" }],
      behaviors: [],
      labels: [],
      children: [],
    },
  ],
  relationships: [{ id: "r1", type: "attachedTo", from: "load", to: "pulley" }],
  groups: [],
  annotations: [],
};

/**
 * Two containers the real solver will not pull apart, sized so neither fully
 * contains the other -- `agent-vision`'s overlap check exempts pure
 * containment (Phase 6's `intersects` case, e.g. one circle drawn inside
 * another on purpose), so two nodes of *equal* size stacked exactly on top of
 * each other do not count. `p` stacks its two children vertically (`below`),
 * making it narrow and tall (188x260); `q` lays its two children side by side
 * (`leftOf`), making it wide and short (360x138). `centeredOn` puts them at
 * the same center -- `hierarchical.ts`'s `applyCenteredOn` -- and `intersects`
 * is the one relationship `constraint-engine` turns into a collision-
 * resolution exemption rather than a spatial constraint, so `solve_layout`
 * leaves the cross-shaped overlap in place instead of correcting it apart.
 * Verified against the real `deriveConstraintGraph` + `solveLayout` (not
 * just asserted): `p` ends up at `{x:126,y:40,w:188,h:260}`, `q` at
 * `{x:40,y:40,w:360,h:138}` -- they overlap, and neither contains the other.
 * This is what lets a test drive the real pipeline into a geometric
 * violation rather than asserting against a hand-built `LayoutModel`.
 */
export const OVERLAPPING_BOXES_AST = {
  id: "overlap_diagram",
  subject: "two overlapping containers",
  title: "Two Overlapping Containers",
  category: "schematic",
  objects: [
    {
      id: "p",
      type: "shape",
      name: "P",
      category: "mechanical",
      anchors: [],
      behaviors: [],
      labels: [],
      children: [
        { id: "c1", type: "shape", name: "C1", category: "mechanical", anchors: [], behaviors: [], labels: [], children: [] },
        { id: "c2", type: "shape", name: "C2", category: "mechanical", anchors: [], behaviors: [], labels: [], children: [] },
      ],
    },
    {
      id: "q",
      type: "shape",
      name: "Q",
      category: "mechanical",
      anchors: [],
      behaviors: [],
      labels: [],
      children: [
        { id: "c3", type: "shape", name: "C3", category: "mechanical", anchors: [], behaviors: [], labels: [], children: [] },
        { id: "c4", type: "shape", name: "C4", category: "mechanical", anchors: [], behaviors: [], labels: [], children: [] },
      ],
    },
  ],
  relationships: [
    { id: "r0", type: "below", from: "c1", to: "c2" },
    { id: "r1", type: "leftOf", from: "c3", to: "c4" },
    { id: "r2", type: "centeredOn", from: "p", to: "q" },
    { id: "r3", type: "intersects", from: "p", to: "q" },
  ],
  groups: [],
  annotations: [],
};

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall[] {
  return [{ id, name, arguments: args }];
}

/**
 * The happy path: four tool calls, then prose.
 *
 * The final `[]` matters -- the fake repeats its last queue entry, and an empty
 * batch is how the model says "I am done", which is what ends the agent loop.
 */
export const DRAWS_A_PULLEY: readonly (readonly ToolCall[])[] = [
  call("c1", "compose_diagram_ast", { request: "Draw a movable pulley" }),
  call("c2", "derive_constraints"),
  call("c3", "solve_layout"),
  call("c4", "plan_strokes"),
  [],
];

/** Never plans strokes: the model answers in prose straight away. */
export const DRAWS_NOTHING: readonly (readonly ToolCall[])[] = [[]];

/**
 * Draws `OVERLAPPING_BOXES_AST` through the same four real tool calls
 * `DRAWS_A_PULLEY` uses. Unlike the pulley, the solved layout this produces
 * has a genuine `overlap` finding, so the automatic critique pass in
 * `run.ts` has something real to catch and repair.
 */
export const DRAWS_OVERLAPPING_BOXES: readonly (readonly ToolCall[])[] = [
  call("c1", "compose_diagram_ast", { request: "Draw two overlapping boxes" }),
  call("c2", "derive_constraints"),
  call("c3", "solve_layout"),
  call("c4", "plan_strokes"),
  [],
];

/**
 * One responder for every text completion.
 *
 * `completeWithTools` calls `complete` internally for its text, and
 * `compose_diagram_ast` makes a structured call that must parse as an AST. A
 * single responder returning the AST satisfies both: the tool call gets a valid
 * artifact, and the loop gets some assistant text.
 */
export function pulleyProvider(
  toolCalls: readonly (readonly ToolCall[])[] = DRAWS_A_PULLEY,
): FakeProvider {
  return new FakeProvider({
    id: "fake",
    responses: [() => JSON.stringify(PULLEY_AST)],
    toolCalls,
  });
}

/** Same shape as `pulleyProvider`, composing `OVERLAPPING_BOXES_AST` instead. */
export function overlappingBoxesProvider(
  toolCalls: readonly (readonly ToolCall[])[] = DRAWS_OVERLAPPING_BOXES,
): FakeProvider {
  return new FakeProvider({
    id: "fake",
    responses: [() => JSON.stringify(OVERLAPPING_BOXES_AST)],
    toolCalls,
  });
}

export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    ...loadConfig({}),
    // Playback advances in large steps so a test finishes a drawing in a few
    // ticks rather than a few hundred. The runtime owns no timers, so this
    // changes nothing about what is drawn -- only how coarsely it is sampled.
    tickMs: 500,
    ...overrides,
  };
}

export interface TestServer extends SketchMindServer {
  readonly provider: FakeProvider;
}

export async function testServer(
  toolCalls: readonly (readonly ToolCall[])[] = DRAWS_A_PULLEY,
  config: Partial<ApiConfig> = {},
): Promise<TestServer> {
  const provider = pulleyProvider(toolCalls);
  const built = await buildServer({
    provider,
    store: new InMemoryStore(),
    config: testConfig(config),
    logger: false,
  });
  return { ...built, provider };
}
