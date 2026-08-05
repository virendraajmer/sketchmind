/**
 * The memory tools: `recall`, `learn`, `forget` (AD-7, D-10).
 *
 * `agent-memory` depends on `agent-core`'s `defineTool`, not the other way
 * around: the loop knows nothing about a primitive store, and a locus with none
 * -- Phase 11's client agent, for instance -- runs the identical loop with these
 * tools simply absent from its catalogue.
 *
 * `recall`'s empty case returns `ok: true` with an empty array, not a failure.
 * AD-2's "failure as observation" is about problems the agent can fix; finding
 * nothing to recall needs no fixing, and reporting it as an error would send the
 * agent looking for a bug that is not there.
 */
import { defineTool, type ToolDefinition } from "@sketchmind/agent-core";
import { z } from "zod";
import type { EmbeddingProvider } from "./internal/embedding.js";
import type { MemoryStore } from "./store.js";

export interface MemoryToolsOptions {
  readonly store: MemoryStore;
  readonly embedder: EmbeddingProvider;
}

const LearnArgs = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  subject: z.string().optional(),
  aliases: z.array(z.string().min(1)).default([]),
  keywords: z.array(z.string().min(1)).default([]),
});

const RecallArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(20).default(5),
});

const ForgetArgs = z.object({ id: z.string().min(1) });

export function createMemoryTools(options: MemoryToolsOptions): ToolDefinition[] {
  const { store, embedder } = options;

  const recall = defineTool({
    name: "recall",
    description:
      "Search learned primitives for one matching the given description or name, even if " +
      "worded differently than when it was learned (e.g. 'nephron' finds 'kidney nephron unit'). " +
      "Use this before generating a new shape from scratch.",
    locus: "server",
    readOnly: true,
    argsSchema: RecallArgs,
    handler: async (args) => {
      const hits = await store.recall(args.query, embedder, { limit: args.limit });
      return { ok: true as const, value: hits };
    },
  });

  const learn = defineTool({
    name: "learn",
    description:
      "Remember a shape or concept for future recall, once it has proven useful. Only call this " +
      "for something worth reusing across sessions, not for one-off scratch work.",
    locus: "server",
    argsSchema: LearnArgs,
    handler: async (args) => store.learn(args, embedder),
  });

  const forget = defineTool({
    name: "forget",
    description: "Remove a previously learned primitive, e.g. because it was learned incorrectly.",
    locus: "server",
    argsSchema: ForgetArgs,
    handler: async (args) => {
      await store.forget(args.id);
      return { ok: true as const, value: { id: args.id } };
    },
  });

  return [recall, learn, forget];
}
