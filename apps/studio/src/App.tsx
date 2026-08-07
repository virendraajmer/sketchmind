import { useCallback, useRef, useState, type FormEvent } from "react";
import Whiteboard, { type WhiteboardHandle } from "./components/Whiteboard";
import { Inspector } from "./components/Inspector";
import { TracePanel } from "./components/TracePanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useSession } from "./hooks/useSession";

const BUSY = new Set(["thinking", "drawing"]);

export default function App(): React.JSX.Element {
  const [prompt, setPrompt] = useState("Draw a movable pulley");
  const whiteboard = useRef<WhiteboardHandle>(null);
  const getBitmap = useCallback(async () => {
    if (!whiteboard.current) throw new Error("The whiteboard is not mounted.");
    return whiteboard.current.getBitmap();
  }, []);
  const { state, start, cancel } = useSession(getBitmap);
  const busy = BUSY.has(state.phase);
  const activity = busy ? describeActivity(state.steps[state.steps.length - 1]) : undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!busy && prompt.trim()) void start(prompt.trim());
  };

  return (
    <main className="p-4 flex flex-col gap-4 min-h-screen">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="m-0 text-[18px] tracking-tight font-bold">SketchMind</h1>
        <form onSubmit={submit} className="flex gap-2 flex-1 flex-shrink flex-grow basis-[420px]">
          <input
            aria-label="What should I draw?"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Draw a movable pulley with rope and load"
            disabled={busy}
            className="flex-1 px-[10px] py-[7px] border border-line rounded-md bg-surface font-inherit outline-none transition-colors focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-ink/20 disabled:opacity-45"
          />
          <button
            type="submit"
            disabled={busy || prompt.trim() === ""}
            className="px-[14px] py-[7px] border border-ink rounded-md bg-ink text-surface font-inherit font-medium cursor-pointer outline-none transition-colors enabled:hover:bg-ink/85 focus-visible:ring-2 focus-visible:ring-ink/40 focus-visible:ring-offset-2 disabled:opacity-45 disabled:cursor-default"
          >
            Draw
          </button>
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={!busy}
            className="px-[14px] py-[7px] border border-line rounded-md bg-surface font-inherit cursor-pointer outline-none transition-colors enabled:hover:bg-panel focus-visible:ring-2 focus-visible:ring-ink/20 disabled:opacity-45 disabled:cursor-default"
          >
            Cancel
          </button>
        </form>
        <p className="m-0 flex items-center gap-2 text-muted" role="status">
          {busy ? (
            <span
              aria-hidden="true"
              className="inline-block size-2 animate-pulse rounded-full bg-current"
            />
          ) : null}
          {STATUS[state.phase]}
          {state.strokesDrawn > 0 ? ` · ${state.strokesDrawn} strokes` : ""}
        </p>
        {state.error ? (
          <p role="alert" className="m-0 text-danger">
            {state.error}
          </p>
        ) : null}
      </header>

      <div className="grid grid-cols-1 min-[1100px]:grid-cols-[minmax(0,1fr)_380px] grid-rows-[auto_auto] gap-4 items-start">
        <section className="min-[1100px]:row-span-2">
          <ErrorBoundary>
            <Whiteboard
              ref={whiteboard}
              {...(state.frame ? { frame: state.frame } : {})}
              {...(state.bounds ? { bounds: state.bounds } : {})}
              {...(activity ? { activity } : {})}
            />
          </ErrorBoundary>
        </section>

        <section className="bg-surface border border-line rounded-lg p-3 max-h-[46vh] overflow-auto">
          <h2 className="mt-0 mb-2 text-xs uppercase tracking-wider text-muted font-bold">
            Agent trace
          </h2>
          <TracePanel steps={state.steps} />
        </section>

        <section className="bg-surface border border-line rounded-lg p-3 max-h-[46vh] overflow-auto">
          <h2 className="mt-0 mb-2 text-xs uppercase tracking-wider text-muted font-bold">
            Diagram
          </h2>
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

/**
 * Each stage in the viewer's words, not the tool's. The agent chooses its own
 * stages (AD-1), so this is a lookup with a fallback rather than a progress bar
 * -- there is no fixed number of steps to be a fraction of.
 */
const ACTIVITY: Record<string, string> = {
  analyze_intent: "Working out what you asked for…",
  plan_visual: "Planning the picture…",
  build_shape_graph: "Working out what it is made of…",
  compose_diagram_ast: "Composing the diagram…",
  validate_diagram: "Checking the diagram…",
  search_primitives: "Looking for shapes it already knows…",
  generate_primitive: "Working out a new shape…",
  compose_freeform: "Drawing out the shape…",
  recall: "Remembering…",
  learn: "Remembering this for next time…",
  forget: "Clearing a memory…",
  derive_constraints: "Working out how the parts relate…",
  solve_layout: "Arranging it on the board…",
  critique_diagram: "Checking its own work…",
  plan_strokes: "Planning the strokes…",
};

function describeActivity(step: { toolName?: string } | undefined): string {
  if (!step?.toolName) return "Thinking…";
  return ACTIVITY[step.toolName] ?? `${step.toolName.replace(/_/g, " ")}…`;
}
