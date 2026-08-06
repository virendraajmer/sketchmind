import { defineConfig } from "vitest/config";

/**
 * The Konva canvas backend installs by side effect and must land before `konva`
 * is first evaluated, which only `setupFiles` guarantees (Phase 8 D-9). It is a
 * real rasteriser, not a mock: `render-pipeline.test.ts` decodes the PNG bytes it
 * produces.
 */
export default defineConfig({
  test: {
    setupFiles: ["./support/headless.ts"],
  },
});
