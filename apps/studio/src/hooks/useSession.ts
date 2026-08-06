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
}

const IDLE: SessionState = { phase: "idle", steps: [], strokesDrawn: 0 };

function reduce(state: SessionState, event: RuntimeEvent): SessionState {
  switch (event.type) {
    case "SessionStarted":
      return { ...IDLE, phase: "thinking", sessionId: event.sessionId };

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

export function useSession(): Session {
  const [state, setState] = useState<SessionState>(IDLE);
  const source = useRef<EventSource | null>(null);
  const sessionId = useRef<string | undefined>(undefined);

  const close = useCallback(() => {
    source.current?.close();
    source.current = null;
  }, []);

  useEffect(() => close, [close]);

  const start = useCallback(
    async (userInput: string) => {
      close();
      setState({ ...IDLE, phase: "thinking" });

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
        setState((current) => reduce(current, decoded.value));
        if (TERMINAL.has(decoded.value.type)) close();
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
    [close],
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
