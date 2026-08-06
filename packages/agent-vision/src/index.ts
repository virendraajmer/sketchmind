/**
 * @sketchmind/agent-vision
 *
 * Self-correction (AD-3): the agent looks at what it drew and says what is
 * wrong with it. Two tiers, one finding shape.
 *
 * Tier 1 is deterministic software reading the `LayoutModel` and `StrokeAST` the
 * pipeline already produced -- free, instant, and catching most of what actually
 * goes wrong. Tier 2 is a model looking at pixels, which is the only thing that
 * can notice a diagram does not *read* as a pulley system. Both emit
 * `CritiqueFinding[]`, so the repair loop never asks which one spoke.
 *
 * This package does not import `layout-engine`. Critique is an observer that
 * forms its own opinion from the solver's output; sharing the solver's helpers
 * would make the two agree by construction.
 *
 * Public API only. Implementation belongs in src/internal/ (Volume 12).
 */

export const PACKAGE_NAME = "@sketchmind/agent-vision";
export const PACKAGE_VERSION = "0.0.1";

export {
  critiqueGeometry,
  type CritiqueGeometryInput,
} from "./internal/critique-geometry.js";

export {
  DEFAULT_OPTIONS as DEFAULT_GEOMETRIC_OPTIONS,
  type CheckName,
  type GeometricCritiqueOptions,
} from "./internal/checks.js";

export { createVisionTools, type VisionToolsOptions } from "./tools-server.js";

export { critiqueImage, type CritiqueImageInput } from "./internal/critique-image.js";

export {
  VisionWorkspace,
  createClientVisionTools,
  type ClientVisionToolsOptions,
} from "./tools-client.js";

export {
  runVisionAgent,
  type RunVisionAgentOptions,
  type VisionAgentResult,
} from "./client-agent.js";
