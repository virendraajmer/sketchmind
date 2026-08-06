import type { AgentTraceStep } from "@sketchmind/shared-types";

const MAX_RESULT_CHARS = 400;

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text;
}

export function TracePanel({ steps }: { steps: readonly AgentTraceStep[] }): React.JSX.Element {
  if (steps.length === 0) {
    return <p className="m-0 text-muted">No steps yet.</p>;
  }

  return (
    <ol className="m-0 p-0 list-none flex flex-col gap-2">
      {steps.map((step) => (
        <li
          key={step.stepId}
          className={`border rounded-md p-2 ${step.error ? "border-danger" : "border-line"}`}
        >
          <header className="flex justify-between gap-2">
            <span className="font-mono font-semibold">{step.toolName ?? "answered"}</span>
            <span className="text-muted tabular-nums">
              {Math.round(step.durationMs)}ms · {step.tokensIn}/{step.tokensOut} tok
            </span>
          </header>

          {step.thought ? <p className="mt-[6px] mb-0">{step.thought}</p> : null}

          {step.toolArgs ? (
            <pre className="mt-[6px] mb-0 p-[6px] bg-panel rounded font-mono text-xs whitespace-pre-wrap break-words">
              {preview(step.toolArgs)}
            </pre>
          ) : null}

          {step.error ? (
            <p className="mt-[6px] mb-0 text-danger">
              {step.error.code}: {step.error.message}
            </p>
          ) : step.toolResult === undefined ? null : (
            <pre className="mt-[6px] mb-0 p-[6px] bg-panel rounded font-mono text-xs whitespace-pre-wrap break-words">
              {preview(step.toolResult)}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}
