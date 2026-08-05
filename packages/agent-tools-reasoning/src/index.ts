/**
 * @sketchmind/agent-tools-reasoning
 *
 * The reasoning pipeline, exposed as agent tools (AD-1).
 *
 * This package owns no reasoning of its own. `intent-analyzer`,
 * `visual-planner`, `shape-intelligence` and `diagram-reasoner` each keep their
 * V12/V15 contract and know nothing about agents; this is the seam that turns
 * them into a tool catalogue, and it is the only place that knows both an
 * `LLMProvider` and a `ToolDefinition`.
 *
 * Keeping the seam thin is the point. When Phase 6 adds the layout stage, it
 * becomes another tool here and neither the loop nor any reasoning package
 * changes.
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */

export const PACKAGE_NAME = "@sketchmind/agent-tools-reasoning";
export const PACKAGE_VERSION = "0.0.1";

export {
  createReasoningTools,
  validateDiagramAST,
  validateShapeGraph,
  validateVisualPlan,
  type ReasoningToolsOptions,
} from "./tools.js";

export { ReasoningWorkspace, type FailedAttempt } from "./workspace.js";

export { memoryCatalog } from "./memory-catalog.js";

export {
  BANNED_FIELDS,
  BANNED_FIELDS_UNIT_SPACE,
  geometryErrors,
  geometryViolations,
} from "./internal/guard.js";
