import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "@sketchmind/session-protocol";
import { SessionManager } from "../src/session/manager.js";

const event = (type: RuntimeEvent["type"], extra: object = {}): RuntimeEvent =>
  ({ type, sessionId: "s1", at: "t", ...extra }) as RuntimeEvent;

const started = event("SessionStarted", { userInput: "hi" });
const completed = event("SessionCompleted", { durationMs: 1 });

describe("SessionManager", () => {
  it("replays what a late subscriber missed", () => {
    const manager = new SessionManager();
    manager.create("s1");
    manager.emit("s1", started);

    const seen: RuntimeEvent[] = [];
    manager.subscribe("s1", (e) => seen.push(e));

    // The whole reason events are retained: starting a session and opening its
    // stream are two requests, and the agent does not wait for the second.
    expect(seen.map((e) => e.type)).toEqual(["SessionStarted"]);
  });

  it("then follows live", () => {
    const manager = new SessionManager();
    manager.create("s1");
    const seen: RuntimeEvent[] = [];
    manager.subscribe("s1", (e) => seen.push(e));

    manager.emit("s1", started);
    manager.emit("s1", completed);
    expect(seen.map((e) => e.type)).toEqual(["SessionStarted", "SessionCompleted"]);
  });

  it("fans out to every subscriber", () => {
    const manager = new SessionManager();
    manager.create("s1");
    const a: string[] = [];
    const b: string[] = [];
    manager.subscribe("s1", (e) => a.push(e.type));
    manager.subscribe("s1", (e) => b.push(e.type));

    manager.emit("s1", started);
    expect(a).toEqual(["SessionStarted"]);
    expect(b).toEqual(["SessionStarted"]);
  });

  it("keeps delivering when one subscriber's socket has died", () => {
    const manager = new SessionManager();
    manager.create("s1");
    const alive: string[] = [];
    manager.subscribe("s1", () => {
      throw new Error("EPIPE");
    });
    manager.subscribe("s1", (e) => alive.push(e.type));

    manager.emit("s1", started);
    expect(alive).toEqual(["SessionStarted"]);
  });

  it("replays a finished session and still follows it", () => {
    const manager = new SessionManager();
    manager.create("s1");
    manager.emit("s1", started);
    manager.emit("s1", completed);

    const seen: string[] = [];
    manager.subscribe("s1", (e) => seen.push(e.type));
    expect(seen).toEqual(["SessionStarted", "SessionCompleted"]);
    expect(manager.get("s1")?.listeners.size).toBe(1);

    // A terminal event ends the run, not the session's event stream: a repair
    // turn from `POST /findings` emits after it, and a subscriber that was
    // dropped at `finished` would never see it.
    manager.emit("s1", event("VisionCritique", { tier: "visual", findings: [], accepted: true }));
    expect(seen).toEqual(["SessionStarted", "SessionCompleted", "VisionCritique"]);
  });

  it("aborts the run when cancelled", () => {
    const manager = new SessionManager();
    const record = manager.create("s1");
    expect(manager.cancel("s1")).toBe(true);
    expect(record.controller.signal.aborted).toBe(true);
  });

  it("refuses to cancel a session that has already ended", () => {
    const manager = new SessionManager();
    const record = manager.create("s1");
    manager.emit("s1", completed);
    expect(manager.cancel("s1")).toBe(false);
    expect(record.controller.signal.aborted).toBe(false);
  });

  it("ignores events for a session it does not have", () => {
    const manager = new SessionManager();
    expect(() => manager.emit("nope", started)).not.toThrow();
    expect(manager.subscribe("nope", () => {})).toBeTypeOf("function");
  });

  it("aborts every live run on shutdown, and leaves finished ones alone", () => {
    const manager = new SessionManager();
    const live = manager.create("live");
    const done = manager.create("done");
    manager.emit("done", completed);

    manager.cancelAll();
    expect(live.controller.signal.aborted).toBe(true);
    expect(done.controller.signal.aborted).toBe(false);
  });
});
