/**
 * The client agent locus.
 *
 * It is a real `agent-core` loop with its own budget and its own signal, not a
 * capture pump -- but a deliberately small one. Frontend cost is main-thread
 * work per frame; an extra model call parallelises nothing and competes for the
 * same thread. So there is exactly one agent here, and the throughput work
 * (encoding, framing, transport) is deterministic code elsewhere.
 *
 * When vision is disabled the capture and critique tools are **not built**.
 * That is stronger than a branch that declines to call them: with nothing in the
 * registry, no image can be captured, encoded, sent or logged, and the guarantee
 * is provable by inspecting the tool list.
 */
import { ToolRegistry, runAgent } from "@sketchmind/agent-core";
import type { LLMProvider } from "@sketchmind/llm-provider";
import type { CapturedImage } from "@sketchmind/renderer-core";
import type { CritiqueFinding, ValidationResult } from "@sketchmind/shared-types";
import { VisionWorkspace, createClientVisionTools } from "./tools-client.js";

const SYSTEM_PROMPT = [
  "You are watching a whiteboard an assistant has just finished drawing, and deciding whether",
  "anything about it needs fixing.",
  "",
  "Take a picture, have it looked at, then judge the findings you get back. Report only the ones",
  "you believe: every finding you report costs the viewer a redraw. If the findings repeat what",
  "you reported before, or if the drawing looks right, report nothing and say so.",
  "",
  "Doing nothing is the correct outcome most of the time.",
].join("\n");

export interface RunVisionAgentOptions {
  readonly sessionId: string;
  /** The user's original request; the drawing is judged against it. */
  readonly request: string;
  readonly provider: LLMProvider;
  readonly capture: () => Promise<ValidationResult<CapturedImage>>;
  readonly critique: (image: CapturedImage) => Promise<CritiqueFinding[]>;
  readonly report: (findings: CritiqueFinding[]) => Promise<void>;
  /** False builds no capture or critique tool at all. */
  readonly visionEnabled: boolean;
  readonly signal: AbortSignal;
  readonly maxRounds?: number;
  readonly maxSteps?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly onStep?: Parameters<typeof runAgent>[0]["onStep"];
}

export interface VisionAgentResult {
  readonly reported: CritiqueFinding[];
  readonly rounds: number;
  readonly stopReason: string;
}

export async function runVisionAgent(
  options: RunVisionAgentOptions,
): Promise<VisionAgentResult> {
  if (!options.visionEnabled) {
    return { reported: [], rounds: 0, stopReason: "vision-disabled" };
  }

  const workspace = new VisionWorkspace();
  const reported: CritiqueFinding[] = [];

  const registry = new ToolRegistry(
    createClientVisionTools({
      workspace,
      capture: options.capture,
      critique: options.critique,
      report: async (findings) => {
        reported.push(...findings);
        await options.report(findings);
      },
    }),
  );

  const result = await runAgent({
    sessionId: options.sessionId,
    goal: `The request was: ${options.request}. Check the board and report anything genuinely wrong.`,
    provider: options.provider,
    registry,
    locus: "client",
    systemPrompt: SYSTEM_PROMPT,
    budget: {
      maxSteps: options.maxSteps ?? 6,
      maxTokens: options.maxTokens ?? 20_000,
      timeoutMs: options.timeoutMs ?? 60_000,
    },
    signal: options.signal,
    ...(options.onStep ? { onStep: options.onStep } : {}),
  });

  return { reported, rounds: 1, stopReason: result.stopReason };
}
