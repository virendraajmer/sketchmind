/**
 * Running one tool call, and never throwing while doing it (AD-2, D-3).
 *
 * The whole robustness story of the agent lives in this file. Four things can go
 * wrong -- the tool does not exist, the arguments do not validate, the handler
 * throws, or the handler reports its own structured failure -- and all four come
 * back as a `ToolOutcome` the model reads on its next step. None of them unwind
 * the loop.
 *
 * The docs (V09, V17) said invalid output must halt the pipeline. That is right
 * for a pipeline and wrong for an agent: "your AST has an orphan object at
 * `rope_2`" is the single most useful thing we could tell it, and halting throws
 * that away.
 */
import {
  errorsFromZod,
  makeError,
  type SketchMindError,
  type ValidationResult,
} from "@sketchmind/shared-types";
import type { ToolCall } from "@sketchmind/llm-provider";
import type { ToolContext, ToolDefinition, ToolRegistry } from "../tools.js";

const PACKAGE = "@sketchmind/agent-core";

/**
 * A ceiling on how much of a tool result reaches the model.
 *
 * Not arbitrary caution: a tool that returns a whole `LayoutModel` can cost more
 * tokens than every reasoning step around it, and the token budget (AD-8) is
 * enforced against real usage. Truncation is announced in the text so the model
 * never reasons about data it cannot see.
 */
export const DEFAULT_MAX_RESULT_CHARS = 8_000;

export interface ExecuteOptions {
  readonly maxResultChars?: number;
}

export interface ToolOutcome {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly ok: boolean;
  /** Present when `ok`. The handler's return value, unwrapped. */
  readonly result?: unknown;
  /** Present when not `ok`. Every problem found, not just the first. */
  readonly errors?: readonly SketchMindError[];
  /** What actually goes back to the model, as a string (llm-provider D-1). */
  readonly content: string;
  /** True when the run was cancelled rather than the tool having failed. */
  readonly cancelled: boolean;
}

function agentError(
  code: string,
  message: string,
  options: { recoverable?: boolean; path?: string; details?: Record<string, unknown> } = {},
): SketchMindError {
  return makeError({
    code,
    message,
    package: PACKAGE,
    stage: "agent",
    recoverable: options.recoverable ?? true,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.details === undefined ? {} : { details: options.details }),
  });
}

/** Render errors the way a model reads best: one problem per line, with paths. */
function errorsAsText(errors: readonly SketchMindError[]): string {
  return errors.map((e) => `- ${e.path ? `${e.path}: ` : ""}${e.message}`).join("\n");
}

function failure(
  call: ToolCall,
  errors: readonly SketchMindError[],
  heading: string,
  cancelled = false,
): ToolOutcome {
  return {
    toolCallId: call.id,
    toolName: call.name,
    ok: false,
    errors,
    content: `${heading}\n${errorsAsText(errors)}`,
    cancelled,
  };
}

/**
 * A handler may return a `ValidationResult` -- that is the shape every existing
 * validator in the repo already produces, so accepting it directly means Phase 5
 * can expose `validateDiagramAST` as a tool with no adapter code.
 */
function isValidationResult(value: unknown): value is ValidationResult<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { ok?: unknown; errors?: unknown; value?: unknown };
  if (candidate.ok === true) return "value" in candidate;
  return candidate.ok === false && Array.isArray(candidate.errors);
}

function serialize(value: unknown, maxChars: number): { ok: true; text: string } | { ok: false } {
  let text: string;
  try {
    text = value === undefined ? "null" : JSON.stringify(value);
  } catch {
    return { ok: false };
  }
  // `JSON.stringify` returns undefined for a bare function or symbol.
  if (text === undefined) return { ok: false };
  if (text.length <= maxChars) return { ok: true, text };
  return {
    ok: true,
    text: `${text.slice(0, maxChars)}\n\n[truncated: result was ${text.length} characters, limit ${maxChars}]`,
  };
}

export async function executeToolCall(
  registry: ToolRegistry,
  call: ToolCall,
  context: Omit<ToolContext, "toolCallId">,
  options: ExecuteOptions = {},
): Promise<ToolOutcome> {
  const maxChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;

  if (context.signal.aborted) {
    return failure(
      call,
      [
        agentError("TOOL_CANCELLED", "The run was cancelled before this tool ran.", {
          // The one non-recoverable failure here: retrying is precisely what the
          // caller asked us to stop doing.
          recoverable: false,
        }),
      ],
      `Tool "${call.name}" did not run.`,
      true,
    );
  }

  const tool: ToolDefinition | undefined = registry.get(call.name);
  if (tool === undefined) {
    const available = registry.names();
    return failure(
      call,
      [
        agentError("TOOL_NOT_FOUND", `No tool named "${call.name}".`, {
          details: { available },
        }),
      ],
      `Tool "${call.name}" does not exist. Available tools: ${available.join(", ") || "(none)"}.`,
    );
  }

  const parsed = tool.argsSchema.safeParse(call.arguments);
  if (!parsed.success) {
    return failure(
      call,
      errorsFromZod(parsed.error, { package: PACKAGE, stage: "agent" }),
      `Arguments for "${call.name}" were invalid. Fix every problem and call it again.`,
    );
  }

  let raw: unknown;
  try {
    raw = await tool.handler(parsed.data, { ...context, toolCallId: call.id });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return failure(
      call,
      [
        agentError("TOOL_THREW", message, {
          details: { tool: call.name, name: cause instanceof Error ? cause.name : typeof cause },
        }),
      ],
      `Tool "${call.name}" failed.`,
    );
  }

  if (isValidationResult(raw)) {
    if (!raw.ok) {
      // Verbatim: these already carry the code and path the agent needs, and
      // rewrapping them would destroy exactly that.
      return failure(call, raw.errors, `Tool "${call.name}" reported problems to fix.`);
    }
    raw = raw.value;
  }

  const serialized = serialize(raw, maxChars);
  if (!serialized.ok) {
    return failure(
      call,
      [
        agentError(
          "TOOL_RESULT_UNSERIALIZABLE",
          `Tool "${call.name}" returned a value that cannot be sent to the model ` +
            `(circular reference or non-JSON value).`,
        ),
      ],
      `Tool "${call.name}" produced an unusable result.`,
    );
  }

  return {
    toolCallId: call.id,
    toolName: call.name,
    ok: true,
    result: raw,
    content: serialized.text,
    cancelled: false,
  };
}
