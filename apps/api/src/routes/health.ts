import type { FastifyInstance } from "fastify";
import { PACKAGE_VERSION } from "@sketchmind/shared-types";

export function registerHealth(app: FastifyInstance): void {
  app.get("/health", async () => ({ status: "ok", sharedTypes: PACKAGE_VERSION }));
}
