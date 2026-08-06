import { describe, it, expect } from "vitest";
import type { RuntimeEvent, Stroke } from "@sketchmind/shared-types";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  buildTimeline,
  createStrokeRuntime,
  type DrawingFrame,
  type StrokeRuntime,
  type StrokeRuntimeOptions,
} from "../src/index.js";

function unwrap<T>(result: { ok: boolean; value?: T; errors?: readonly unknown[] }): T {
  if (!result.ok) throw new Error(`expected ok, got: ${JSON.stringify(result.errors, null, 2)}`);
  return result.value as T;
}

function stroke(id: string, target: string, durationMs: number, pauseAfterMs = 0): Stroke {
  return {
    id,
    type: "line",
    target,
    order: 0,
    dependencies: [],
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    style: { width: 2, jitter: 0.1, pressureProfile: "taperBoth", ink: "pen", dashed: false },
    timing: { delayMs: 0, durationMs, pauseAfterMs },
  };
}

/**
 * Three strokes: 0-100, 100-300 (then a 50ms beat), 350-650. Total 650ms.
 * Small enough that every boundary in the tests below is arithmetic, not a guess.
 */
const AST = {
  version: "1.0" as const,
  diagramId: "rig",
  strokes: [stroke("a", "frame", 100), stroke("b", "wheel", 200, 50), stroke("c", "bolt", 300)],
};

function runtime(options: StrokeRuntimeOptions = {}): StrokeRuntime {
  return unwrap(createStrokeRuntime(structuredClone(AST), options));
}

describe("stroke-runtime package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/stroke-runtime");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});

describe("createStrokeRuntime", () => {
  it("validates at the boundary rather than failing deep inside playback", () => {
    const result = createStrokeRuntime({ version: "1.0", diagramId: "rig", strokes: [{ id: "" }] });
    expect(result.ok).toBe(false);
  });

  it("starts idle at time zero, and autoplays only when asked", () => {
    expect(runtime().state().status).toBe("idle");
    expect(runtime().state().timeMs).toBe(0);
    expect(runtime({ autoplay: true }).state().status).toBe("playing");
  });
});

describe("the timeline (Volume 06 §Stroke Timing)", () => {
  it("accumulates delay, duration, and the trailing pause", () => {
    const timeline = buildTimeline(AST.strokes);
    expect(timeline.entries.map((e) => [e.startMs, e.endMs])).toEqual([
      [0, 100],
      [100, 300],
      [350, 650],
    ]);
    expect(timeline.totalDurationMs).toBe(650);
  });
});

describe("progressive rendering (Volume 06 §Incremental Rendering)", () => {
  it("reports completed strokes, the one in flight, and how many are pending", () => {
    const r = runtime();

    const start = r.seek(0);
    expect(start.completed).toHaveLength(0);
    expect(start.inProgress?.stroke.id).toBe("a");
    expect(start.pending).toBe(2);

    const mid = r.seek(200);
    expect(mid.completed.map((s) => s.id)).toEqual(["a"]);
    expect(mid.inProgress?.stroke.id).toBe("b");
    expect(mid.inProgress?.progress).toBeCloseTo(0.5);
    expect(mid.pending).toBe(1);

    const gap = r.seek(320); // Inside the 50ms beat after `b`: nothing is in flight.
    expect(gap.completed.map((s) => s.id)).toEqual(["a", "b"]);
    expect(gap.inProgress).toBeNull();

    const end = r.seek(650);
    expect(end.completed).toHaveLength(3);
    expect(end.inProgress).toBeNull();
    expect(end.pending).toBe(0);
  });

  it("interpolates the pen's position along the path, not just to the last vertex", () => {
    const half = runtime().seek(50).inProgress!;
    expect(half.points).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ]);
  });
});

