"use client";

/**
 * The agent trace, live.
 *
 * This is the primary debugging surface for an autonomous agent (AD-8): what it
 * thought, what it called, what came back, and what it cost. It renders as the
 * run happens rather than after, which is the difference between watching a
 * decision and reading about one.
 *
 * Tool results are truncated. A `plan_strokes` result is a summary, but a failed
 * validation carries every error at once, and an unbounded panel scrolls the
 * useful part off the top.
 */
import type { AgentTraceStep } from "@sketchmind/shared-types";

const MAX_RESULT_CHARS = 400;

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text;
}

export function TracePanel({ steps }: { steps: readonly AgentTraceStep[] }): React.JSX.Element {
  if (steps.length === 0) {
    return <p className="empty">No steps yet.</p>;
  }

  return (
    <ol className="trace">
      {steps.map((step) => (
        <li key={step.stepId} className={step.error ? "step step-error" : "step"}>
          <header>
            <span className="tool">{step.toolName ?? "answered"}</span>
            <span className="cost">
              {Math.round(step.durationMs)}ms · {step.tokensIn}/{step.tokensOut} tok
            </span>
          </header>

          {step.thought ? <p className="thought">{step.thought}</p> : null}

          {step.toolArgs ? <pre className="args">{preview(step.toolArgs)}</pre> : null}

          {step.error ? (
            <p className="error">
              {step.error.code}: {step.error.message}
            </p>
          ) : step.toolResult === undefined ? null : (
            <pre className="result">{preview(step.toolResult)}</pre>
          )}
        </li>
      ))}
    </ol>
  );
}
