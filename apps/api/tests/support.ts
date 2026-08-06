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
