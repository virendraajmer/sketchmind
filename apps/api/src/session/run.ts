/**
 * One drawing session, end to end: assemble the tool surfaces, run the agent,
 * then play the sequence it planned.
 *
 * This is the file the whole architecture converges on, and it is deliberately
 * short. All three tool packages register into **one** registry and the agent
 * makes one continuous run across them -- it is not a reasoning phase followed
 * by a geometry phase, because AD-1's point is that the model decides which
 * stages a given request needs. `compose_diagram_ast` and `solve_layout` are
 * peers in the same catalogue.
 *
 * The two workspaces know nothing about each other. `getAst` is the whole join.
 *
 * Playback is a fixed-step pump, not a timer inside the runtime (D-8): the
 * runtime is a pure function of (strokes, timeMs), so the server advances it at
 * whatever rate it likes and the client redraws from the frames. That is also
 * what makes cancellation exact -- the loop simply stops advancing.
 */
import { ToolRegistry, runAgent } from "@sketchmind/agent-core";
import {
  LexicalEmbedder,
  SessionMemory,
  createMemoryTools,
  type MemoryStore,
} from "@sketchmind/agent-memory";
import {
  ReasoningWorkspace,
  createReasoningTools,
  memoryCatalog,
} from "@sketchmind/agent-tools-reasoning";
import { GeometryWorkspace, createGeometryTools } from "@sketchmind/agent-tools-geometry";
import { createVisionTools, critiqueGeometry } from "@sketchmind/agent-vision";
import type { LLMProvider } from "@sketchmind/llm-provider";
import { createStrokeRuntime } from "@sketchmind/stroke-runtime";
import {
  makeError,
  type AgentTraceStep,
  type RuntimeEvent,
  type RuntimeEventBody,
  type SketchMindError,
  type StrokeAST,
} from "@sketchmind/shared-types";
import type { ApiConfig } from "../config.js";
import type { SessionRecord } from "./manager.js";
import { sessionSystemPrompt } from "./prompt.js";
import { runRepair } from "./repair.js";

const PACKAGE = "@sketchmind/api";

