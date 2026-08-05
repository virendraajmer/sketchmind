/**
 * The reasoning pipeline, as tools the agent may call, skip, reorder or repeat
 * (AD-1).
 *
 * V09 specifies nine stages in a fixed order, every time. Here they are eight
 * tools with no prescribed sequence, and the difference shows up in the cost of a
 * simple request: "draw a circle" can be one `compose_diagram_ast` call, while
 * "draw a hydraulic press" gets intent, plan, shape graph, composition, and as
 * many validation rounds as it needs. Nothing in this file expresses a preferred
 * order -- only the tool descriptions, which the model is free to disagree with.
 *
 * Three properties every tool here has:
 *
 *  - **It returns a `ValidationResult`.** `agent-core` unwraps `ok` and turns
 *    `errors` into an observation verbatim (AD-2), so a stage's own validator is
 *    the agent's error message with no adapter in between.
 *  - **Its output is checked for geometry** before the model sees it. No
 *    reasoning tool may emit a coordinate, and `metadata` bags make that a
 *    runtime question, not a schema one.
 *  - **It reads its inputs from the workspace**, so the model is never asked to
 *    carry a ShapeGraph back through its own context window.
 */
import { defineTool, type ToolDefinition } from "@sketchmind/agent-core";
import {
  fail,
  makeError,
  ok,
  type PipelineStage,
  type SketchMindError,
  type ValidationResult,
} from "@sketchmind/shared-types";
import type { LLMProvider } from "@sketchmind/llm-provider";
import { analyzeIntent } from "@sketchmind/intent-analyzer";
import { planVisual, validateVisualPlan } from "@sketchmind/visual-planner";
import {
  EMPTY_CATALOG,
  buildShapeGraph,
  composeFreeform,
  generatePrimitive,
  searchPrimitives,
  validateShapeGraph,
  type PrimitiveCatalog,
} from "@sketchmind/shape-intelligence";
import { composeDiagramAST } from "@sketchmind/diagram-reasoner";
import { validateDiagramAST } from "@sketchmind/diagram-ast";
import { z } from "zod";
import {
  BANNED_FIELDS,
  BANNED_FIELDS_UNIT_SPACE,
  PACKAGE,
  geometryErrors,
} from "./internal/guard.js";
import { ReasoningWorkspace } from "./workspace.js";

export interface ReasoningToolsOptions {
  readonly provider: LLMProvider;
  /** Per-run artifact store. Create one per session; a shared one leaks state. */
  readonly workspace: ReasoningWorkspace;
  /** Searched before any primitive is generated (V10). Defaults to empty. */
  readonly catalog?: PrimitiveCatalog;
  /** Passed through to `completeStructured` for every stage. */
  readonly maxRepairAttempts?: number;
}

function missing(
  what: string,
  tool: string,
  stage: PipelineStage,
): SketchMindError {
  return makeError({
    code: "REASONING_MISSING_INPUT",
    message:
      `No ${what} has been produced yet in this session. Call ${tool} first, or compose the ` +
      `diagram directly with compose_diagram_ast if the request is simple enough not to need it.`,
    package: PACKAGE,
    stage,
    recoverable: true,
  });
}

/**
 * Run the geometry guard over a successful result before it reaches the model.
 *
 * On a violation the whole result is rejected rather than stripped. Silently
 * removing the field would teach the model nothing and leave the run holding an
 * artifact that differs from what the model believes it produced.
 */
function guarded<T>(
  result: ValidationResult<T>,
  stage: PipelineStage,
  banned: readonly string[] = BANNED_FIELDS,
): ValidationResult<T> {
  if (!result.ok) return result;
  const errors = geometryErrors(result.value, stage, banned);
  return errors.length > 0 ? fail(errors) : result;
}

const NoArgs = z.object({});

