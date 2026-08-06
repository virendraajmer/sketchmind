/**
 * Makes Konva render under Node (Phase 8 D-9).
 *
 * Konva 10 splits its rendering backend out, so importing `konva/canvas-backend`
 * for its side effects before anything touches `konva` points the library at
 * `node-canvas`. The result is not a mock: real rasterisation, real PNG bytes,
 * real `getIntersection`. That is what turns every Phase 8 acceptance criterion
 * into an automated assertion instead of a screenshot someone eyeballs.
 *
 * It lives in `tests/` and is wired through `setupFiles`, so `src/` never learns
 * that Node exists and `canvas` stays a devDependency that no bundle can reach.
 */
import "konva/canvas-backend";
