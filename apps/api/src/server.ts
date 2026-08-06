import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { FileStore, type MemoryStore } from "@sketchmind/agent-memory";
import type { LLMProvider } from "@sketchmind/llm-provider";
import { registerHealth } from "./routes/health.js";
import { registerLlmProxy } from "./routes/llm.js";
import { registerSessions } from "./routes/sessions.js";
import { registerVisionRoute } from "./routes/vision.js";
import { SessionManager } from "./session/manager.js";
import { loadConfig, type ApiConfig } from "./config.js";
import { resolveProvider, resolveRoleProvider } from "./provider.js";

/**
 * The composition root.
 *
 * Everything the server needs is constructed here and passed down; no route
 * handler reads the environment or picks a provider. That is what lets a test
 * hand in a `FakeProvider` and an `InMemoryStore` and get the real routes.
 *
 * This process is also the only place LLM credentials exist. The client agent's
 * model turns proxy through `POST /api/agent/llm` (see `routes/llm.ts`), so no
 * provider SDK or Azure key is ever part of a browser bundle.
 */
export interface ServerOptions {
  readonly provider?: LLMProvider;
  readonly store?: MemoryStore;
  readonly config?: ApiConfig;
  /** Off in tests, where request logs bury the assertions. */
  readonly logger?: boolean;
}

export interface SketchMindServer {
  readonly app: FastifyInstance;
  readonly config: ApiConfig;
  readonly sessions: SessionManager;
}

export async function buildServer(options: ServerOptions = {}): Promise<SketchMindServer> {
  const config = options.config ?? loadConfig();
  const provider = options.provider ?? resolveProvider();
  const store = options.store ?? new FileStore({ path: config.memoryPath });
  const sessions = new SessionManager();

  const app = Fastify({ logger: options.logger ?? true });

  // The browser opens an SSE stream cross-origin in development, where the web
  // app is on :3000 and this server on :3001.
  await app.register(cors, { origin: config.webOrigin });

  const visionProvider = resolveRoleProvider("vision");
  const visionEnabled = config.vision.mode !== "off" && visionProvider !== undefined;

  registerHealth(app);
  registerSessions(app, { provider, store, config, sessions, visionEnabled });
  registerLlmProxy(app, provider);
  registerVisionRoute(app, {
    provider: visionProvider,
    config,
    sessions,
  });

  // A deployment that depends on critique should learn at boot, not mid-session.
  if (config.vision.mode === "on" && !visionProvider) {
    app.log.warn(
      "SKETCHMIND_VISION_MODE=on but no vision-capable provider resolved. " +
        "Set SKETCHMIND_VISION_PROVIDER / SKETCHMIND_VISION_MODEL, or use mode=auto.",
    );
  }

  // A process exiting with sessions still running would leave the agent's
  // in-flight provider call to be reaped by a timeout rather than cancelled.
  app.addHook("onClose", async () => sessions.cancelAll());

  return { app, config, sessions };
}

if (process.env["NODE_ENV"] !== "test") {
  const { app, config } = await buildServer();
  app.listen({ port: config.port }, (err) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
  });
}
