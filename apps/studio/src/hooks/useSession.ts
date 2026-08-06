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

    case "StageStarted":
    case "StageCompleted":
    case "StrokeStarted":
    case "PlaybackPaused":
    case "PlaybackResumed":
    case "VisionCritique":
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

  const flushFrame = useCallback(() => {
    raf.current = null;
    const next = pendingFrame.current;
    pendingFrame.current = null;
    if (next) setState((current) => reduce(current, next));
  }, []);

  const scheduleFrame = useCallback(
    (event: RuntimeEvent) => {
      pendingFrame.current = event;
      if (raf.current !== null) return;
      raf.current = requestAnimationFrame(flushFrame);
    },
    [flushFrame],
  );

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
        } else {
          setState((current) => reduce(current, decoded.value));
        }

        if (TERMINAL.has(decoded.value.type)) close();

        if (decoded.value.type === "SessionCompleted") {
          // Fire-and-forget: a redraw comes from the event stream this session
          // is already reading (`VisionCritique`, then a repair turn's own
          // events), not from this promise settling.
          void startVisionAgent({
            sessionId: id,
            request: userInput,
            visionEnabled,
            signal: controller.signal,
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
          });
        }
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
    [close, scheduleFrame, getBitmap],
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
