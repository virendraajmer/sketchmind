/**
 * Session routes: start, watch, cancel.
 *
 * `POST /api/sessions` returns immediately and does **not** await the run. A
 * drawing takes tens of seconds; the response carries the session id and the
 * work is watched over the stream. That split is why `SessionManager` buffers
 * events -- the browser's second request always arrives after the first step.
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  SSE_HEADERS,
  SSE_KEEPALIVE,
  encodeServerEvent,
  parseClientCommand,
} from "@sketchmind/session-protocol";
import type { MemoryStore } from "@sketchmind/agent-memory";
import type { LLMProvider } from "@sketchmind/llm-provider";
import type { ApiConfig } from "../config.js";
import { SessionManager } from "../session/manager.js";
import { runSession } from "../session/run.js";

export interface SessionRoutesOptions {
  readonly provider: LLMProvider;
  readonly store: MemoryStore;
  readonly config: ApiConfig;
  readonly sessions: SessionManager;
}

export function registerSessions(app: FastifyInstance, options: SessionRoutesOptions): void {
  const { provider, store, config, sessions } = options;

  app.post("/api/sessions", async (request, reply) => {
    const command = parseClientCommand({ type: "StartSession", ...(request.body as object) });
    if (!command.ok) return reply.code(400).send({ errors: command.errors });
    if (command.value.type !== "StartSession") return reply.code(400).send({ errors: [] });

    const sessionId = randomUUID();
    const record = sessions.create(sessionId);

    void runSession({
      sessionId,
      userInput: command.value.userInput,
      provider,
      store,
      config,
      signal: record.controller.signal,
      emit: (event) => sessions.emit(sessionId, event),
    }).catch((cause: unknown) => {
      // runSession reports its own failures as events. Reaching here means the
      // orchestration itself threw, which the viewer would otherwise experience
      // as a stream that simply stops.
      app.log.error({ err: cause, sessionId }, "session crashed");
      sessions.emit(sessionId, {
        type: "SessionFailed",
        sessionId,
        at: new Date().toISOString(),
        error: {
          code: "SESSION_CRASHED",
          message: cause instanceof Error ? cause.message : String(cause),
          package: "@sketchmind/api",
          stage: "agent",
          recoverable: false,
        },
      });
    });

    return reply.code(202).send({ sessionId });
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/stream", (request, reply) => {
    const { id } = request.params;
    if (!sessions.get(id)) return reply.code(404).send({ error: "No such session." });

    reply.raw.writeHead(200, { ...SSE_HEADERS, "access-control-allow-origin": config.webOrigin });
    reply.raw.write(SSE_KEEPALIVE);

    const unsubscribe = sessions.subscribe(id, (event) => {
      reply.raw.write(encodeServerEvent(event));
      if (TERMINAL.has(event.type)) reply.raw.end();
    });

    // Fires when the tab closes or the client aborts. Without it, a browser
    // that navigated away leaves a listener writing to a dead socket forever.
    request.raw.on("close", unsubscribe);

    // Fastify must not send its own response: this one is already streaming.
    return reply;
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/api/sessions/:id/cancel",
    async (request, reply) => {
      const command = parseClientCommand({
        type: "CancelSession",
        sessionId: request.params.id,
        ...(request.body ?? {}),
      });
      if (!command.ok) return reply.code(400).send({ errors: command.errors });

      if (!sessions.get(request.params.id)) {
        return reply.code(404).send({ error: "No such session." });
      }
      sessions.cancel(request.params.id, request.body?.reason);
      return reply.code(204).send();
    },
  );
}

const TERMINAL = new Set(["SessionCompleted", "SessionFailed", "SessionCancelled"]);
