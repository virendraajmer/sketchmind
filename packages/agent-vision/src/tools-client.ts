/**
 * The client agent's three tools.
 *
 * The division of labour is the whole point. `capture_canvas` and
 * `critique_canvas` move bytes; the *judgement* -- is this finding real, is it
 * the same one I reported last round, is it worth a repair -- happens in the
 * agent's reasoning between them. That is what makes this an agent rather than a
 * pipe, and it is why `report_findings` takes a subset instead of forwarding
 * everything it was handed.
 *
 * The image never enters the agent's message history. `capture_canvas` returns
 * dimensions and a byte count; the pixels live in the workspace and travel only
 * to the server. Which is also why `agent-core` needs no multimodal support.
 */
import { defineTool, type ToolDefinition } from "@sketchmind/agent-core";
import type { CapturedImage } from "@sketchmind/renderer-core";
import {
  CritiqueFindingSchema,
  fail,
  makeError,
  ok,
  type CritiqueFinding,
  type ValidationResult,
} from "@sketchmind/shared-types";
import { z } from "zod";

const PACKAGE = "@sketchmind/agent-vision";

export class VisionWorkspace {
  image?: CapturedImage;
  lastFindings: CritiqueFinding[] = [];
}

export interface ClientVisionToolsOptions {
  readonly workspace: VisionWorkspace;
  /** Delegates to the capture worker, so encoding stays off the main thread. */
  readonly capture: () => Promise<ValidationResult<CapturedImage>>;
  readonly critique: (image: CapturedImage) => Promise<CritiqueFinding[]>;
  readonly report: (findings: CritiqueFinding[]) => Promise<void>;
}

function problem(code: string, message: string) {
  return fail([
    makeError({ code, message, package: PACKAGE, stage: "render", recoverable: true }),
  ]);
}

export function createClientVisionTools(
  options: ClientVisionToolsOptions,
): ToolDefinition[] {
  const { workspace } = options;

  const capture = defineTool({
    name: "capture_canvas",
    description:
      "Take a picture of the whiteboard as it currently looks. Returns the picture's size only " +
      "-- you will not see the image yourself. Call this first; critique_canvas works on whatever " +
      "this captured.",
    locus: "client",
    readOnly: true,
    argsSchema: z.object({}),
    handler: async () => {
      const result = await options.capture();
      if (!result.ok) return result;

      workspace.image = result.value;
      return ok({
        width: result.value.width,
        height: result.value.height,
        byteLength: result.value.data.byteLength,
      });
    },
  });

  const critique = defineTool({
    name: "critique_canvas",
    description:
      "Send the captured picture to be looked at, and get back a list of things that appear " +
      "wrong with the drawing. Requires capture_canvas to have run. Findings are suggestions, " +
      "not orders -- read them and decide which are worth acting on.",
    locus: "client",
    readOnly: true,
    argsSchema: z.object({}),
    handler: async () => {
      const image = workspace.image;
      if (!image) {
        return problem("CRITIQUE_NO_IMAGE", "Nothing has been captured yet. Call capture_canvas first.");
      }

      const findings = await options.critique(image);
      workspace.lastFindings = findings;
      return ok({ findings, count: findings.length });
    },
  });

  const reportArgsSchema = z.object({
    findings: z
      .array(CritiqueFindingSchema)
      .max(20)
      .describe("The subset of findings worth repairing."),
  });

  const report = defineTool({
    name: "report_findings",
    description:
      "Send the findings you judge genuine and worth fixing back to the drawing agent, which " +
      "will repair the diagram. Send only the ones you believe: reporting a finding you doubt " +
      "costs a redraw the viewer has to watch. Send none, and the diagram stands as drawn.",
    locus: "client",
    argsSchema: reportArgsSchema,
    handler: async (args) => {
      // The normal path validates via `argsSchema` before the handler ever
      // runs, but a finding is the one payload this agent invents itself out
      // of a model reply -- worth re-checking even if a caller reaches this
      // handler directly.
      const parsed = reportArgsSchema.safeParse(args);
      if (!parsed.success) {
        return problem(
          "REPORT_INVALID_FINDINGS",
          "One or more findings were not well formed and could not be reported.",
        );
      }

      await options.report(parsed.data.findings);
      return ok({ reported: parsed.data.findings.length });
    },
  });

  return [capture, critique, report];
}
