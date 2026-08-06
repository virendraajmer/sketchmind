import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { FakeProvider } from "@sketchmind/llm-provider";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session/manager.js";
import { registerVisionRoute } from "../src/routes/vision.js";

const PNG_BASE64 = "iVBORw0KGgo=";

function build(options: { vision: boolean; mode?: string } ): {
  app: FastifyInstance;
  sessions: SessionManager;
  provider: FakeProvider | undefined;
} {
  const sessions = new SessionManager();
  sessions.create("s1", "draw a pulley system");

  const provider = options.vision
    ? new FakeProvider({
        capabilities: { vision: true },
        responses: [JSON.stringify({ findings: [] })],
      })
    : undefined;

  const app = Fastify();
  registerVisionRoute(app, {
    provider,
    sessions,
    config: loadConfig({ SKETCHMIND_VISION_MODE: options.mode ?? "on" }),
  });

  return { app, sessions, provider };
}

const body = { sessionId: "s1", mimeType: "image/png", base64: PNG_BASE64, width: 4, height: 4 };

describe("POST /api/agent/vision-critique", () => {
  it("returns findings when the gate is open", async () => {
    const { app } = build({ vision: true });
    const res = await app.inject({ method: "POST", url: "/api/agent/vision-critique", payload: body });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ findings: [] });
  });

  it("returns 503 with a reason when no vision provider resolved", async () => {
    const { app } = build({ vision: false });
    const res = await app.inject({ method: "POST", url: "/api/agent/vision-critique", payload: body });

    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toMatch(/vision/i);
  });

  it("returns 503 when the mode is off, even with a capable provider", async () => {
    const { app } = build({ vision: true, mode: "off" });
    const res = await app.inject({ method: "POST", url: "/api/agent/vision-critique", payload: body });

    expect(res.statusCode).toBe(503);
  });

  it("never calls the model when the gate is closed", async () => {
    const { app, provider } = build({ vision: true, mode: "off" });
    await app.inject({ method: "POST", url: "/api/agent/vision-critique", payload: body });

    expect(provider?.calls ?? []).toHaveLength(0);
  });

  it("rejects a malformed body", async () => {
    const { app } = build({ vision: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/vision-critique",
      payload: { sessionId: "s1" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown session", async () => {
    const { app } = build({ vision: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/vision-critique",
      payload: { ...body, sessionId: "nope" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("rejects an oversized image", async () => {
    const { app } = build({ vision: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/vision-critique",
      payload: { ...body, base64: "A".repeat(6_000_000) },
    });

    expect(res.statusCode).toBe(413);
  });

  it("caps critique rounds per session", async () => {
    const { app, sessions } = build({ vision: true });
    const record = sessions.get("s1")!;
    record.visionRounds = 2;

    const res = await app.inject({ method: "POST", url: "/api/agent/vision-critique", payload: body });
    expect(res.statusCode).toBe(429);
  });
});