describe("transport (Volume 06 §Stroke Runtime)", () => {
  it("advances only while playing, so pause and resume mean what they say", () => {
    const r = runtime();

    r.advance(100);
    expect(r.state().timeMs).toBe(0); // idle

    r.play();
    r.advance(100);
    expect(r.state().timeMs).toBe(100);

    r.pause();
    r.advance(500);
    expect(r.state().timeMs).toBe(100);

    r.resume();
    r.advance(100);
    expect(r.state().timeMs).toBe(200);
  });

  it("scales advance by speed", () => {
    const r = runtime({ speed: 2 });
    r.play();
    r.advance(100);
    expect(r.state().timeMs).toBe(200);
  });

  it("completes at the end and replays from the start", () => {
    const r = runtime();
    r.play();
    r.advance(10_000);
    expect(r.state().status).toBe("completed");
    expect(r.state().timeMs).toBe(650);

    r.replay();
    expect(r.state().status).toBe("playing");
    expect(r.state().timeMs).toBe(0);
  });

  it("continues from a seek rather than rewinding it", () => {
    const r = runtime();
    r.seek(400);
    r.play();
    expect(r.state().timeMs).toBe(400);
  });

  it("seeks to a stroke's start, clamping out-of-range indices", () => {
    const r = runtime();
    expect(r.seekToStroke(2).timeMs).toBe(350);
    expect(r.seekToStroke(99).timeMs).toBe(350);
    expect(r.seekToStroke(-5).timeMs).toBe(0);
  });

  it("cancels into a state distinguishable from paused or completed", () => {
    const r = runtime();
    r.play();
    r.advance(100);
    r.cancel("user closed the tab");
    expect(r.state().status).toBe("cancelled");
    r.advance(1000);
    expect(r.state().timeMs).toBe(100);
  });

  it("is deterministic: two runtimes driven by the same tick script agree exactly", () => {
    const script: Array<(r: StrokeRuntime) => void> = [
      (r) => r.play(),
      (r) => void r.advance(37),
      (r) => void r.advance(120),
      (r) => r.pause(),
      (r) => void r.advance(500),
      (r) => r.resume(),
      (r) => void r.advance(90),
      (r) => r.setSpeed(2.5),
      (r) => void r.advance(60),
      (r) => void r.seek(410),
      (r) => r.replay(),
      (r) => void r.advance(200),
    ];

    const transcribe = (): string[] => {
      const r = runtime();
      const out: string[] = [];
      for (const step of script) {
        step(r);
        const frame: DrawingFrame = r.frame();
        out.push(
          JSON.stringify({
            state: r.state(),
            completed: frame.completed.map((s) => s.id),
            inProgress: frame.inProgress
              ? { id: frame.inProgress.stroke.id, points: frame.inProgress.points }
              : null,
          }),
        );
      }
      return out;
    };

    expect(transcribe()).toEqual(transcribe());
  });
});

describe("undo and redo (D-9)", () => {
  it("removes exactly the last stroke and restores it, leaving the rest untouched", () => {
    const r = runtime();
    const before = JSON.stringify(r.strokes());

    const removed = r.undo();
    expect(removed!.id).toBe("c");
    expect(r.strokes().map((s) => s.id)).toEqual(["a", "b"]);
    // No side effects: the surviving strokes are byte-identical.
    expect(JSON.stringify(r.strokes())).toBe(JSON.stringify(JSON.parse(before).slice(0, 2)));

    const restored = r.redo();
    expect(restored!.id).toBe("c");
    expect(JSON.stringify(r.strokes())).toBe(before);
  });

  it("shortens the timeline while a stroke is undone, and clamps the playhead", () => {
    const r = runtime();
    r.seek(650);
    r.undo();
    expect(r.state().totalDurationMs).toBe(350);
    expect(r.state().timeMs).toBe(350);
  });

  it("reports nothing to undo on an empty sequence, and nothing to redo before an undo", () => {
    const r = runtime();
    expect(r.canRedo()).toBe(false);
    expect(r.redo()).toBeUndefined();
    r.undo();
    r.undo();
    r.undo();
    expect(r.canUndo()).toBe(false);
    expect(r.undo()).toBeUndefined();
  });
});