export function createReasoningTools(options: ReasoningToolsOptions): ToolDefinition[] {
  const { provider, workspace } = options;
  const catalog = options.catalog ?? EMPTY_CATALOG;
  const repair =
    options.maxRepairAttempts === undefined ? {} : { maxRepairAttempts: options.maxRepairAttempts };

  const analyze = defineTool({
    name: "analyze_intent",
    description:
      "Work out what a drawing request is really asking for: the subject, its field, the kind of " +
      "diagram that fits, how complex it is, and what the learner should understand. Worth calling " +
      "when the request is ambiguous or the subject is unfamiliar; skip it for an obvious shape.",
    locus: "server",
    readOnly: true,
    argsSchema: z.object({
      request: z.string().min(1).describe("The user's request, in their own words."),
    }),
    handler: async (args, ctx) => {
      const result = guarded(
        await analyzeIntent({ provider, request: args.request, signal: ctx.signal, ...repair }),
        "intent",
      );
      if (result.ok) workspace.intent = result.value;
      return result;
    },
  });

  const plan = defineTool({
    name: "plan_visual",
    description:
      "Decide what should appear on the whiteboard for the analysed intent: which objects, which " +
      "labels, what to emphasise, and the order a teacher would draw them. Requires analyze_intent " +
      "to have run. Decides what appears, never what it looks like or where it goes.",
    locus: "server",
    readOnly: true,
    argsSchema: NoArgs,
    handler: async (_args, ctx) => {
      if (!workspace.intent) return fail([missing("intent", "analyze_intent", "vil")]);
      const result = guarded(
        await planVisual({ provider, intent: workspace.intent, signal: ctx.signal, ...repair }),
        "vil",
      );
      if (result.ok) workspace.plan = result.value;
      return result;
    },
  });

  const shapes = defineTool({
    name: "build_shape_graph",
    description:
      "Work out what the planned objects are structurally made of: their parts, the named anchors " +
      "other things attach to, and how the parts relate. Requires plan_visual to have run. Worth " +
      "calling when objects have internal structure; skip it when they are single shapes.",
    locus: "server",
    readOnly: true,
    argsSchema: NoArgs,
    handler: async (_args, ctx) => {
      const plan = workspace.plan;
      if (!plan) return fail([missing("visual plan", "plan_visual", "shape-graph")]);
      const result = guarded(
        await buildShapeGraph({
          provider,
          plan,
          ...(workspace.intent ? { intent: workspace.intent } : {}),
          signal: ctx.signal,
          ...repair,
        }),
        "shape-graph",
      );
      if (result.ok) workspace.shapeGraph = result.value;
      return result;
    },
  });

  const compose = defineTool({
    name: "compose_diagram_ast",
    description:
      "Compose the Diagram AST: what exists in the diagram, as objects, parts, labels and " +
      "relationships, with no geometry. Uses whatever reasoning has already been done in this " +
      "session, and works with none of it -- call this alone for a request simple enough to " +
      "compose directly. If a previous attempt failed validation, this repairs it.",
    locus: "server",
    argsSchema: z.object({
      request: z.string().min(1).describe("The user's request, in their own words."),
    }),
    handler: async (args, ctx) => {
      const result = guarded(
        await composeDiagramAST({
          provider,
          request: args.request,
          ...(workspace.intent ? { intent: workspace.intent } : {}),
          ...(workspace.plan ? { plan: workspace.plan } : {}),
          ...(workspace.shapeGraph ? { shapeGraph: workspace.shapeGraph } : {}),
          ...(workspace.lastFailure
            ? {
                previousAttempt: workspace.lastFailure.attempt,
                previousErrors: workspace.lastFailure.errors,
              }
            : {}),
          signal: ctx.signal,
          ...repair,
        }),
        "diagram-ast",
      );

      if (result.ok) {
        workspace.ast = result.value;
        workspace.clearFailure();
      }
      return result;
    },
  });

  const validate = defineTool({
    name: "validate_diagram",
    description:
      "Check a Diagram AST and report every problem at once: duplicate ids, references to objects " +
      "that do not exist, anchors that were never declared, orphaned objects, geometry that does " +
      "not belong. Pass an AST to check it, or omit it to check the one composed in this session. " +
      "Problems come back as a list to fix, not as a failure.",
    locus: "server",
    readOnly: true,
    argsSchema: z.object({
      ast: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The AST to check. Omit to check the session's current one."),
    }),
    handler: async (args) => {
      const candidate = args.ast ?? workspace.ast;
      if (candidate === undefined) {
        return fail([missing("diagram AST", "compose_diagram_ast", "diagram-ast")]);
      }

      const result = guarded(validateDiagramAST(candidate), "diagram-ast");
      if (result.ok) {
        workspace.ast = result.value;
        workspace.clearFailure();
        return ok({ valid: true as const, id: result.value.id, title: result.value.title });
      }

      // Remember the failure so the next compose_diagram_ast is a repair rather
      // than a fresh guess (AD-2).
      workspace.recordFailure(candidate, result.errors);
      return result;
    },
  });

  const search = defineTool({
    name: "search_primitives",
    description:
      "Search the primitives already known -- registered and previously learned -- for one matching " +
      "a description, even if worded differently than when it was stored. Costs nothing and makes " +
      "no model call. Always cheaper than inventing a shape from scratch.",
    locus: "server",
    readOnly: true,
    argsSchema: z.object({
      query: z.string().min(1).describe("What you are looking for, e.g. 'nephron'."),
      limit: z.number().int().positive().max(20).default(5),
    }),
    handler: async (args) => {
      workspace.recordSearch(args.query);
      const result = await searchPrimitives({ catalog, query: args.query, limit: args.limit });
      if (!result.ok) return result;
      return ok(
        result.value.map((match) => ({
          id: match.record.id,
          name: match.record.name,
          description: match.record.description,
          score: Number(match.score.toFixed(3)),
          hasShapeGraph: match.record.shapeGraph !== undefined,
          hasShape: match.record.shape !== undefined,
        })),
      );
    },
  });

  const generate = defineTool({
    name: "generate_primitive",
    description:
      "Work out what one unfamiliar object is made of, and return it as a reusable shape graph. " +
      "Searches the known primitives first and returns an existing one when it matches, so this is " +
      "always safe to call -- it will not reinvent something already known.",
    locus: "server",
    argsSchema: z.object({
      name: z.string().min(1).describe("The object's name, e.g. 'nephron'."),
      description: z.string().min(1).describe("What it is, in a sentence."),
    }),
    handler: async (args, ctx) => {
      // The search is not the caller's responsibility (V10). Recording it here
      // is what makes "consulted before generating" visible in the trace rather
      // than a claim in a comment.
      workspace.recordSearch(args.name);
      const result = await generatePrimitive({
        provider,
        name: args.name,
        description: args.description,
        catalog,
        signal: ctx.signal,
        ...repair,
      });
      if (!result.ok) return result;

      const graph = guarded(ok(result.value.graph), "shape-graph");
      if (!graph.ok) return graph;

      workspace.primitives.set(args.name, result.value.graph);
      return ok({
        graph: result.value.graph,
        reused: result.value.reused,
        searched: result.value.matches.map((match) => ({
          name: match.record.name,
          score: Number(match.score.toFixed(3)),
        })),
      });
    },
  });

  const freeform = defineTool({
    name: "compose_freeform",
    description:
      "Compose a one-off shape out of lines, arcs and curves when no primitive exists and the " +
      "object has no structure worth decomposing. Points are proportions inside the shape's own " +
      "box, between 0 and 1 -- they say nothing about where the shape goes on the board.",
    locus: "server",
    argsSchema: z.object({
      name: z.string().min(1).describe("A semantic name, e.g. 'lightning-bolt'."),
      description: z.string().min(1).describe("What it should look like, in a sentence."),
    }),
    handler: async (args, ctx) => {
      const result = guarded(
        await composeFreeform({
          provider,
          name: args.name,
          description: args.description,
          signal: ctx.signal,
          ...repair,
        }),
        "shape-graph",
        BANNED_FIELDS_UNIT_SPACE,
      );
      if (result.ok) workspace.freeforms.set(result.value.id, result.value);
      return result;
    },
  });

  return [analyze, plan, shapes, compose, validate, search, generate, freeform];
}

/**
 * Validators exposed on their own, for a caller that wants to check an artifact
 * the agent hand-composed without going through the tool surface.
 */
export { validateDiagramAST, validateShapeGraph, validateVisualPlan };