export interface RunSessionOptions {
  readonly sessionId: string;
  readonly userInput: string;
  readonly provider: LLMProvider;
  readonly store: MemoryStore;
  readonly config: ApiConfig;
  readonly signal: AbortSignal;
  readonly emit: (event: RuntimeEvent) => void;
  /** Where the automatic critique pass and a later repair turn keep state. */
  readonly record: SessionRecord;
  /** Injected so tests advance playback without waiting in real time. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => string;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSession(options: RunSessionOptions): Promise<void> {
  const { sessionId, userInput, provider, store, config, signal } = options;
  const sleep = options.sleep ?? wait;
  const now = options.now ?? (() => new Date().toISOString());

  const emit = (event: RuntimeEventBody): void => {
    options.emit({ ...event, sessionId, at: now() } as RuntimeEvent);
  };

  emit({ type: "SessionStarted", userInput });

  const embedder = new LexicalEmbedder();
  const memory = new SessionMemory({ sessionId, request: userInput });
  const reasoning = new ReasoningWorkspace();
  const geometry = new GeometryWorkspace();

  const registry = new ToolRegistry([
    ...createReasoningTools({ provider, workspace: reasoning, catalog: memoryCatalog(store, embedder) }),
    ...createGeometryTools({ workspace: geometry, getAst: () => reasoning.ast }),
    ...createVisionTools({
      getAst: () => reasoning.ast,
      getLayout: () => geometry.layout,
      getStrokes: () => geometry.strokeAST,
    }),
    ...createMemoryTools({ store, embedder }),
  ]);

  // The AST is announced the moment it exists, not when the run ends: the
  // inspector should fill in while layout is still being solved.
  let announcedAst = false;
  const onStep = (step: AgentTraceStep): void => {
    emit({
      type: "AgentStep",
      stepId: step.stepId,
      locus: step.locus,
      ...(step.thought === undefined ? {} : { thought: step.thought }),
      ...(step.toolName === undefined ? {} : { toolName: step.toolName }),
      ...(step.toolArgs === undefined ? {} : { toolArgs: step.toolArgs }),
      ...(step.toolResult === undefined ? {} : { toolResult: step.toolResult }),
      ...(step.error === undefined ? {} : { error: step.error }),
      tokensIn: step.tokensIn,
      tokensOut: step.tokensOut,
      durationMs: step.durationMs,
    });

    if (step.toolName) {
      memory.note(step.error ? "failed" : "planned", `${step.toolName}: ${step.error?.message ?? "ok"}`);
    }

    if (!announcedAst && reasoning.ast) {
      announcedAst = true;
      emit({ type: "DiagramASTReady", ast: reasoning.ast });
    }
  };

  const result = await runAgent({
    sessionId,
    goal: userInput,
    provider,
    registry,
    locus: "server",
    systemPrompt: sessionSystemPrompt(memory.toPromptText()),
    budget: config.agentBudget,
    signal,
    onStep,
  });

  if (signal.aborted) {
    emit({ type: "SessionCancelled", reason: "cancelled before drawing began" });
    return;
  }

  if (result.status === "failed") {
    emit({ type: "SessionFailed", error: result.error ?? unknownFailure(result.stopReason) });
    return;
  }

  const strokes = geometry.strokeAST;
  if (!strokes || strokes.strokes.length === 0) {
    // The agent stopped without planning strokes. That is a real outcome --
    // budget exhausted, or the model decided it was done too early -- and the
    // viewer is owed the reason rather than an empty board.
    emit({ type: "SessionFailed", error: nothingToDraw(result.stopReason, result.output) });
    return;
  }

  // The free tier runs on every diagram before a single stroke is drawn. This
  // is the pass that makes "the agent checks its own work" true even with the
  // image tier switched off, and it costs nothing to be sure of.
  const layout = geometry.layout;
  if (config.vision.geometric && reasoning.ast && layout) {
    options.record.layoutSummary =
      `${layout.nodes.length} objects (${layout.nodes.map((n) => n.objectId).join(", ")}), ` +
      `${layout.connectors.length} connectors, ${layout.labels.length} labels`;

    const findings = critiqueGeometry({ ast: reasoning.ast, layout, strokes });
    if (findings.length > 0) {
      await runRepair({
        sessionId,
        findings,
        provider,
        registry,
        config,
        record: options.record,
        emit: options.emit,
      });
    }
  }

  // Repair may have replaced the plan; draw whatever the workspace now holds.
  const finalStrokes = geometry.strokeAST ?? strokes;

  // Handed to the client agent and to a later repair turn.
  options.record.registry = registry;

  await play({ ...options, strokes: finalStrokes, sleep, now });
}

interface PlayOptions {
  readonly sessionId: string;
  readonly strokes: StrokeAST;
  readonly config: ApiConfig;
  readonly signal: AbortSignal;
  readonly emit: (event: RuntimeEvent) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => string;
}

/**
 * Pump the runtime and forward what it emits.
 *
 * The runtime's own events (`StrokeStarted`, `StrokeCompleted`,
 * `SessionCancelled`) are already `RuntimeEvent`s stamped with this session id,
 * so they are forwarded untouched -- the protocol between the runtime and the
 * browser needed no adapter, which is why `RuntimeEvent` lives in
 * `shared-types` rather than being invented at the wire.
 */
async function play(options: PlayOptions): Promise<void> {
  const { sessionId, strokes, config, signal, sleep, now } = options;

  const emit = (event: RuntimeEventBody): void => {
    options.emit({ ...event, sessionId, at: now() } as RuntimeEvent);
  };

  const created = createStrokeRuntime(strokes, { sessionId, now });
  if (!created.ok) {
    emit({ type: "SessionFailed", error: created.errors[0] ?? unknownFailure("provider-error") });
    return;
  }

  const runtime = created.value;
  const unsubscribe = runtime.subscribe((event) => options.emit(event));
  const startedAt = Date.now();

  try {
    runtime.play();
    while (runtime.state().status === "playing") {
      if (signal.aborted) {
        // Cancelling the runtime emits `SessionCancelled` itself, which is the
        // terminal event -- no second one is needed or wanted.
        runtime.cancel("cancelled by the viewer");
        return;
      }
      runtime.advance(config.tickMs);
      emit({
        type: "FrameUpdate",
        frame: runtime.frame(),
        ...(strokes.bounds ? { bounds: strokes.bounds } : {}),
      });
      await sleep(config.tickMs);
    }
    emit({ type: "SessionCompleted", durationMs: Date.now() - startedAt });
  } finally {
    unsubscribe();
  }
}

function unknownFailure(stopReason: string): SketchMindError {
  return makeError({
    code: "SESSION_FAILED",
    message: `The session stopped without completing (${stopReason}).`,
    package: PACKAGE,
    stage: "agent",
    recoverable: false,
  });
}

function nothingToDraw(stopReason: string, output: string): SketchMindError {
  return makeError({
    code: "SESSION_NO_STROKES",
    message:
      `The agent finished (${stopReason}) without planning any strokes, so there is nothing ` +
      `to draw.${output ? ` It said: ${output}` : ""}`,
    package: PACKAGE,
    stage: "stroke",
    recoverable: true,
  });
}
