/**
 * The scene: which strokes are currently on the surface, as resolved geometry.
 *
 * Reconciliation lives here rather than in each backend (D-7) so that "render the
 * same frame twice and nothing changes" is one property proved once, instead of
 * two backends each hoping. A backend receives a `SceneDiff` and does the minimum
 * work its API needs -- add these nodes, repoint that one, destroy those.
 *
 * Seeking backwards, undo, and a runtime edit all reduce to the same diff: the
 * frame is a pure function of time, so a smaller `completed` set simply produces
 * removals.
 */
import type { Stroke } from "@sketchmind/shared-types";
import type { RenderFrame } from "./adapter.js";
import { resolveStroke, type DisplayStroke } from "./display.js";
import type { RendererTheme } from "./theme.js";

export interface SceneDiff {
  readonly added: readonly DisplayStroke[];
  /** Same stroke id, different geometry or paint -- the in-progress stroke, mostly. */
  readonly updated: readonly DisplayStroke[];
  readonly removed: readonly string[];
}

export const EMPTY_DIFF: SceneDiff = { added: [], updated: [], removed: [] };

/** Cheap structural equality; `points` dominates, so compare it first. */
function sameGeometry(a: DisplayStroke, b: DisplayStroke): boolean {
  if (a.progress !== b.progress) return false;
  if (a.points.length !== b.points.length) return false;
  for (let i = 0; i < a.points.length; i += 1) {
    if (a.points[i]!.x !== b.points[i]!.x || a.points[i]!.y !== b.points[i]!.y) return false;
  }
  return (
    a.layer === b.layer &&
    a.type === b.type &&
    a.text === b.text &&
    a.paint.color === b.paint.color &&
    a.paint.width === b.paint.width &&
    a.paint.opacity === b.paint.opacity
  );
}

export class Scene {
  /** Insertion order is draw order, and `Map` preserves it. */
  readonly #strokes = new Map<string, DisplayStroke>();
  /** Source strokes, kept so a theme change can re-resolve without a new frame. */
  readonly #sources = new Map<string, Stroke>();
  #theme: RendererTheme;

  constructor(theme: RendererTheme) {
    this.#theme = theme;
  }

  theme(): RendererTheme {
    return this.#theme;
  }

  setTheme(theme: RendererTheme): SceneDiff {
    this.#theme = theme;
    const updated = [...this.#strokes.values()].map((stroke) =>
      resolveStroke(this.#sources.get(stroke.id)!, theme, stroke.progress),
    );
    for (const stroke of updated) this.#strokes.set(stroke.id, stroke);
    return { added: [], updated, removed: [] };
  }

  strokes(): readonly DisplayStroke[] {
    return [...this.#strokes.values()];
  }

  get(id: string): DisplayStroke | undefined {
    return this.#strokes.get(id);
  }

  has(id: string): boolean {
    return this.#strokes.has(id);
  }

  /** Add or replace one stroke. Returns the diff so callers stay uniform. */
  set(stroke: Stroke, progress = 1): SceneDiff {
    const resolved = resolveStroke(stroke, this.#theme, progress);
    const existing = this.#strokes.get(stroke.id);
    this.#sources.set(stroke.id, stroke);
    this.#strokes.set(stroke.id, resolved);
    if (!existing) return { added: [resolved], updated: [], removed: [] };
    if (sameGeometry(existing, resolved)) return EMPTY_DIFF;
    return { added: [], updated: [resolved], removed: [] };
  }

  remove(id: string): SceneDiff {
    if (!this.#strokes.delete(id)) return EMPTY_DIFF;
    this.#sources.delete(id);
    return { added: [], updated: [], removed: [id] };
  }

  clear(): SceneDiff {
    const removed = [...this.#strokes.keys()];
    this.#strokes.clear();
    this.#sources.clear();
    return removed.length === 0 ? EMPTY_DIFF : { added: [], updated: [], removed };
  }

  /**
   * Reconcile against a frame.
   *
   * The in-progress stroke's `progress` is used rather than its `points`: the
   * runtime interpolates the *exact* path, but the renderer draws the jittered
   * one, and cutting the jittered path is what keeps a stroke's shake from
   * settling as it completes (D-3).
   */
  applyFrame(frame: RenderFrame): SceneDiff {
    const added: DisplayStroke[] = [];
    const updated: DisplayStroke[] = [];

    const live = new Set<string>();
    const upsert = (stroke: Stroke, progress: number): void => {
      live.add(stroke.id);
      const diff = this.set(stroke, progress);
      added.push(...diff.added);
      updated.push(...diff.updated);
    };

    for (const stroke of frame.completed) upsert(stroke, 1);
    if (frame.inProgress) upsert(frame.inProgress.stroke, frame.inProgress.progress);

    const removed: string[] = [];
    for (const id of [...this.#strokes.keys()]) {
      if (live.has(id)) continue;
      this.#strokes.delete(id);
      this.#sources.delete(id);
      removed.push(id);
    }

    if (added.length === 0 && updated.length === 0 && removed.length === 0) return EMPTY_DIFF;
    return { added, updated, removed };
  }
}
