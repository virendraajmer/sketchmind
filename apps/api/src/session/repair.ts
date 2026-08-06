/**
 * One bounded repair turn.
 *
 * The findings become the goal of a fresh `runAgent` over the **same registry**
 * the session already had. That is the whole design: the agent repairs by
 * calling the tools it already knows -- edit the AST, re-derive constraints,
 * re-solve layout, re-plan strokes -- so there is never a second way to author
 * geometry, and the solver stays the only thing that produces a number.
 *
 * Three guards, all of which must hold, and any of which ending the loop:
 * empty findings, the round cap, and findings identical to last round's. The
 * third is the one that stops oscillation -- an agent that "fixes" something
 * into the same state forever is the failure mode a budget alone does not catch.
 *
 * A fourth thing is not a guard but a check on the round that did run: the
 * repair agent can call `solve_layout` and then stop -- budget exhausted, or
 * it thinks it is done -- without ever reaching `plan_strokes`. Nothing about
 * that failure mode trips the three guards above; `accepted: true` has already
 * gone out, and the picture on screen is unchanged. So after the turn, the
 * stroke accessor is compared by reference to what it was before: unchanged
 * means `plan_strokes` never ran, and that is reported the same way a finding
 * is, rather than left for the viewer to notice the drawing never moved.
 */
import { randomUUID } from "node:crypto";
import { runAgent, type ToolRegistry } from "@sketchmind/agent-core";
import type { LLMProvider } from "@sketchmind/llm-provider";
import {
  findingsEqual,
  type CritiqueFinding,
  type CritiqueTier,
  type DiagramAST,
  type RuntimeEventBody,
  type StrokeAST,
} from "@sketchmind/shared-types";
import type { ApiConfig } from "../config.js";
import type { SessionRecord } from "./manager.js";
import { sessionSystemPrompt } from "./prompt.js";
import { stepEvent } from "./trace.js";

export interface RunRepairOptions {
  readonly sessionId: string;
  readonly findings: readonly CritiqueFinding[];
  readonly provider: LLMProvider;
  readonly registry: ToolRegistry;
  readonly config: ApiConfig;
  readonly record: SessionRecord;
  /** How this round reads the live AST and stroke plan, to detect a stale plan and re-announce a rewritten AST. */
  readonly getAst: () => DiagramAST | undefined;
  readonly getStrokes: () => StrokeAST | undefined;
  readonly emit: (event: RuntimeEventBody & { sessionId: string; at: string }) => void;
}

/** What the agent is told. Prose, because that is what it reasons over. */
export function findingsAsGoal(findings: readonly CritiqueFinding[], request?: string): string {
  const lines = findings.map((f) => {
    const proposal = f.proposal ? ` Suggested fix: ${describeProposal(f.proposal)}.` : "";
    return `- [${f.severity}] ${f.message}${proposal}`;
  });
  return [
    ...(request ? [`The original request was: "${request}".`, ""] : []),
    "A review of the diagram you just drew found these problems:",
    "",
    ...lines,
    "",
    "Fix them by calling whatever tools the fix needs -- compose_diagram_ast, derive_constraints,",
    "solve_layout -- and then call plan_strokes. Nothing reaches the whiteboard until plan_strokes",
    "runs again: stopping before it leaves the drawing exactly as it was, even though this repair",
    "round will be counted as spent. Change only what the findings call for; the rest of the",
    "diagram was judged correct. If a finding is wrong, say so and change nothing.",
  ].join("\n");
}

function describeProposal(proposal: NonNullable<CritiqueFinding["proposal"]>): string {
  switch (proposal.kind) {
    case "add_missing_component":
      return `add ${proposal.description}`;
    case "reposition_label":
      return `reposition label "${proposal.labelId}" — ${proposal.hint}`;
    default:
      return `${proposal.kind.replace("_", " ")} "${proposal.objectId}" — ${proposal.hint}`;
  }
}

/** A finding-shaped way to say "the repair round did not reach the whiteboard". */
function stalePlanFinding(tier: CritiqueTier): CritiqueFinding {
  return {
    id: `repair-incomplete-${randomUUID()}`,
    tier,
    check: "repair-incomplete",
    severity: "warning",
    message:
      "The repair turn ran but never called plan_strokes, so the drawing on screen is unchanged " +
      "from before the repair even though the round was spent.",
    objectIds: [],
  };
}

export async function runRepair(options: RunRepairOptions): Promise<void> {
  const { findings, record, config, sessionId } = options;
  const at = new Date().toISOString();

  if (findings.length === 0) return;

  if (record.repairRounds >= config.repair.maxRounds) {
    options.emit({
      sessionId,
      at,
      type: "VisionCritique",
      tier: findings[0]!.tier,
      findings: [...findings],
      accepted: false,
    });
    return;
  }

  if (findingsEqual(findings, record.lastFindings)) {
    options.emit({
      sessionId,
      at,
      type: "VisionCritique",
      tier: findings[0]!.tier,
      findings: [...findings],
      accepted: false,
    });
    return;
  }

  record.lastFindings = [...findings];
  record.repairRounds += 1;

  options.emit({
    sessionId,
    at,
    type: "VisionCritique",
    tier: findings[0]!.tier,
    findings: [...findings],
    accepted: true,
  });

  const astBefore = options.getAst();
  const strokesBefore = options.getStrokes();

  const result = await runAgent({
    sessionId,
    goal: findingsAsGoal(findings, record.request),
    provider: options.provider,
    registry: options.registry,
    locus: "server",
    systemPrompt: sessionSystemPrompt(),
    history: record.history,
    budget: {
      maxSteps: config.repair.maxSteps,
      maxTokens: config.agentBudget.maxTokens,
      timeoutMs: config.agentBudget.timeoutMs,
    },
    signal: record.controller.signal,
    onStep: (step) => {
      options.emit({ ...stepEvent(step), sessionId, at: new Date().toISOString() });
    },
  });

  // So the next repair round -- automatic or from a later /findings call --
  // is a continuation of this one, not a stranger with no memory of it.
  record.history = [...result.messages];

  const astAfter = options.getAst();
  if (astAfter && astAfter !== astBefore) {
    options.emit({ sessionId, at: new Date().toISOString(), type: "DiagramASTReady", ast: astAfter });
  }

  if (options.getStrokes() === strokesBefore) {
    options.emit({
      sessionId,
      at: new Date().toISOString(),
      type: "VisionCritique",
      tier: findings[0]!.tier,
      findings: [stalePlanFinding(findings[0]!.tier)],
      accepted: false,
    });
  }
}
