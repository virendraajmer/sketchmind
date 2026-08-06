"use client";

/**
 * SketchMind's whiteboard.
 *
 * Type a request, watch an agent reason about it and draw it. Three panels:
 * the board, the agent's trace as it happens, and the diagram it composed.
 *
 * `Whiteboard` is loaded browser-only. Konva needs a real canvas, and importing
 * it during Next's server render would drag in `node-canvas`.
 */
import { useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import { Inspector } from "./Inspector";
import { TracePanel } from "./TracePanel";
import { useSession } from "./useSession";

const Whiteboard = dynamic(() => import("./Whiteboard"), {
  ssr: false,
  loading: () => <div className="board board-loading" />,
});

const BUSY = new Set(["thinking", "drawing"]);

export default function Page(): React.JSX.Element {
  const [prompt, setPrompt] = useState("Draw a movable pulley");
  const { state, start, cancel } = useSession();
  const busy = BUSY.has(state.phase);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!busy && prompt.trim()) void start(prompt.trim());
  };

  return (
    <main>
      <header className="top">
        <h1>SketchMind</h1>
        <form onSubmit={submit}>
          <input
            aria-label="What should I draw?"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Draw a movable pulley"
            disabled={busy}
          />
          <button type="submit" disabled={busy || prompt.trim() === ""}>
            Draw
          </button>
          <button type="button" onClick={() => void cancel()} disabled={!busy}>
            Cancel
          </button>
        </form>
        <p className="status" role="status">
          {STATUS[state.phase]}
          {state.strokesDrawn > 0 ? ` · ${state.strokesDrawn} strokes` : ""}
        </p>
        {state.error ? <p className="error">{state.error}</p> : null}
      </header>

      <div className="panels">
        <section className="canvas-panel">
          <Whiteboard
            {...(state.frame ? { frame: state.frame } : {})}
            {...(state.bounds ? { bounds: state.bounds } : {})}
          />
        </section>

        <section className="side">
          <h2>Agent trace</h2>
          <TracePanel steps={state.steps} />
        </section>

        <section className="side">
          <h2>Diagram</h2>
          <Inspector {...(state.ast ? { ast: state.ast } : {})} />
        </section>
      </div>
    </main>
  );
}

const STATUS: Record<string, string> = {
  idle: "Ready.",
  thinking: "Thinking…",
  drawing: "Drawing…",
  done: "Done.",
  failed: "Failed.",
  cancelled: "Cancelled.",
};