describe("editing (Volume 06 §Editing)", () => {
  it("inserts, deletes, replaces, reorders, and moves -- renumbering the sequence each time", () => {
    const r = runtime();
    const extra = stroke("d", "rope", 400);

    r.insertStroke(extra, 1);
    expect(r.strokes().map((s) => s.id)).toEqual(["a", "d", "b", "c"]);
    expect(r.strokes().map((s) => s.order)).toEqual([0, 1, 2, 3]);
    expect(r.strokes()[2]!.dependencies).toEqual(["d"]);

    expect(r.reorderStroke("d", 3)).toBe(true);
    expect(r.strokes().map((s) => s.id)).toEqual(["a", "b", "c", "d"]);

    expect(r.replaceStroke("b", stroke("b", "wheel", 999))).toBe(true);
    expect(r.strokes()[1]!.timing.durationMs).toBe(999);

    expect(r.moveStroke("a", 5, -5)).toBe(true);
    expect(r.strokes()[0]!.points).toEqual([
      { x: 5, y: -5 },
      { x: 105, y: -5 },
    ]);

    expect(r.deleteStroke("d")).toBe(true);
    expect(r.strokes().map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("reports a miss instead of silently doing nothing", () => {
    const r = runtime();
    expect(r.deleteStroke("nope")).toBe(false);
    expect(r.moveStroke("nope", 1, 1)).toBe(false);
    expect(r.replaceStroke("nope", stroke("x", "x", 10))).toBe(false);
    expect(r.reorderStroke("nope", 0)).toBe(false);
  });

  it("clears the redo stack, because redoing into a changed sequence is not deterministic", () => {
    const r = runtime();
    r.undo();
    expect(r.canRedo()).toBe(true);
    r.insertStroke(stroke("d", "rope", 100));
    expect(r.canRedo()).toBe(false);
  });

  it("accepts streamed strokes without disturbing the playhead", () => {
    const r = runtime();
    r.play();
    r.advance(150);
    r.appendStrokes([stroke("d", "rope", 100)]);
    expect(r.state().timeMs).toBe(150);
    expect(r.state().totalDurationMs).toBe(750);
    expect(r.strokeAST().strokes.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("exports a Stroke AST whose total duration reflects the edits", () => {
    const r = runtime();
    r.undo();
    expect(r.strokeAST().totalDurationMs).toBe(350);
    expect(r.strokeAST().diagramId).toBe("rig");
  });
});

describe("events", () => {
  it("announces each stroke's start and completion exactly once per pass", () => {
    const events: RuntimeEvent[] = [];
    const r = runtime({ sessionId: "s1", now: () => "2026-08-05T00:00:00.000Z", onEvent: (e) => events.push(e) });

    r.play();
    r.advance(650);

    const kinds = events.map((e) => `${e.type}:${"strokeId" in e ? e.strokeId : ""}`);
    expect(kinds).toEqual([
      "StrokeStarted:a",
      "StrokeCompleted:a",
      "StrokeStarted:b",
      "StrokeCompleted:b",
      "StrokeStarted:c",
      "StrokeCompleted:c",
    ]);
    expect(events[0]!.sessionId).toBe("s1");
  });

  it("re-announces everything on replay, so a renderer can redraw from scratch", () => {
    const events: RuntimeEvent[] = [];
    const r = runtime({ onEvent: (e) => events.push(e) });
    r.play();
    r.advance(650);
    const first = events.length;

    r.replay();
    r.advance(650);
    expect(events.length).toBe(first * 2);
  });

  it("reports pause, resume, and cancellation", () => {
    const events: RuntimeEvent[] = [];
    const r = runtime({ onEvent: (e) => events.push(e) });
    r.play();
    r.advance(50);
    r.pause();
    r.resume();
    r.cancel("done");

    const types = events.map((e) => e.type);
    expect(types).toContain("PlaybackPaused");
    expect(types).toContain("PlaybackResumed");
    expect(types).toContain("SessionCancelled");
  });

  it("stops delivering to an unsubscribed listener", () => {
    const seen: RuntimeEvent[] = [];
    const r = runtime();
    const unsubscribe = r.subscribe((e) => seen.push(e));
    r.play();
    r.advance(100);
    const count = seen.length;
    unsubscribe();
    r.advance(500);
    expect(seen.length).toBe(count);
  });
});
