/**
 * The geometry pipeline, as tools the agent may call, skip, reorder or repeat
 * (AD-1) -- the other half of the catalogue `agent-tools-reasoning` opened.
 *
 * Two things make these different from the reasoning tools, and both are the
 * same difference seen twice:
 *
 *  - **There is no geometry guard.** The reasoning tools reject any output
 *    containing a coordinate, because a model authored it. These stages are
 *    deterministic code, and producing coordinates is precisely their job. The
 *    guard is not omitted here by oversight; it would be checking the wrong
 *    invariant.
 *  - **The model is not shown the geometry.** A LayoutModel is thousands of
 *    numbers the model cannot usefully read, and the surest way to keep it from
 *    inventing coordinates is to never put any in its context. So each handler
 *    stores the artifact in the workspace and returns a summary -- counts, ids,
 *    canvas size -- which is what the model actually reasons about.
 *
 * Failures are the exception to that: on a failed `ValidationResult` the errors
 * pass through verbatim, because an error the model cannot read is one it cannot
 * fix (AD-2).
 */
import { defineTool, type ToolDefinition } from "@sketchmind/agent-core";
import {
  fail,
  makeError,
  ok,
  type DiagramAST,
  type FreeformShape,
  type PipelineStage,
  type SketchMindError,
} from "@sketchmind/shared-types";
import { deriveConstraintGraph } from "@sketchmind/constraint-engine";
import { registeredStrategyNames, solveLayout } from "@sketchmind/layout-engine";
import { planStrokes } from "@sketchmind/stroke-planner";
import { z } from "zod";
import { GeometryWorkspace } from "./workspace.js";

export const PACKAGE = "@sketchmind/agent-tools-geometry";

export interface GeometryToolsOptions {
  /** Per-run artifact store. Create one per session; a shared one leaks state. */
  readonly workspace: GeometryWorkspace;
  /**
   * The diagram to lay out. A getter rather than a value because the AST does
   * not exist yet when the tools are built -- the agent composes it mid-run,
   * into a workspace this package deliberately knows nothing about.
   */
  readonly getAst: () => DiagramAST | undefined;
  /**
   * Shapes `compose_freeform` produced this run (AD-5), read the same way and
   * for the same reason. Without them an object the type table cannot name is
   * drawn as a box, which silently discards the shape the agent worked out.
   */
  readonly getFreeforms?: () => ReadonlyMap<string, FreeformShape> | undefined;
}

function missing(what: string, tool: string, stage: PipelineStage): SketchMindError {
  return makeError({
    code: "GEOMETRY_MISSING_INPUT",
    message: `No ${what} has been produced yet in this session. Call ${tool} first.`,
    package: PACKAGE,
    stage,
    recoverable: true,
  });
}

const NoArgs = z.object({});

export function createGeometryTools(options: GeometryToolsOptions): ToolDefinition[] {
  const { workspace, getAst, getFreeforms } = options;

  const constraints = defineTool({
    name: "derive_constraints",
    description:
      "Work out how the diagram's objects must sit relative to one another -- what is above, " +
      "inside, attached to or aligned with what -- from the relationships already in the diagram. " +
      "Requires a composed diagram. Produces relationships, still no positions.",
    locus: "server",
    argsSchema: NoArgs,
    handler: () => {
      const ast = getAst();
      if (!ast) return fail([missing("diagram AST", "compose_diagram_ast", "constraint")]);

      const result = deriveConstraintGraph(ast);
      if (!result.ok) return result;

      workspace.constraintGraph = result.value;
      return ok({
        nodes: result.value.nodes.length,
        constraints: result.value.constraints.length,
      });
    },
  });

  const layout = defineTool({
    name: "solve_layout",
    description:
      "Turn the constraint relationships into actual positions and sizes on the board: solve the " +
      "constraints, keep objects from overlapping, place labels, route connectors. Requires " +
      "derive_constraints to have run. This is the first stage that produces coordinates, and the " +
      `only one allowed to. Strategies available: ${registeredStrategyNames().join(", ")}; omit to ` +
      "let the diagram's own category choose.",
    locus: "server",
    argsSchema: z.object({
      strategy: z
        .string()
        .optional()
        .describe("A named layout strategy. Omit unless the default arranges things badly."),
    }),
    handler: (args) => {
      const ast = getAst();
      if (!ast) return fail([missing("diagram AST", "compose_diagram_ast", "layout")]);

      const graph = workspace.constraintGraph;
      if (!graph) return fail([missing("constraint graph", "derive_constraints", "layout")]);

      const result = solveLayout(ast, graph, args.strategy ? { strategy: args.strategy } : {});
      if (!result.ok) return result;

      workspace.layout = result.value;
      return ok({
        strategy: result.value.strategy,
        canvas: result.value.canvas,
        nodes: result.value.nodes.length,
        connectors: result.value.connectors.length,
        labels: result.value.labels.length,
      });
    },
  });

  const strokes = defineTool({
    name: "plan_strokes",
    description:
      "Turn the solved layout into a drawing sequence -- the order a teacher would draw it in, the " +
      "path the pen takes, how long each stroke takes. Requires solve_layout to have run. Call this " +
      "when the diagram is ready to be drawn; it is the last step before the board starts filling in.",
    locus: "server",
    argsSchema: z.object({
      optimize: z
        .boolean()
        .default(true)
        .describe("Merge and thin strokes. Leave on unless comparing against an unoptimized plan."),
    }),
    handler: (args) => {
      const ast = getAst();
      if (!ast) return fail([missing("diagram AST", "compose_diagram_ast", "stroke")]);

      const solved = workspace.layout;
      if (!solved) return fail([missing("layout", "solve_layout", "stroke")]);

      const freeforms = getFreeforms?.();
      const result = planStrokes(ast, solved, {
        optimize: args.optimize,
        ...(freeforms ? { freeforms } : {}),
      });
      if (!result.ok) return result;

      workspace.strokeAST = result.value;
      return ok({
        strokes: result.value.strokes.length,
        totalDurationMs: result.value.totalDurationMs,
        // Named so the model can tell "I drew everything" from "I drew the
        // pulley and forgot the rope" without being shown a coordinate.
        targets: [...new Set(result.value.strokes.map((stroke) => stroke.target))],
        // Which objects fell back to a plain box, so the model can see that a
        // shape it composed was not picked up -- and compose one for the rest.
        drawnAsBox: [
          ...new Set(
            result.value.strokes
              .filter((stroke) => stroke.metadata?.["generator"] === "box")
              .map((stroke) => stroke.target),
          ),
        ],
      });
    },
  });

  return [constraints, layout, strokes];
}
