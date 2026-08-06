import { describe, expect, it } from "vitest";
import { decodeServerEvent, type RuntimeEvent } from "@sketchmind/session-protocol";
import { DRAWS_NOTHING, testServer } from "./support.js";

/** Split an SSE body back into the events it carried. */
function eventsFrom(body: string): RuntimeEvent[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.includes("data:"))
    .map((frame) => {
      const decoded = decodeServerEvent(`${frame}\n\n`);
      if (!decoded.ok) throw new Error(JSON.stringify(decoded.errors));
      return decoded.value;
    });
}

describe("POST /api/sessions", () => {
  it("accepts a request and returns immediately with a session id", async () => {
    const { app } = await testServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { userInput: "Draw a movable pulley" },
    });

    // 202, not 200: the drawing has not happened yet, it is being watched.
    expect(res.statusCode).toBe(202);
    expect(res.json().sessionId).toBeTypeOf("string");
    await app.close();
  });

  it("rejects an empty prompt with the reason", async () => {
    const { app } = await testServer();
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: { userInput: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].path).toBe("userInput");
    await app.close();
  });

  it("rejects a prompt long enough to be an attack", async () => {
    const { app } = await testServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { userInput: "x".repeat(2001) },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /api/sessions/:id/stream", () => {
  it("streams the whole session, in order, ending with SessionCompleted", async () => {
    const { app } = await testServer();
    const start = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { userInput: "Draw a movable pulley" },
    });
    const { sessionId } = start.json();

    const stream = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/stream` });
    expect(stream.headers["content-type"]).toContain("text/event-stream");

    const types = eventsFrom(stream.body).map((event) => event.type);
    // Buffering is what makes this pass: the agent finished before this second
    // request even arrived, and the stream replayed the run from the start.
    expect(types[0]).toBe("SessionStarted");
    expect(types.at(-1)).toBe("SessionCompleted");
    expect(types).toContain("DiagramASTReady");
    expect(types).toContain("FrameUpdate");
    await app.close();
  });

  it("every frame decodes as a valid event, so the browser's switch is sound", async () => {
    const { app } = await testServer();
    const start = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { userInput: "Draw a movable pulley" },
    });
    const stream = await app.inject({
      method: "GET",
      url: `/api/sessions/${start.json().sessionId}/stream`,
    });

    // eventsFrom throws on any frame that fails validation.
    expect(eventsFrom(stream.body).length).toBeGreaterThan(5);
    await app.close();
  });

  it("streams a failure rather than closing silently", async () => {
    const { app } = await testServer(DRAWS_NOTHING);
    const start = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { userInput: "Draw a movable pulley" },
    });
    const stream = await app.inject({
      method: "GET",
      url: `/api/sessions/${start.json().sessionId}/stream`,
    });

    const types = eventsFrom(stream.body).map((event) => event.type);
    expect(types.at(-1)).toBe("SessionFailed");
    await app.close();
  });

  it("404s for a session that does not exist", async () => {
    const { app } = await testServer();
    const res = await app.inject({ method: "GET", url: "/api/sessions/nope/stream" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /api/sessions/:id/cancel", () => {
  it("aborts the run", async () => {
    const { app, sessions } = await testServer();
    const id = "manual";
    const record = sessions.create(id);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/cancel`,
      payload: { reason: "user clicked stop" },
    });
    expect(res.statusCode).toBe(204);
    expect(record.controller.signal.aborted).toBe(true);
    await app.close();
  });

  it("404s for a session that does not exist", async () => {
    const { app } = await testServer();
    const res = await app.inject({ method: "POST", url: "/api/sessions/nope/cancel", payload: {} });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
