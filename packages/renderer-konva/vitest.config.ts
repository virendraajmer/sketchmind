import { defineConfig } from "vitest/config";

/**
 * `setupFiles` runs before any test module is imported, which is the only place
 * the Konva canvas backend can be installed: it works by side effect and must
 * land before `konva` is first evaluated (Phase 8 D-9).
 */
export default defineConfig({
  test: {
    setupFiles: ["./tests/support/headless.ts"],
  },
});
