/**
 * The client agent's LLM proxy.
 *
 * This route is the reason no Azure key, endpoint or provider SDK ever reaches
 * the browser. The client agent (Phase 11) runs the same loop as the server
 * agent, but its model turns come here instead of to a provider directly, and
 * the credentials stay in this process.
 *
 * The request body is validated rather than forwarded. A proxy that passed
 * whatever it received straight to a paid API would be an open relay wearing a
 * SketchMind badge -- so the schema below is the contract, and anything outside
 * it is a 400. Note in particular that `tools` carries specs only: the browser
 * holds tool *descriptions*, never authority, and a tool the model then chooses
 * to call is executed client-side or re-authorized server-side (AD-8), never run
 * because this route saw its name.
 *
 * Scope is deliberately one method. `completeWithTools` is what an agent loop
 * needs; `completeStructured` and `stream` can be added when something asks for
 * them, and each addition is a decision about what the browser may spend money
 * on rather than a convenience.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LLMProviderError, type LLMProvider, type Message } from "@sketchmind/llm-provider";

const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()),
});

const MessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.string() }),
  z.object({
    role: z.literal("assistant"),
    content: z.string(),
    toolCalls: z.array(ToolCallSchema).optional(),
  }),
  z.object({
    role: z.literal("tool"),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1).max(64),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
]);

const ProxyRequestSchema = z.object({
  system: z.string().max(20_000).optional(),
  messages: z.array(MessageSchema).min(1).max(200),
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        description: z.string().min(1).max(2000),
        parameters: z.record(z.string(), z.unknown()),
      }),
    )
    .max(64)
    .default([]),
  toolChoice: z.enum(["auto", "required", "none"]).optional(),
  maxOutputTokens: z.number().int().positive().max(16_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export function registerLlmProxy(app: FastifyInstance, provider: LLMProvider): void {
  app.post("/api/agent/llm", async (request, reply) => {
    const parsed = ProxyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ errors: parsed.error.issues });
    }

    if (!provider.capabilities.toolCalling) {
      return reply.code(503).send({
        error: `Provider ${provider.id} cannot call tools. Client agent turns need it.`,
      });
    }

    try {
      const response = await provider.completeWithTools({
        ...(parsed.data.system === undefined ? {} : { system: parsed.data.system }),
        messages: parsed.data.messages as Message[],
        tools: parsed.data.tools,
        ...(parsed.data.toolChoice === undefined ? {} : { toolChoice: parsed.data.toolChoice }),
        ...(parsed.data.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: parsed.data.maxOutputTokens }),
        ...(parsed.data.temperature === undefined ? {} : { temperature: parsed.data.temperature }),
        allowParallelCalls: provider.capabilities.parallelToolCalls,
      });
      return reply.send(response);
    } catch (cause) {
      // The structured error travels; the provider's own exception does not.
      // Its message can name an endpoint or a deployment, and this response goes
      // to a browser.
      if (cause instanceof LLMProviderError) {
        return reply.code(502).send({ errors: [cause.error] });
      }
      app.log.error({ err: cause }, "llm proxy failed");
      return reply.code(502).send({ error: "The model could not be reached." });
    }
  });
}
