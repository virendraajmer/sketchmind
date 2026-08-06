import { useEffect, useRef } from "react";
import { createKonvaRenderer } from "@sketchmind/renderer-konva";
import type { RendererAdapter } from "@sketchmind/renderer-core";
import type { BoundingBox, DrawingFrame } from "@sketchmind/shared-types";

export interface WhiteboardProps {
  readonly frame?: DrawingFrame;
  readonly bounds?: BoundingBox;
  readonly width?: number;
  readonly height?: number;
}

export default function Whiteboard({
  frame,
  bounds,
  width = 900,
  height = 600,
}: WhiteboardProps): React.JSX.Element {
  const mount = useRef<HTMLDivElement>(null);
  const adapter = useRef<RendererAdapter | null>(null);

  useEffect(() => {
    if (!mount.current) return;

    const created = createKonvaRenderer({
      size: { width, height },
      container: mount.current,
    });
    if (!created.ok) return;

    adapter.current = created.value;
    return () => {
      adapter.current?.destroy();
      adapter.current = null;
    };
  }, [width, height]);

  useEffect(() => {
    if (adapter.current && bounds) adapter.current.fitToContent(bounds);
  }, [bounds]);

  useEffect(() => {
    if (adapter.current && frame) adapter.current.renderFrame(frame);
  }, [frame]);

  return (
    <div
      ref={mount}
      className="bg-surface border border-line rounded-lg overflow-hidden"
      style={{ width, height }}
    />
  );
}
