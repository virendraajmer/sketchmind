/**
 * The playback runtime (Volume 06 §Stroke Runtime): play, pause, resume, seek,
 * replay, undo, redo, cancel, plus the editing API -- all over a Stroke AST, all
 * independent of any renderer.
 *
 * **The runtime owns no timers** (D-8). It is a pure function of (strokes,
 * timeMs) driven by `advance(deltaMs)`, which the caller pumps from
 * `requestAnimationFrame`, a server tick, or a fixed step in a test. That is
 * what makes "play, pause mid-sequence, resume, replay are deterministic across
 * runs" an assertion rather than an aspiration, and it keeps a `core`-layer
 * package from assuming a browser exists.
 *
 * `play`/`pause`/`resume` therefore set status and gate whether `advance` moves
 * the clock; they do not start anything. `seek`, `replay` and scrubbing are all
 * the same assignment to `timeMs`, which is why seeking backwards costs nothing.
 */
import type { Point, PlaybackState, RuntimeEvent, Stroke, StrokeAST } from "@sketchmind/shared-types";
import { partialPath, translate } from "./interpolate.js";
import { buildTimeline, completedCount, entryAt, type Timeline } from "./timeline.js";

export const PACKAGE = "@sketchmind/stroke-runtime";

export type PlaybackStatus = PlaybackState["status"];

export interface StrokeRuntimeState {
  readonly status: PlaybackStatus;
  /** Playhead, in timeline milliseconds at 1x. */
  readonly timeMs: number;
  readonly speed: number;
  /** Index of the next stroke to start; equals `strokeCount` once finished. */
  readonly cursor: number;
  readonly strokeCount: number;
  readonly totalDurationMs: number;
}

/** What a progressive renderer needs, and nothing else (Volume 06 §Incremental Rendering). */
export interface DrawingFrame {
  readonly timeMs: number;
  /** Strokes to draw in full, in drawing order. */
  readonly completed: readonly Stroke[];
  /** The stroke mid-flight, with the pen path traversed so far. */
  readonly inProgress: { readonly stroke: Stroke; readonly progress: number; readonly points: readonly Point[] } | null;
  /** Strokes not yet started. A count, not the strokes: a renderer must not draw them. */
  readonly pending: number;
}

export interface StrokeRuntimeOptions {
  /** Stamped onto emitted `RuntimeEvent`s. Phase 9 supplies the real session id. */
  readonly sessionId?: string;
  readonly speed?: number;
  /** Start in `playing` rather than `idle`. Default false. */
  readonly autoplay?: boolean;
  /** Timestamp source for events; injectable so event streams can be made deterministic. */
  readonly now?: () => string;
  readonly onEvent?: (event: RuntimeEvent) => void;
}

/** Where a stroke may be inserted or moved to. */
export type StrokeIndex = number;

/**
 * A `RuntimeEvent` minus the fields the runtime fills in. Written with a
 * conditional so it *distributes* over the union -- a bare
 * `Omit<RuntimeEvent, ...>` would collapse to the members' common keys and
 * throw away `strokeId`, `cursor`, and the rest.
 */
type EventBody = RuntimeEvent extends infer T ? (T extends object ? Omit<T, "sessionId" | "at"> : never) : never;

function resequence(strokes: readonly Stroke[]): Stroke[] {
  return strokes.map((stroke, index) => ({
    ...stroke,
    order: index,
    dependencies: index === 0 ? [] : [strokes[index - 1]!.id],
  }));
}

export class StrokeRuntime {
  #strokes: Stroke[];
  #timeline: Timeline;
  #status: PlaybackStatus;
  #timeMs = 0;
  #speed: number;
  #redoStack: Stroke[] = [];
  #listeners = new Set<(event: RuntimeEvent) => void>();

  readonly #source: StrokeAST;
  readonly #sessionId: string;
  readonly #now: () => string;

  /** Ids already announced, so a diff can emit each transition exactly once. */
  #started = new Set<string>();
  #completed = new Set<string>();

  constructor(ast: StrokeAST, options: StrokeRuntimeOptions = {}) {
    this.#source = ast;
    this.#strokes = resequence(ast.strokes);
    this.#timeline = buildTimeline(this.#strokes);
    this.#speed = options.speed ?? 1;
    this.#status = options.autoplay === true ? "playing" : "idle";
    this.#sessionId = options.sessionId ?? "local";
    this.#now = options.now ?? (() => new Date().toISOString());
    if (options.onEvent) this.#listeners.add(options.onEvent);
  }

  // ---------------------------------------------------------------- inspection

  strokes(): readonly Stroke[] {
    return this.#strokes;
  }

  /** The current sequence as a Stroke AST -- edits included, timings recomputed. */
  strokeAST(): StrokeAST {
    return {
      ...this.#source,
      strokes: this.#strokes,
      totalDurationMs: this.#timeline.totalDurationMs,
    };
  }

  timeline(): Timeline {
    return this.#timeline;
  }

