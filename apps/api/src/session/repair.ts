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
 */
import { runAgent, type ToolRegistry } from "@sketchmind/agent-core";
import type { LLMProvider } from "@sketchmind/llm-provider";
import {
  findingsEqual,
  type CritiqueFinding,
  type RuntimeEventBody,
} from "@sketchmind/shared-types";
import type { ApiConfig } from "../config.js";
import type { SessionRecord } from "./manager.js";

export interface RunRepairOptions {
  readonly sessionId: string;
  readonly findings: readonly CritiqueFinding[];
  readonly provider: LLMProvider;
  readonly registry: ToolRegistry;
  readonly config: ApiConfig;
  readonly record: SessionRecord;
  readonly emit: (event: RuntimeEventBody & { sessionId: string; at: string }) => void;
}

/** What the agent is told. Prose, because that is what it reasons over. */
export function findingsAsGoal(findings: readonly CritiqueFinding[]): string {
  const lines = findings.map((f) => {
    const proposal = f.proposal ? ` Suggested fix: ${describeProposal(f.proposal)}.` : "";
    return `- [${f.severity}] ${f.message}${proposal}`;
  });
  return [
    "A review of the diagram you just drew found these problems:",
    "",
    ...lines,
    "",
    "Fix them by adjusting the diagram and re-running the geometry stages. Change only what the",
    "findings call for; the rest of the diagram was judged correct. If a finding is wrong, say so",
    "and change nothing.",
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

  await runAgent({
    sessionId,
    goal: findingsAsGoal(findings),
    provider: options.provider,
    registry: options.registry,
    locus: "server",
    budget: {
      maxSteps: config.repair.maxSteps,
      maxTokens: config.agentBudget.maxTokens,
      timeoutMs: config.agentBudget.timeoutMs,
    },
    signal: record.controller.signal,
  });
}
