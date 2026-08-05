/**
 * Tool definition and registry (Phase 4, D-2).
 *
 * `shared-types` owns `ToolSpec` -- the serializable half a browser can be sent.
 * This file owns the executable half. The seam was predicted in Phase 2 and is
 * what lets the server hand the client agent a tool catalogue without handing it
 * server code.
 *
 * A tool is declared **once**, in Zod. The JSON Schema the model reads is
 * derived from that same schema, so "the prompt says one thing and the validator
 * checks another" is not a bug this design can express.
 */
import type { Locus, ToolSpec } from "@sketchmind/shared-types";
import type { ToolCallSpec } from "@sketchmind/llm-provider";
import { z, type ZodObject, type ZodRawShape } from "zod";

/**
 * What a handler is given besides its arguments.
 *
 * The signal is here rather than optional because a tool that cannot be
 * cancelled makes the run's cancellation guarantee a lie (AD-8, D-5): a handler
 * that ignores it is awaited to completion and its result discarded, which is
 * survivable, but one that never received it could not have done better.
 */
export interface ToolContext {
  readonly sessionId: string;
  /** Aborted on cancellation, budget deadline, or caller signal -- one signal. */
  readonly signal: AbortSignal;
  /** Which side is executing. A tool may legitimately behave differently. */
  readonly locus: Locus;
  /** The id of the model's call, so handlers can correlate their own logs. */
  readonly toolCallId: string;
}

export type ToolHandler<A> = (args: A, context: ToolContext) => unknown | Promise<unknown>;

export interface ToolDefinitionInput<S extends ZodObject<ZodRawShape>> {
  readonly name: string;
  /** Written for the model, not for a developer: it is the model's only guide. */
  readonly description: string;
  readonly locus: Locus;
  /** True only when the tool changes nothing. Wrong here is worse than absent. */
  readonly readOnly?: boolean;
  readonly argsSchema: S;
  readonly handler: ToolHandler<z.infer<S>>;
}

/** The executable half: `ToolSpec` plus the schema and the code. */
export interface ToolDefinition<S extends ZodObject<ZodRawShape> = ZodObject<ZodRawShape>> {
  readonly name: string;
  readonly description: string;
  readonly locus: Locus;
  readonly readOnly: boolean;
  readonly parameters: Record<string, unknown>;
  readonly argsSchema: S;
  readonly handler: ToolHandler<z.infer<S>>;
  /** The serializable projection. Carries no handler and no Zod schema. */
  readonly spec: ToolSpec;
}

/**
 * Providers agree on this much: a tool name is `[a-zA-Z0-9_-]{1,64}`. Catching
 * it at definition time turns a 400 from a live endpoint into a startup error.
 */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function toParameters(schema: ZodObject<ZodRawShape>, name: string): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  if (json.type !== "object") {
    throw new Error(
      `Tool "${name}" must take an object of named arguments; every provider models ` +
        `tool parameters that way.`,
    );
  }
  // Providers reject unknown keys inconsistently and silently. Being explicit
  // means the model is told what it may not send, rather than finding out.
  return { additionalProperties: false, ...json };
}

export function defineTool<S extends ZodObject<ZodRawShape>>(
  input: ToolDefinitionInput<S>,
): ToolDefinition<S> {
  if (!TOOL_NAME.test(input.name)) {
    throw new Error(
      `Tool name "${input.name}" is not usable: it must match ${String(TOOL_NAME)}.`,
    );
  }
  if (typeof (input.argsSchema as { shape?: unknown }).shape !== "object") {
    throw new Error(
      `Tool "${input.name}" must take an object of named arguments; every provider models ` +
        `tool parameters that way.`,
    );
  }

  const readOnly = input.readOnly ?? false;
  const parameters = toParameters(input.argsSchema, input.name);

  return {
    name: input.name,
    description: input.description,
    locus: input.locus,
    readOnly,
    parameters,
    argsSchema: input.argsSchema,
    handler: input.handler,
    spec: {
      name: input.name,
      description: input.description,
      parameters,
      locus: input.locus,
      readOnly,
    },
  };
}

/**
 * The set of tools one agent may call.
 *
 * Registration order is preserved, because it is the order the model reads the
 * catalogue in and reproducible prompts are worth more than a sorted list.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<ZodObject<ZodRawShape>>>();

  constructor(tools: readonly ToolDefinition<never>[] | readonly ToolDefinition[] = []) {
    for (const tool of tools) this.register(tool as ToolDefinition);
  }

  register(tool: ToolDefinition<never> | ToolDefinition): this {
    const definition = tool as ToolDefinition;
    if (this.tools.has(definition.name)) {
      // Silently shadowing would make the model's choice depend on registration
      // order -- a bug that surfaces as "the agent called the wrong thing".
      throw new Error(`Tool "${definition.name}" is already registered.`);
    }
    this.tools.set(definition.name, definition);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  get size(): number {
    return this.tools.size;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  private definitions(locus?: Locus): ToolDefinition[] {
    const all = [...this.tools.values()];
    return locus === undefined ? all : all.filter((tool) => tool.locus === locus);
  }

  /** The serializable catalogue. What crosses the wire to the client agent. */
  specs(locus?: Locus): ToolSpec[] {
    return this.definitions(locus).map((tool) => tool.spec);
  }

  /** The same catalogue in the shape `LLMProvider.completeWithTools` takes. */
  toolCallSpecs(locus?: Locus): ToolCallSpec[] {
    return this.definitions(locus).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
}
