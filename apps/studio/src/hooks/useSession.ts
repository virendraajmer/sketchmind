/**
 * One drawing session, as React state.
 *
 * The whole client side of the protocol is here: start a session, open its
 * stream, fold each event into state, cancel. Everything below is presentation.
 *
 * Events are *validated*, not cast. `decodeServerEvent` returns a
 * `ValidationResult`, and the exhaustive `switch` in `reduce` is only sound
 * because of it -- `JSON.parse` would give the same TypeScript types with none
 * of the guarantee.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { decodeServerEvent, type RuntimeEvent } from "@sketchmind/session-protocol";
import type {
  AgentTraceStep,
  BoundingBox,
  DiagramAST,
  DrawingFrame,
} from "@sketchmind/shared-types";
import { encodeCapture } from "../vision/captureClient.js";
import { startVisionAgent } from "../vision/bootstrap.js";

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:3001";

/** How long to wait for the stream to open before treating the server as unreachable. */
const CONNECT_TIMEOUT_MS = 10_000;

function describeNetworkError(error: unknown): string {
  return error instanceof Error
    ? `Could not reach the server: ${error.message}`
    : "Could not reach the server.";
}

export type SessionPhase = "idle" | "thinking" | "drawing" | "done" | "failed" | "cancelled";

export interface SessionState {
  readonly phase: SessionPhase;
  readonly sessionId?: string;
  /** Newest last. The trace panel renders these in order. */
  readonly steps: readonly AgentTraceStep[];
  readonly ast?: DiagramAST;
  readonly frame?: DrawingFrame;
  /** Extent of the whole drawing, for fitting the viewport once. */
  readonly bounds?: BoundingBox;
  readonly strokesDrawn: number;
  readonly error?: string;
  /** Carried from `SessionStarted` -- whether the vision agent may even try to run. */
  readonly visionEnabled: boolean;
}

const IDLE: SessionState = { phase: "idle", steps: [], strokesDrawn: 0, visionEnabled: false };

function reduce(state: SessionState, event: RuntimeEvent): SessionState {
  switch (event.type) {
    case "SessionStarted":
      return { ...IDLE, phase: "thinking", sessionId: event.sessionId, visionEnabled: event.visionEnabled };

    case "AgentStep":
      return {
        ...state,
        steps: [
          ...state.steps,
          {
            stepId: event.stepId,
            locus: event.locus,
            ...(event.thought === undefined ? {} : { thought: event.thought }),
            ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
            ...(event.toolArgs === undefined ? {} : { toolArgs: event.toolArgs }),
            ...(event.toolResult === undefined ? {} : { toolResult: event.toolResult }),
            ...(event.error === undefined ? {} : { error: event.error }),
            tokensIn: event.tokensIn ?? 0,
            tokensOut: event.tokensOut ?? 0,
            durationMs: event.durationMs ?? 0,
            timestamp: event.at,
          },
        ],
      };

    case "DiagramASTReady":
      return { ...state, ast: event.ast };

    case "FrameUpdate":
      return {
        ...state,
        phase: "drawing",
        frame: event.frame,
        bounds: state.bounds ?? event.bounds,
      };

    case "StrokeCompleted":
      return { ...state, strokesDrawn: state.strokesDrawn + 1 };

    case "SessionCompleted":
      return { ...state, phase: "done" };

    case "SessionFailed":
      return { ...state, phase: "failed", error: event.error.message };

    case "SessionCancelled":
      return { ...state, phase: "cancelled" };

    /**
     * Critique is folded into the same trace the agent's own steps use rather
     * than getting a panel of its own: a critique round *is* a thing that
     * happened in the run, in sequence with the steps around it, and the
     * acceptance criterion is only that findings "appear in the trace panel
     * tagged with their tier". `accepted` is the part a viewer actually needs
     * -- it separates "the agent is redrawing because of this" from "the agent
     * looked and decided not to".
     *
     * The synthetic `stepId` is namespaced away from `agent-core`'s
     * `${sessionId}-${n}` ids so it cannot collide with a real step's React key.
     */
    case "VisionCritique":
      return {
        ...state,
        steps: [
          ...state.steps,
          {
            stepId: `critique-${state.steps.length}-${event.at}`,
            locus: "server",
            toolName: `critique (${event.tier})`,
            thought: event.accepted
              ? `${event.findings.length} finding(s) accepted — repairing.`
              : `${event.findings.length} finding(s) not acted on.`,
            toolResult: event.findings,
            tokensIn: 0,
            tokensOut: 0,
            durationMs: 0,
            timestamp: event.at,
          },
        ],
      };

    case "StageStarted":
    case "StageCompleted":
    case "StrokeStarted":
    case "PlaybackPaused":
    case "PlaybackResumed":
      return state;
  }
}

