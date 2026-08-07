import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "@sketchmind/shared-types";
import { RUNTIME_EVENT_TYPES, decodeServerEvent, encodeServerEvent } from "../src/index.js";

const started: RuntimeEvent = {
  type: "SessionStarted",
  sessionId: "s1",
  at: "2026-08-06T00:00:00.000Z",
  userInput: "Draw a movable pulley",
  visionEnabled: false,
};

describe("SSE framing", () => {
  it("round-trips an event", () => {
    const result = decodeServerEvent(encodeServerEvent(started));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(started);
  });

  it("names the event type in the frame, so a browser can subscribe per type", () => {
    expect(encodeServerEvent(started).startsWith("event: SessionStarted\n")).toBe(true);
  });

  // A browser subscribes by iterating this list; a name missing from it is an
  // event the UI silently never receives, which is not visible as a failure
  // anywhere else.
  it("lists every event name a frame can carry", () => {
    expect(RUNTIME_EVENT_TYPES).toContain("FrameUpdate");
    expect(RUNTIME_EVENT_TYPES).toContain(started.type);
    expect(new Set(RUNTIME_EVENT_TYPES).size).toBe(RUNTIME_EVENT_TYPES.length);
  });

  it("terminates the frame with a blank line", () => {
    expect(encodeServerEvent(started).endsWith("\n\n")).toBe(true);
  });

  it("keeps a multi-line prompt on one data line, which SSE requires", () => {
    const frame = encodeServerEvent({ ...started, userInput: "line one\nline two" });
    const dataLines = frame.split("\n").filter((line) => line.startsWith("data:"));
    expect(dataLines).toHaveLength(1);

    const result = decodeServerEvent(frame);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.type !== "SessionStarted") throw new Error("wrong variant");
    expect(result.value.userInput).toBe("line one\nline two");
  });

  it("joins data lines a conforming peer chose to split", () => {
    const result = decodeServerEvent(
      'event: SessionStarted\ndata: {"type":"SessionStarted","sessionId":"s1",\ndata: "at":"t","userInput":"hi","visionEnabled":false}\n\n',
    );
    expect(result.ok).toBe(true);
  });

  it("round-trips a frame, the one event carrying geometry", () => {
    const frame: RuntimeEvent = {
      type: "FrameUpdate",
      sessionId: "s1",
      at: "t",
      frame: {
        timeMs: 400,
        completed: [],
        inProgress: {
          stroke: {
            id: "st1",
            type: "circle",
            target: "pulley",
            order: 0,
            dependencies: [],
            points: [{ x: 10, y: 20 }],
            style: { width: 2, jitter: 0.15, pressureProfile: "taperBoth", ink: "pen", dashed: false },
            timing: { delayMs: 0, durationMs: 400, pauseAfterMs: 0 },
          },
          progress: 0.5,
          points: [{ x: 10, y: 20 }],
        },
        pending: 3,
      },
    };

    const result = decodeServerEvent(encodeServerEvent(frame));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.type !== "FrameUpdate") throw new Error("wrong variant");
    // null survives the trip: it means "nothing mid-flight", not "field absent".
    expect(result.value.frame.inProgress?.progress).toBe(0.5);
  });

  it("preserves an explicit null through the round trip", () => {
    const frame: RuntimeEvent = {
      type: "FrameUpdate",
      sessionId: "s1",
      at: "t",
      frame: { timeMs: 0, completed: [], inProgress: null, pending: 2 },
    };
    const result = decodeServerEvent(encodeServerEvent(frame));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.type !== "FrameUpdate") throw new Error("wrong variant");
    expect(result.value.frame.inProgress).toBeNull();
  });

  it("rejects a frame with no data lines", () => {
    const result = decodeServerEvent(": keep-alive\n\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("PROTOCOL_EMPTY_FRAME");
  });

  it("rejects malformed JSON without throwing", () => {
    const result = decodeServerEvent("event: X\ndata: {not json\n\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("PROTOCOL_MALFORMED_JSON");
  });

  it("rejects well-formed JSON that is not a known event", () => {
    const result = decodeServerEvent('event: X\ndata: {"type":"Nope","sessionId":"s1","at":"t"}\n\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("SCHEMA_INVALID");
  });
});
