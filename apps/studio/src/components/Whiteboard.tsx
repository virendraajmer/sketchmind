import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createKonvaRenderer } from "@sketchmind/renderer-konva";
import type { RendererAdapter } from "@sketchmind/renderer-core";
import type { BoundingBox, DrawingFrame } from "@sketchmind/shared-types";

export interface WhiteboardProps {
  readonly frame?: DrawingFrame;
  readonly bounds?: BoundingBox;
  /**
   * What the agent is doing right now, shown while the board is still empty.
   * Nothing is drawn until `plan_strokes` runs, which is the last stage -- so
   * without this the board is blank for the whole run and looks stalled.
   */
  readonly activity?: string;
  /** Upper bound on the canvas's rendered width; height follows from the aspect ratio. */
  readonly width?: number;
  readonly height?: number;
}

/**
 * What the vision agent's capture closure needs from this component.
 *
 * `getBitmap` goes straight at the mounted `<canvas>` element rather than
 * through `RendererAdapter.captureImage()`: that method already PNG-encodes
 * synchronously on the main thread (Konva's `toDataURL`), which is exactly the
 * cost Phase 10's capture worker exists to move off it. `createImageBitmap` on
 * the raw canvas is a cheap copy, not an encode, so the worker in
 * `src/workers/capture.worker.ts` does the encoding instead. Kept minimal and
 * DOM-direct on purpose -- see Task 12's report for why this wasn't built as a
 * new `renderer-core` capability.
 */
export interface WhiteboardHandle {
  getBitmap(): Promise<ImageBitmap>;
}

function Whiteboard(
  { frame, bounds, activity, width = 900, height = 600 }: WhiteboardProps,
  ref: React.ForwardedRef<WhiteboardHandle>,
): React.JSX.Element {
  const wrapper = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const adapter = useRef<RendererAdapter | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The canvas fills its wrapper's width (up to `width`) rather than staying a
  // fixed 900x600 box, so a narrow viewport never forces horizontal scroll.
  const [size, setSize] = useState({ width, height });

  useEffect(() => {
    const target = wrapper.current;
    if (!target) return;

    const aspect = width / height;
    const observer = new ResizeObserver((entries) => {
      const observedWidth = entries[0]?.contentRect.width;
      if (!observedWidth) return;
      const nextWidth = Math.min(width, Math.round(observedWidth));
      setSize({ width: nextWidth, height: Math.round(nextWidth / aspect) });
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [width, height]);

  // Konva is created once per mount, at whatever `size` happens to be at that
  // point; later size changes go through `resizeViewport` below rather than
  // tearing the stage down and rebuilding it.
  useEffect(() => {
    if (!mount.current) return;

    const created = createKonvaRenderer({
      size,
      container: mount.current,
    });
    if (!created.ok) {
      setError(created.errors[0]?.message ?? "The canvas could not be created.");
      return;
    }

    setError(null);
    adapter.current = created.value;
    return () => {
      adapter.current?.destroy();
      adapter.current = null;
    };
  }, []);

  useEffect(() => {
    if (!adapter.current) return;
    adapter.current.resizeViewport(size);
    if (bounds) adapter.current.fitToContent(bounds);
  }, [size, bounds]);

  useEffect(() => {
    if (adapter.current && frame) adapter.current.renderFrame(frame);
  }, [frame]);

  useImperativeHandle(
    ref,
    () => ({
      async getBitmap(): Promise<ImageBitmap> {
        const canvasEl = mount.current?.querySelector("canvas");
        if (!canvasEl) throw new Error("The whiteboard canvas is not mounted.");
        return createImageBitmap(canvasEl);
      },
    }),
    [],
  );

  return (
    <div ref={wrapper} className="w-full" style={{ maxWidth: width }}>
      <div
        className="relative bg-surface border border-line rounded-lg overflow-hidden"
        style={{ width: size.width, height: size.height, maxWidth: "100%" }}
      >
        {/* Konva owns everything inside this element imperatively; it must stay
            free of React-rendered children or reconciliation and Konva's own
            DOM writes will fight over the same node. */}
        <div ref={mount} className="absolute inset-0" />

        {error ? (
          <p role="alert" className="absolute inset-0 flex items-center justify-center p-4 text-center text-danger">
            {error}
          </p>
        ) : !frame ? (
          <p
            className="absolute inset-0 flex items-center justify-center gap-2 text-muted pointer-events-none"
            role="status"
          >
            {activity ? (
              <>
                <span
                  aria-hidden="true"
                  className="inline-block size-2 animate-pulse rounded-full bg-current"
                />
                {activity}
              </>
            ) : (
              "Nothing drawn yet."
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default forwardRef(Whiteboard);