export interface Session {
  readonly state: SessionState;
  start: (userInput: string) => Promise<void>;
  cancel: () => Promise<void>;
}

/**
 * `getBitmap` is how the vision agent's capture tool reaches the rendered
 * canvas -- see `WhiteboardHandle` in `components/Whiteboard.tsx`. Optional so
 * this hook stays testable (and usable) without a live canvas at all: when it
 * is absent, or the caller never wires a `Whiteboard` ref, capture simply fails
 * and the agent reports nothing, which is a safe, silent outcome (Task 12).
 */
export function useSession(getBitmap?: () => Promise<ImageBitmap>): Session {
  const [state, setState] = useState<SessionState>(IDLE);
  const source = useRef<EventSource | null>(null);
  const sessionId = useRef<string | undefined>(undefined);
  const visionController = useRef<AbortController | null>(null);

  // A burst of `FrameUpdate`s (the runtime ticks far faster than the display
  // refreshes) must cost one paint, not one `setState` each -- see Task 12's
  // brief. Every other event type still applies immediately: they are rare and
  // some (SessionCompleted, SessionFailed) gate behaviour that must not wait a
  // frame.
  const pendingFrame = useRef<RuntimeEvent | null>(null);
  const raf = useRef<number | null>(null);

  const applyPendingFrame = useCallback(() => {
    const next = pendingFrame.current;
    pendingFrame.current = null;
    if (next) setState((current) => reduce(current, next));
  }, []);

  const flushFrame = useCallback(() => {
    raf.current = null;
    applyPendingFrame();
  }, [applyPendingFrame]);

  const scheduleFrame = useCallback(
    (event: RuntimeEvent) => {
      pendingFrame.current = event;
      if (raf.current !== null) return;
      raf.current = requestAnimationFrame(flushFrame);
    },
    [flushFrame],
  );

  /**
   * Cancels any pending rAF and applies its frame *now*, synchronously.
   * Needed wherever a non-`FrameUpdate` event might land in the same tick as
   * a still-pending `FrameUpdate` (most importantly a terminal event right
   * behind the drawing's last frame) -- otherwise `close()` nulling
   * `pendingFrame` would silently drop it, and applying it *after* a later
   * event's own `reduce` would let `FrameUpdate`'s `phase: "drawing"`
   * clobber a phase (e.g. `"done"`) that logically came after it (Task 12
   * review findings #2).
   */
  const flushPendingFrame = useCallback(() => {
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    applyPendingFrame();
  }, [applyPendingFrame]);

  /**
   * The client agent's steps, into the same `steps` list the server's go into.
   * They never cross the wire (the loop runs here), so this callback is the only
   * route they have to the trace panel -- without it the client locus is the one
   * agent in the system with no trace at all.
   *
   * The id is prefixed because `agent-core` numbers steps `${sessionId}-${n}`
   * per run and both loci run under the *same* session id, so the client's first
   * step would otherwise collide with the server's first step as a React key.
   */
  const appendClientStep = useCallback((step: AgentTraceStep) => {
    setState((current) => ({
      ...current,
      steps: [...current.steps, { ...step, stepId: `client-${step.stepId}` }],
    }));
  }, []);

  const close = useCallback(() => {
    source.current?.close();
    source.current = null;
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    pendingFrame.current = null;
  }, []);

  useEffect(() => close, [close]);
  useEffect(() => () => visionController.current?.abort(), []);

  const start = useCallback(
    async (userInput: string) => {
      close();
      setState({ ...IDLE, phase: "thinking" });
      visionController.current?.abort();
      visionController.current = new AbortController();
      const controller = visionController.current;

      let response: Response;
      try {
        response = await fetch(`${API}/api/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userInput }),
        });
      } catch (error) {
        setState({ ...IDLE, phase: "failed", error: describeNetworkError(error) });
        return;
      }

      if (!response.ok) {
        setState({ ...IDLE, phase: "failed", error: `The server refused the request (${response.status}).` });
        return;
      }

      let id: string;
      try {
        ({ sessionId: id } = (await response.json()) as { sessionId: string });
      } catch {
        setState({ ...IDLE, phase: "failed", error: "The server's response could not be read." });
        return;
      }
      sessionId.current = id;

      // Captured locally rather than read back off `state`: the closures below
      // run long after this call to `start` returned, so `state` here would
      // still be whatever it was at call time (stale) -- the `SessionStarted`
      // event is the only source of truth for this session's gate.
      let visionEnabled = false;

      const stream = new EventSource(`${API}/api/sessions/${id}/stream`);
      source.current = stream;

      // A server that never answers (down, wrong URL, blocked by CORS) leaves a
      // native EventSource silently retrying forever with no error the app can
      // see. Without a bound here the UI would say "Thinking..." indefinitely.
      const connectTimeout = setTimeout(() => {
        if (stream.readyState !== EventSource.OPEN) {
          close();
          setState((current) => ({
            ...current,
            phase: "failed",
            error: "The server did not respond in time.",
          }));
        }
      }, CONNECT_TIMEOUT_MS);

      stream.onmessage = (message: MessageEvent<string>) => {
        clearTimeout(connectTimeout);
        const decoded = decodeServerEvent(`data: ${message.data}\n\n`);
        if (!decoded.ok) return;

        if (decoded.value.type === "SessionStarted") {
          visionEnabled = decoded.value.visionEnabled;
        }

        if (decoded.value.type === "FrameUpdate") {
          scheduleFrame(decoded.value);
          return;
        }

        // Any `FrameUpdate` still batched in a pending rAF must land *before*
        // this event's own reduce -- otherwise a terminal event arriving in
        // the same tick as the drawing's last frame would lose it (dropped by
        // `close()`) or have it applied afterward, clobbering this event's
        // phase with `FrameUpdate`'s unconditional `phase: "drawing"`.
        flushPendingFrame();
        setState((current) => reduce(current, decoded.value));

        if (!TERMINAL.has(decoded.value.type)) return;

        if (decoded.value.type === "SessionCompleted" && visionEnabled) {
          // The stream must stay open past this session's own terminal event:
          // `VisionCritique` and a repair turn's own step/frame events arrive
          // on this same stream, emitted server-side only after
          // `/api/sessions/:id/findings` is called below. Closing here would
          // mean the UI can never observe them. Close once the vision agent's
          // run has settled instead -- its own repair loop and findings
          // reporting already bound how long that takes (AD-2).
          startVisionAgent({
            sessionId: id,
            request: userInput,
            visionEnabled,
            apiBase: API,
            signal: controller.signal,
            onStep: appendClientStep,
            capture: async () => {
              if (!getBitmap) {
                return { ok: false, errors: [] };
              }
              const worker = new Worker(
                new URL("../workers/capture.worker.ts", import.meta.url),
                { type: "module" },
              );
              try {
                return await encodeCapture({ worker, toBitmap: getBitmap });
              } finally {
                worker.terminate();
              }
            },
          })
            .catch((error: unknown) => {
              // Abort is the expected path here, not a failure: `signal` is
              // aborted deliberately on unmount and on the next `start()`.
              if (controller.signal.aborted) return;
              // Last-resort visibility for a genuinely unexpected failure;
              // the vision agent's own repair loop and findings reporting
              // already handle its in-band error paths (AD-2), so this is
              // the out-of-band case.
              console.error("[studio] vision agent run failed:", error);
            })
            .finally(() => {
              // `close()` reads `source.current` fresh, not the `stream`
              // this deferred close was scheduled for -- if a later
              // `start()` call already replaced `source.current` with a new
              // session's EventSource by the time this settles, closing
              // through the shared `close()` would silently tear down that
              // *other* session's live stream instead of this (already
              // superseded) one. Guard on identity: only close if the ref
              // still points at the stream this deferred close belongs to.
              if (source.current === stream) close();
            });
          return;
        }

        close();
      };

      stream.onerror = () => {
        if (stream.readyState === EventSource.CLOSED) {
          clearTimeout(connectTimeout);
          setState((current) =>
            current.phase === "done" || current.phase === "cancelled"
              ? current
              : { ...current, phase: "failed", error: "The connection to the server was lost." },
          );
        }
      };
    },
    [close, scheduleFrame, flushPendingFrame, appendClientStep, getBitmap],
  );

  const cancel = useCallback(async () => {
    const id = sessionId.current;
    if (!id) return;
    try {
      await fetch(`${API}/api/sessions/${id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "cancelled by the viewer" }),
      });
    } catch (error) {
      setState((current) => ({ ...current, error: describeNetworkError(error) }));
    }
  }, []);

  return { state, start, cancel };
}

const TERMINAL = new Set<RuntimeEvent["type"]>([
  "SessionCompleted",
  "SessionFailed",
  "SessionCancelled",
]);
