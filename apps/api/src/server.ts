import Fastify, { type FastifyInstance } from "fastify";
import { registerHealth } from "./routes/health.js";

/**
 * Builds the SketchMind API server.
 *
 * Exported separately from the listen call so tests can drive it via
 * `app.inject()` without binding a port.
 *
 * This server is also the only place LLM credentials live: the client agent's
 * model turns proxy through here (POST /api/agent/llm, Phase 9) so that no
 * provider SDK or Azure key ever reaches the browser.
 */
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  registerHealth(app);
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3001);
  app.listen({ port }, (err) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
  });
}
