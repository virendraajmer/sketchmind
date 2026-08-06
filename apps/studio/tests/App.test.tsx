import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { encodeServerEvent } from "@sketchmind/session-protocol";
import type { RuntimeEvent } from "@sketchmind/shared-types";
import App from "../src/App";

vi.mock("../src/components/Whiteboard", () => ({
  default: () => <div data-testid="board" />,
}));

class FakeEventSource {
  static last: FakeEventSource | undefined;
  static readonly CLOSED = 2;

  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  deliver(event: RuntimeEvent): void {
    const data = encodeServerEvent(event)
      .split("\n")
      .find((line) => line.startsWith("data:"))!
      .slice("data:".length)
      .trim();
    this.onmessage?.(new MessageEvent("message", { data }));
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
): RuntimeEvent => ({ type, sessionId: "s1", at: "2026-08-06T00:00:00.000Z", ...extra }) as RuntimeEvent;

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
  render(<App />);
  await act(async () => {
    screen.getByRole("button", { name: "Draw" }).click();
  });
  await waitFor(() => expect(FakeEventSource.last).toBeDefined());
  return FakeEventSource.last!;
}

describe("studio app page", () => {
  it("renders the app title", () => {
    render(<App />);
    expect(screen.getByText("SketchMind")).toBeTruthy();
  });

  it("starts idle with nothing to show", () => {
    render(<App />);
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

  it("reports a network failure instead of hanging on 'Thinking'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    render(<App />);
    await act(async () => {
      screen.getByRole("button", { name: "Draw" }).click();
    });

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Failed");
    });
    expect(screen.getByRole("alert").textContent).toContain("Could not reach the server");
  });

  it("surfaces a non-OK response from the session endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    render(<App />);
    await act(async () => {
      screen.getByRole("button", { name: "Draw" }).click();
    });

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Failed");
    });
    expect(screen.getByRole("alert").textContent).toContain("503");
  });

  it("disables Draw while a session is running, and Cancel while it is not", async () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);

    await act(async () => {
      screen.getByRole("button", { name: "Draw" }).click();
    });
    expect(screen.getByRole("button", { name: "Draw" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", false);
  });
});
