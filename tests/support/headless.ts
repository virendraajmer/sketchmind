/**
 * Points Konva at `node-canvas` so the renderer really rasterises under Node
 * (Phase 8 D-9). Loaded via `setupFiles`, because the backend installs by side
 * effect and must land before `konva` is first evaluated.
 */
import "konva/canvas-backend";
