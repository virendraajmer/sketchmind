/**
 * The viewport (Volume 08 §Viewport): pan, zoom, fit-to-content, centre, and the
 * coordinate transforms between layout space and screen space.
 *
 * **This is the only place pixels enter the system.** Everything upstream --
 * layout, strokes, hit-test input -- is in the abstract diagram space Volume 05
 * defines, which is what lets one Layout Model render identically to a 400px
 * canvas and an A3 PDF. A click arrives in pixels and must go through `toWorld`
 * before anything semantic looks at it.
 *
 * The transform is `screen = world * zoom + offset`, deliberately the same shape
 * as a Konva stage's `scale` + `position`, so the Konva adapter applies it by
 * assignment rather than by transforming every point.
 */
import type { BoundingBox, Point, Size } from "@sketchmind/shared-types";

export interface ViewportState {
  readonly size: Size;
  /** Screen-space translation applied after scaling. */
  readonly offset: Point;
  readonly zoom: number;
}

export interface ViewportOptions {
  readonly zoom?: number;
  readonly offset?: Point;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  /** Layout-space padding left around content by `fitToContent`. */
  readonly padding?: number;
}

export const DEFAULT_MIN_ZOOM = 0.05;
export const DEFAULT_MAX_ZOOM = 40;
export const DEFAULT_FIT_PADDING = 24;

export class Viewport {
  #size: Size;
  #offset: Point;
  #zoom: number;
  readonly #minZoom: number;
  readonly #maxZoom: number;
  readonly #padding: number;

  constructor(size: Size, options: ViewportOptions = {}) {
    this.#size = { ...size };
    this.#offset = options.offset ? { ...options.offset } : { x: 0, y: 0 };
    this.#minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM;
    this.#maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM;
    this.#padding = options.padding ?? DEFAULT_FIT_PADDING;
    this.#zoom = this.#clampZoom(options.zoom ?? 1);
  }

  #clampZoom(zoom: number): number {
    if (!Number.isFinite(zoom) || zoom <= 0) return this.#minZoom;
    return Math.max(this.#minZoom, Math.min(this.#maxZoom, zoom));
  }

  state(): ViewportState {
    return { size: { ...this.#size }, offset: { ...this.#offset }, zoom: this.#zoom };
  }

  size(): Size {
    return { ...this.#size };
  }

  resize(size: Size): void {
    this.#size = { ...size };
  }

  toScreen(point: Point): Point {
    return { x: point.x * this.#zoom + this.#offset.x, y: point.y * this.#zoom + this.#offset.y };
  }

  toWorld(point: Point): Point {
    return { x: (point.x - this.#offset.x) / this.#zoom, y: (point.y - this.#offset.y) / this.#zoom };
  }

  panBy(dx: number, dy: number): void {
    this.#offset = { x: this.#offset.x + dx, y: this.#offset.y + dy };
  }

  panTo(offset: Point): void {
    this.#offset = { ...offset };
  }

  /**
   * Zoom about a screen-space anchor -- the point under the cursor stays under
   * the cursor, which is the only zoom behaviour that does not feel broken.
   */
  setZoom(zoom: number, anchor?: Point): void {
    const next = this.#clampZoom(zoom);
    if (anchor) {
      const world = this.toWorld(anchor);
      this.#zoom = next;
      this.#offset = { x: anchor.x - world.x * next, y: anchor.y - world.y * next };
      return;
    }
    const centre = { x: this.#size.width / 2, y: this.#size.height / 2 };
    const world = this.toWorld(centre);
    this.#zoom = next;
    this.#offset = { x: centre.x - world.x * next, y: centre.y - world.y * next };
  }

  zoomBy(factor: number, anchor?: Point): void {
    this.setZoom(this.#zoom * factor, anchor);
  }

  /** Scale and centre so `bounds` fills the viewport with padding around it. */
  fitToContent(bounds: BoundingBox, padding = this.#padding): void {
    const width = bounds.width + padding * 2;
    const height = bounds.height + padding * 2;
    // Degenerate content (a single point, an empty diagram) has no scale to fit
    // to; centring it at the current zoom is the only sensible reading.
    if (width <= 0 || height <= 0) {
      this.center(bounds);
      return;
    }
    this.#zoom = this.#clampZoom(
      Math.min(this.#size.width / width, this.#size.height / height),
    );
    this.center(bounds);
  }

  /** Centre `bounds` without changing zoom. */
  center(bounds: BoundingBox): void {
    const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    this.#offset = {
      x: this.#size.width / 2 - centre.x * this.#zoom,
      y: this.#size.height / 2 - centre.y * this.#zoom,
    };
  }

  /** The layout-space rectangle currently visible. Infinite canvas: no clamping. */
  visibleBounds(): BoundingBox {
    const topLeft = this.toWorld({ x: 0, y: 0 });
    const bottomRight = this.toWorld({ x: this.#size.width, y: this.#size.height });
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }
}
