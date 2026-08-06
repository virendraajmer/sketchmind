import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { encodeServerEvent } from "@sketchmind/session-protocol";
import type { RuntimeEvent } from "@sketchmind/shared-types";
import { useSession } from "../src/hooks/useSession.js";

// Mocked at the `bootstrap.js` boundary -- one level above `agent-vision` --
// so tests below can (a) control exactly when `startVisionAgent`'s promise
// settles, for the deferred-close race, and (b) inspect the exact options
// object `useSession.ts` builds, which is the actual regression site for the
// missing-`apiBase` bug (round-2 finding #1): that bug lived in the call
// site inside `useSession.ts`, not inside `bootstrap.ts` or `agent-vision`,
// so asserting against real `runVisionAgent` calls one level down would miss
// it if `bootstrap.ts` ever grew its own default-`apiBase` fallback.
vi.mock("../src/vision/bootstrap.js", () => ({ startVisionAgent: vi.fn() }));

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
    ...(type === "SessionStarted" ? { visionEnabled: false, userInput: "draw a box" } : {}),
    ...extra,
  }) as RuntimeEvent;

const FRAME = { timeMs: 99, completed: [], inProgress: null, pending: 0 };

beforeEach(() => {
  vi.clearAllMocks();
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

describe("useSession deferred close (vision enabled)", () => {
  it("does not let a still-pending vision agent's deferred close tear down a later session's stream", async () => {
    const { startVisionAgent } = await import("../src/vision/bootstrap.js");
    let releaseVision: (() => void) | undefined;
    vi.mocked(startVisionAgent).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseVision = () => resolve();
        }),
    );

    const { result } = renderHook(() => useSession());

    // Session A: vision enabled. `SessionCompleted` defers close() until its
    // (still-pending, mocked) vision agent settles -- see round-2 finding #3.
    await act(async () => {
      void result.current.start("draw a box");
    });
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    const streamA = FakeEventSource.last!;

    act(() => {
      streamA.deliver(event("SessionStarted", { visionEnabled: true }));
      streamA.deliver(event("SessionCompleted", { durationMs: 1 }));
    });

    // Close is deferred -- the vision agent hasn't settled yet.
    expect(streamA.closed).toBe(false);

    // A new session starts before session A's vision agent settles. `start()`
    // closes A synchronously (correct) and points `source.current` at B's
    // fresh EventSource.
    await act(async () => {
      void result.current.start("draw a circle");
    });
    await waitFor(() => expect(FakeEventSource.last).not.toBe(streamA));
    const streamB = FakeEventSource.last!;
    expect(streamA.closed).toBe(true);
    expect(streamB.closed).toBe(false);

    // Session A's vision agent now settles. Its deferred close() must only
    // affect A's own (already-closed) stream -- not B's, which is still live.
    await act(async () => {
      releaseVision?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(streamB.closed).toBe(false);
  });

  it("passes the API's own base URL to startVisionAgent, not the studio's own origin", async () => {
    // Regression for round-2 finding #1: `useSession.ts` called
    // `startVisionAgent` without `apiBase` at all, which defaults to `""`
    // inside `bootstrap.ts` -- every request the vision agent makes would
    // then target the studio's own origin instead of the API server.
    // `bootstrap.test.ts` covers that `startVisionAgent` *honors* an
    // `apiBase` it's given; this drives a full session through
    // `useSession` to `SessionCompleted` with vision enabled and asserts
    // what `useSession.ts` actually passes at the call site -- the real bug
    // site. Reverting just the `apiBase: API,` line in `useSession.ts` makes
    // this test fail (`apiBase` would be `undefined`, not `API`).
    const { startVisionAgent } = await import("../src/vision/bootstrap.js");
    vi.mocked(startVisionAgent).mockResolvedValue(undefined);

    const { result } = renderHook(() => useSession());
    await act(async () => {
      void result.current.start("draw a box");
    });
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    const stream = FakeEventSource.last!;

    act(() => {
      stream.deliver(event("SessionStarted", { visionEnabled: true }));
      stream.deliver(event("SessionCompleted", { durationMs: 1 }));
    });

    await waitFor(() => expect(startVisionAgent).toHaveBeenCalledTimes(1));
    const options = vi.mocked(startVisionAgent).mock.calls[0]?.[0];
    expect(options?.apiBase).toBe("http://localhost:3001");
  });
});
