import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { FakeProvider, ProviderErrorCode, providerError } from "@sketchmind/llm-provider";
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

  it("rejects data that is not valid base64, without spending an extra check", async () => {
    const { app, sessions } = build({ vision: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/vision-critique",
      payload: { ...body, base64: "not valid base64!!!" },
    });

    expect(res.statusCode).toBe(400);
    // The round still counts -- a malformed request must not be retryable for free.
    expect(sessions.get("s1")!.visionRounds).toBe(1);
  });

  it("answers 502, not 422, when the provider itself fails (rate limit, auth, ...)", async () => {
    const sessions = new SessionManager();
    sessions.create("s1", "draw a pulley system");
    const provider = new FakeProvider({
      capabilities: { vision: true },
      failWith: providerError(ProviderErrorCode.RateLimited, "Too many requests.", "@sketchmind/llm-provider"),
    });
    const app = Fastify();
    registerVisionRoute(app, { provider, sessions, config: loadConfig({ SKETCHMIND_VISION_MODE: "on" }) });

    const res = await app.inject({ method: "POST", url: "/api/agent/vision-critique", payload: body });

    expect(res.statusCode).toBe(502);
    expect(res.json().errors[0].code).toBe(ProviderErrorCode.RateLimited);
  });

  it("answers 422, not 502, when the model answers but its JSON does not parse", async () => {
    const sessions = new SessionManager();
    sessions.create("s1", "draw a pulley system");
    const provider = new FakeProvider({
      capabilities: { vision: true },
      responses: ["I looked at the picture and it seems fine, no JSON here."],
    });
    const app = Fastify();
    registerVisionRoute(app, { provider, sessions, config: loadConfig({ SKETCHMIND_VISION_MODE: "on" }) });

    const res = await app.inject({ method: "POST", url: "/api/agent/vision-critique", payload: body });

    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0].code).toBe("CRITIQUE_UNPARSEABLE");
  });
});
