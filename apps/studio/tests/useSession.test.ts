import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { encodeServerEvent } from "@sketchmind/session-protocol";
import type { RuntimeEvent } from "@sketchmind/shared-types";
import { useSession } from "../src/hooks/useSession.js";

/**
 * Mirrors `App.test.tsx`'s `FakeEventSource` -- kept local rather than shared
 * because it is deliberately minimal (just enough to drive `useSession`
 * directly, with no rendered UI in between).
 */
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

const event = <T extends RuntimeEvent["type"]>(type: T, extra: object = {}): RuntimeEvent =>
  ({
    type,
    sessionId: "s1",
    at: "2026-08-06T00:00:00.000Z",
    ...(type === "SessionStarted" ? { visionEnabled: false } : {}),
    ...extra,
  }) as RuntimeEvent;

const FRAME = { timeMs: 99, completed: [], inProgress: null, pending: 0 };

beforeEach(() => {
  FakeEventSource.last = undefined;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ sessionId: "s1" }), { status: 202 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSession frame batching", () => {
  it("does not drop the last FrameUpdate when a terminal event follows in the same tick", async () => {
    const { result } = renderHook(() => useSession());

    await act(async () => {
      void result.current.start("draw a box");
    });
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    const stream = FakeEventSource.last!;

    act(() => {
      stream.deliver(event("SessionStarted"));
      stream.deliver(event("FrameUpdate", { frame: FRAME }));
      stream.deliver(event("SessionCompleted", { durationMs: 1 }));
    });

    // The FrameUpdate was still pending in a rAF when SessionCompleted
    // landed right behind it -- it must not be silently dropped by close(),
    // and applying it must not clobber the terminal "done" phase that
    // logically comes after it.
    expect(result.current.state.frame?.timeMs).toBe(99);
    expect(result.current.state.phase).toBe("done");
  });
});