  state(): StrokeRuntimeState {
    return {
      status: this.#status,
      timeMs: this.#timeMs,
      speed: this.#speed,
      cursor: completedCount(this.#timeline, this.#timeMs),
      strokeCount: this.#strokes.length,
      totalDurationMs: this.#timeline.totalDurationMs,
    };
  }

  /** The `shared-types` view of the same state, for the wire (Volume 16). */
  playbackState(): PlaybackState {
    return { status: this.#status, cursor: this.state().cursor, speed: this.#speed };
  }

  frame(): DrawingFrame {
    const done = completedCount(this.#timeline, this.#timeMs);
    const entry = entryAt(this.#timeline, this.#timeMs);
    const completed = this.#strokes.slice(0, done);

    if (!entry) {
      return { timeMs: this.#timeMs, completed, inProgress: null, pending: this.#strokes.length - done };
    }

    const stroke = this.#strokes[entry.index]!;
    const span = entry.endMs - entry.startMs;
    const progress = span <= 0 ? 1 : Math.min(1, Math.max(0, (this.#timeMs - entry.startMs) / span));
    return {
      timeMs: this.#timeMs,
      completed,
      inProgress: { stroke, progress, points: partialPath(stroke.points, progress) },
      // The in-progress stroke is neither completed nor pending.
      pending: this.#strokes.length - done - 1,
    };
  }

  // ----------------------------------------------------------------- transport

  play(): void {
    // Playing from the end means "again"; playing from anywhere else means
    // "continue from here", so a seek followed by play does not lose the seek.
    if (this.#status === "cancelled" || this.#timeMs >= this.#timeline.totalDurationMs) this.#setTime(0);
    this.#status = "playing";
    this.#syncStatus();
  }

  pause(): void {
    if (this.#status !== "playing") return;
    this.#status = "paused";
    this.#emit({ type: "PlaybackPaused", cursor: this.state().cursor });
  }

  resume(): void {
    if (this.#status !== "paused") return;
    this.#status = "playing";
    this.#emit({ type: "PlaybackResumed", cursor: this.state().cursor });
  }

  /** Rewind to the start and play. Identical to `seek(0)` then `play()`. */
  replay(): void {
    this.#setTime(0);
    this.#status = "playing";
    this.#syncStatus();
  }

  cancel(reason?: string): void {
    if (this.#status === "cancelled") return;
    this.#status = "cancelled";
    this.#emit({ type: "SessionCancelled", ...(reason === undefined ? {} : { reason }) });
  }

  setSpeed(speed: number): void {
    // Non-positive speed would stall or reverse time, which `seek` already does
    // properly. Clamping keeps the timeline monotonic under `advance`.
    this.#speed = Math.max(0.01, speed);
  }

  seek(timeMs: number): DrawingFrame {
    this.#setTime(timeMs);
    this.#syncStatus();
    return this.frame();
  }

  /** Seek to the moment stroke `index` begins. Out-of-range clamps to the ends. */
  seekToStroke(index: StrokeIndex): DrawingFrame {
    if (this.#timeline.entries.length === 0) return this.seek(0);
    const clamped = Math.min(Math.max(0, Math.trunc(index)), this.#timeline.entries.length - 1);
    return this.seek(this.#timeline.entries[clamped]!.startMs);
  }

  /**
   * Advance the playhead by `deltaMs` of wall time, scaled by `speed`. A no-op
   * unless playing -- so a caller may pump this every frame unconditionally and
   * let pause do its job.
   */
  advance(deltaMs: number): DrawingFrame {
    if (this.#status !== "playing" || deltaMs <= 0) return this.frame();
    this.#setTime(this.#timeMs + deltaMs * this.#speed);
    this.#syncStatus();
    return this.frame();
  }

  // ---------------------------------------------------------------- undo / redo

  canUndo(): boolean {
    return this.#strokes.length > 0;
  }

  canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  /**
   * Remove the last stroke of the sequence (D-9: undo is a whiteboard eraser,
   * not an editor's command history). Every other stroke is left byte-identical
   * -- resequencing only ever touches trailing indices, and the removed stroke
   * was the trailing one.
   */
  undo(): Stroke | undefined {
    const removed = this.#strokes[this.#strokes.length - 1];
    if (!removed) return undefined;
    this.#strokes = this.#strokes.slice(0, -1);
    this.#redoStack.push(removed);
    this.#rebuild();
    return removed;
  }

  redo(): Stroke | undefined {
    const restored = this.#redoStack.pop();
    if (!restored) return undefined;
    this.#strokes = resequence([...this.#strokes, restored]);
    this.#rebuild();
    return restored;
  }

  // ------------------------------------------------------------------- editing

  /**
   * Volume 06 §Editing. Each of these clears the redo stack, as any editor does
   * when you act after undoing -- a redo into a sequence that has since changed
   * underneath it would not be deterministic, which §Editing explicitly requires.
   */
  insertStroke(stroke: Stroke, at?: StrokeIndex): void {
    const index = at === undefined ? this.#strokes.length : this.#clampIndex(at);
    const next = [...this.#strokes];
    next.splice(index, 0, stroke);
    this.#commit(next);
  }

  deleteStroke(id: string): boolean {
    const next = this.#strokes.filter((stroke) => stroke.id !== id);
    if (next.length === this.#strokes.length) return false;
    this.#commit(next);
    return true;
  }

  /** Translate a stroke's geometry. Distinct from `reorderStroke`, per Volume 06. */
  moveStroke(id: string, dx: number, dy: number): boolean {
    let found = false;
    const next = this.#strokes.map((stroke) => {
      if (stroke.id !== id) return stroke;
      found = true;
      return { ...stroke, points: translate(stroke.points, dx, dy) };
    });
    if (!found) return false;
    this.#commit(next);
    return true;
  }

  replaceStroke(id: string, replacement: Stroke): boolean {
    const index = this.#strokes.findIndex((stroke) => stroke.id === id);
    if (index === -1) return false;
    const next = [...this.#strokes];
    next[index] = replacement;
    this.#commit(next);
    return true;
  }

  /** Change a stroke's position in the drawing sequence, leaving its geometry alone. */
  reorderStroke(id: string, to: StrokeIndex): boolean {
    const from = this.#strokes.findIndex((stroke) => stroke.id === id);
    if (from === -1) return false;
    const next = [...this.#strokes];
    const [moved] = next.splice(from, 1);
    next.splice(this.#clampIndex(to), 0, moved!);
    this.#commit(next);
    return true;
  }

  /**
   * Append strokes as they arrive (Volume 06 §Incremental Rendering: "streaming
   * strokes"). Playback continues undisturbed -- the timeline simply grows past
   * where the playhead is, which is what makes an agent's diagram appear as it
   * is being reasoned about.
   */
  appendStrokes(strokes: readonly Stroke[]): void {
    if (strokes.length === 0) return;
    this.#commit([...this.#strokes, ...strokes]);
  }

  // -------------------------------------------------------------------- events

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ------------------------------------------------------------------ internals

  #clampIndex(index: StrokeIndex): number {
    return Math.min(Math.max(0, Math.trunc(index)), this.#strokes.length);
  }

  #commit(strokes: readonly Stroke[]): void {
    this.#strokes = resequence(strokes);
    this.#redoStack = [];
    this.#rebuild();
  }

  #rebuild(): void {
    this.#timeline = buildTimeline(this.#strokes);
    // Keep the playhead inside the sequence it now describes.
    this.#setTime(this.#timeMs);
    this.#syncStatus();
  }

  #setTime(timeMs: number): void {
    this.#timeMs = Math.min(Math.max(0, timeMs), this.#timeline.totalDurationMs);
    this.#announce();
  }

  /**
   * The one automatic transition: `playing` becomes `completed` on reaching the
   * end. Nothing else changes status behind the caller's back -- a cancelled
   * runtime stays cancelled, and seeking back from `completed` stays completed
   * until something calls `play`.
   */
  #syncStatus(): void {
    if (this.#status === "playing" && this.#timeMs >= this.#timeline.totalDurationMs) {
      this.#status = "completed";
    }
  }

  /**
   * Emit a start/complete event for each stroke that crossed a boundary since
   * the last time change. Seeking backwards drops ids from the announced sets
   * rather than emitting anything, so a replay re-announces every stroke -- which
   * is what a progressive renderer needs in order to redraw from scratch.
   */
  #announce(): void {
    const nowStarted = new Set<string>();
    const nowCompleted = new Set<string>();
    for (const entry of this.#timeline.entries) {
      if (this.#timeMs >= entry.startMs) nowStarted.add(entry.strokeId);
      if (this.#timeMs >= entry.endMs) nowCompleted.add(entry.strokeId);
    }

    // A shrinking set means the playhead went backwards (a seek, a replay, an
    // undo). Forget what was announced so the whole pass is announced again --
    // a renderer redrawing from scratch needs the start of stroke one, even
    // though stroke one was "already started" a moment ago.
    const rewound =
      [...this.#started].some((id) => !nowStarted.has(id)) ||
      [...this.#completed].some((id) => !nowCompleted.has(id));
    if (rewound) {
      this.#started = new Set();
      this.#completed = new Set();
    }

    for (const entry of this.#timeline.entries) {
      if (nowStarted.has(entry.strokeId) && !this.#started.has(entry.strokeId)) {
        this.#emit({ type: "StrokeStarted", strokeId: entry.strokeId });
      }
      if (nowCompleted.has(entry.strokeId) && !this.#completed.has(entry.strokeId)) {
        this.#emit({ type: "StrokeCompleted", strokeId: entry.strokeId });
      }
    }

    this.#started = nowStarted;
    this.#completed = nowCompleted;
  }

  #emit(event: EventBody): void {
    if (this.#listeners.size === 0) return;
    const full = { ...event, sessionId: this.#sessionId, at: this.#now() } as RuntimeEvent;
    for (const listener of this.#listeners) listener(full);
  }
}
