/**
 * `critique_diagram`: tier 1 as something the agent may call whenever it likes.
 *
 * The same critique also runs automatically before playback. Having both is not
 * duplication -- the automatic pass guarantees no diagram ships uninspected, and
 * the tool lets the agent check its work mid-run, before it has spent the rest
 * of its budget planning strokes for a layout that was already wrong.
 *
 * `readOnly: true` is exact: this tool changes nothing. It reports.
 */
import { defineTool, type ToolDefinition } from "@sketchmind/agent-core";
import {
  fail,
  makeError,
  ok,
  type DiagramAST,
  type LayoutModel,
  type StrokeAST,
} from "@sketchmind/shared-types";
import { z } from "zod";
import { critiqueGeometry } from "./internal/critique-geometry.js";
import type { GeometricCritiqueOptions } from "./internal/checks.js";

export const PACKAGE = "@sketchmind/agent-vision";

export interface VisionToolsOptions {
  readonly getAst: () => DiagramAST | undefined;
  readonly getLayout: () => LayoutModel | undefined;
  readonly getStrokes: () => StrokeAST | undefined;
  readonly options?: GeometricCritiqueOptions;
}

export function createVisionTools(toolOptions: VisionToolsOptions): ToolDefinition[] {
  const critique = defineTool({
    name: "critique_diagram",
    description:
      "Inspect the solved diagram for problems a viewer would notice: objects overlapping, " +
      "things off the edge of the board, connectors that miss the anchor they were meant to " +
      "meet, connectors crossing, objects with no usable size, an unbalanced board, and objects " +
      "nothing was drawn for. Requires solve_layout to have run. Costs nothing and changes " +
      "nothing -- call it whenever you want to know whether the diagram is right before " +
      "committing more effort to it.",
    locus: "server",
    readOnly: true,
    argsSchema: z.object({}),
    handler: () => {
      const ast = toolOptions.getAst();
      const layout = toolOptions.getLayout();
      if (!ast || !layout) {
        return fail([
          makeError({
            code: "CRITIQUE_MISSING_INPUT",
            message:
              "There is no solved layout to inspect yet. Call compose_diagram_ast, " +
              "derive_constraints and solve_layout first.",
            package: PACKAGE,
            stage: "layout",
            recoverable: true,
          }),
        ]);
      }

      const strokes = toolOptions.getStrokes();
      const findings = critiqueGeometry({
        ast,
        layout,
        ...(strokes ? { strokes } : {}),
        ...(toolOptions.options ? { options: toolOptions.options } : {}),
      });

      return ok({
        findings,
        // A count the model can act on without reading the whole list.
        errorCount: findings.filter((f) => f.severity === "error").length,
      });
    },
  });

  return [critique];
}
