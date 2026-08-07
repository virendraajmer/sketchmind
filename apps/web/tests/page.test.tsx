/**
 * The page, driven by a fake SSE stream.
 *
 * `EventSource` and `fetch` are stubbed so a test can deliver an exact sequence
 * of events and assert what the three panels do with it. The canvas is mocked
 * out: Konva draws pixels, which is `renderer-konva`'s business and is already
 * tested against decoded PNG bytes -- what matters here is that the page routes
 * each event to the right panel.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { encodeServerEvent } from "@sketchmind/session-protocol";
import type { RuntimeEvent } from "@sketchmind/shared-types";
import Page from "../app/page";

vi.mock("../app/Whiteboard", () => ({
  default: () => <div data-testid="board" />,
}));

class FakeEventSource {
  static last: FakeEventSource | undefined;
  static readonly CLOSED = 2;

  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, handler: (event: MessageEvent<string>) => void): void {
    const registered = this.listeners.get(type) ?? new Set();
    registered.add(handler);
    this.listeners.set(type, registered);
  }

  removeEventListener(type: string, handler: (event: MessageEvent<string>) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /**
   * Deliver an event the way the browser would: a frame carrying `event:`
   * reaches only listeners registered for that name, never `onmessage`.
   */
  deliver(event: RuntimeEvent): void {
    const lines = encodeServerEvent(event).split("\n");
    const name = lines
      .find((line) => line.startsWith("event:"))
      ?.slice("event:".length)
      .trim();
    const data = lines
      .find((line) => line.startsWith("data:"))!
      .slice("data:".length)
      .trim();
    const message = new MessageEvent(name ?? "message", { data });

    if (name === undefined) {
      this.onmessage?.(message);
      return;
    }
    for (const handler of this.listeners.get(name) ?? []) handler(message);
  }
}

const AST = {
  id: "pulley_system",
  version: "1.0",
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
      behaviors: [],
      labels: [{ id: "l1", text: "Pulley" }],
      children: [],
    },
  ],
  relationships: [],
  groups: [],
  annotations: [],
  metadata: { tags: [] },
} as unknown as Extract<RuntimeEvent, { type: "DiagramASTReady" }>["ast"];

const event = <T extends RuntimeEvent["type"]>(
  type: T,
  extra: object = {},
): RuntimeEvent =>
  ({
    type,
    sessionId: "s1",
    at: "2026-08-06T00:00:00.000Z",
    ...(type === "SessionStarted" ? { visionEnabled: false } : {}),
    ...extra,
  }) as RuntimeEvent;

// vitest runs with `globals: false`, so Testing Library's automatic cleanup
// never registers itself and each render would stack another page in the DOM.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  FakeEventSource.last = undefined;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ sessionId: "s1" }), { status: 202 })),
  );
});

async function startDrawing(): Promise<FakeEventSource> {
  render(<Page />);
  await act(async () => {
    screen.getByRole("button", { name: "Draw" }).click();
  });
  await waitFor(() => expect(FakeEventSource.last).toBeDefined());
  return FakeEventSource.last!;
}

describe("web home page", () => {
  it("renders the app title", () => {
    render(<Page />);
    expect(screen.getByText("SketchMind")).toBeTruthy();
  });

  it("starts idle with nothing to show", () => {
    render(<Page />);
    expect(screen.getByRole("status").textContent).toContain("Ready");
    expect(screen.getByText("No steps yet.")).toBeTruthy();
    expect(screen.getByText("No diagram yet.")).toBeTruthy();
  });

  it("opens a stream for the session the server minted", async () => {
    const stream = await startDrawing();
    expect(stream.url).toContain("/api/sessions/s1/stream");
    expect(screen.getByRole("status").textContent).toContain("Thinking");
  });

  it("shows each agent step with its tool and cost as it arrives", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "Draw a movable pulley" }));
      stream.deliver(
        event("AgentStep", {
          stepId: "s1-1",
          locus: "server",
          toolName: "compose_diagram_ast",
          durationMs: 812,
          tokensIn: 120,
          tokensOut: 40,
        }),
      );
    });

    expect(screen.getByText("compose_diagram_ast")).toBeTruthy();
    expect(screen.getByText(/812ms/)).toBeTruthy();
    expect(screen.getByText(/120\/40 tok/)).toBeTruthy();
  });

  it("shows a failed step's error rather than swallowing it", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
      stream.deliver(
        event("AgentStep", {
          stepId: "s1-1",
          locus: "server",
          toolName: "solve_layout",
          error: {
            code: "GEOMETRY_MISSING_INPUT",
            message: "No constraint graph yet.",
            package: "@sketchmind/agent-tools-geometry",
            stage: "layout",
            recoverable: true,
          },
        }),
      );
    });

    expect(screen.getByText(/GEOMETRY_MISSING_INPUT/)).toBeTruthy();
  });

  it("fills the inspector as soon as the diagram exists", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
      stream.deliver(event("DiagramASTReady", { ast: AST }));
    });

    expect(screen.getByText("Movable Pulley")).toBeTruthy();
    expect(screen.getByText("Pulley")).toBeTruthy();
    expect(screen.queryByText("No diagram yet.")).toBeNull();
  });

  it("counts strokes as they complete", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
      stream.deliver(event("StrokeCompleted", { strokeId: "st1" }));
      stream.deliver(event("StrokeCompleted", { strokeId: "st2" }));
    });

    expect(screen.getByRole("status").textContent).toContain("2 strokes");
  });

  it("closes the stream once the session ends", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
      stream.deliver(event("SessionCompleted", { durationMs: 4200 }));
    });

    expect(screen.getByRole("status").textContent).toContain("Done");
    expect(stream.closed).toBe(true);
  });

  it("surfaces a failure with the server's own reason", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
      stream.deliver(
        event("SessionFailed", {
          error: {
            code: "SESSION_NO_STROKES",
            message: "The agent finished without planning any strokes.",
            package: "@sketchmind/api",
            stage: "stroke",
            recoverable: true,
          },
        }),
      );
    });

    expect(screen.getByText(/without planning any strokes/)).toBeTruthy();
  });

  it("ignores a frame that is not a valid event, rather than rendering garbage", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
      stream.onmessage?.(new MessageEvent("message", { data: '{"type":"Nope"}' }));
    });

    // Still thinking: the bad frame changed nothing and threw nothing.
    expect(screen.getByRole("status").textContent).toContain("Thinking");
  });

  it("cancels the session the server told it about", async () => {
    const stream = await startDrawing();
    await act(async () => {
      stream.deliver(event("SessionStarted", { userInput: "x" }));
    });

    await act(async () => {
      screen.getByRole("button", { name: "Cancel" }).click();
    });

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.at(-1)?.[0]).toContain("/api/sessions/s1/cancel");
  });

  it("disables Draw while a session is running, and Cancel while it is not", async () => {
    render(<Page />);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);

    await act(async () => {
      screen.getByRole("button", { name: "Draw" }).click();
    });
    expect(screen.getByRole("button", { name: "Draw" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", false);
  });
});
