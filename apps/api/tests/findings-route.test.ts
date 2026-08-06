/**
 * `POST /api/sessions/:id/findings`.
 *
 * The route itself does very little -- validate, hand off to `runRepair`,
 * answer 202 -- but every one of those small decisions is a place a client can
 * be told the wrong thing, or the process can crash on an un-awaited promise.
 * These test each branch directly rather than through a full drawing run.
 */
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@sketchmind/agent-memory";
import { FakeProvider } from "@sketchmind/llm-provider";
import type { CritiqueFinding } from "@sketchmind/shared-types";
import { buildServer } from "../src/server.js";
import { DRAWS_A_PULLEY, testConfig, testServer } from "./support.js";

const finding: CritiqueFinding = {
  id: "f1",
  tier: "geometric",
  check: "overlap",
  severity: "error",
  message: "a and b overlap.",
  objectIds: ["a", "b"],
};

async function startSession(app: Awaited<ReturnType<typeof testServer>>["app"]): Promise<string> {
  const start = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { userInput: "Draw a movable pulley" },
  });
  return start.json().sessionId as string;
}

describe("POST /api/sessions/:id/findings", () => {
  it("404s for a session that does not exist", async () => {
    const { app } = await testServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/nope/findings",
      payload: { findings: [finding] },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s for a session that exists but has not produced a registry yet", async () => {
    const { app, sessions } = await testServer();
    // Created directly, the way the cancel route's own test does -- never run,
    // so `runSession` never reached the line that assigns `record.registry`.
    sessions.create("never-run");
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/never-run/findings",
      payload: { findings: [finding] },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400s for a body that does not fit the findings schema", async () => {
    const { app } = await testServer();
    const sessionId = await startSession(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/findings`,
      payload: { findings: [{ not: "a finding" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors).toBeDefined();
    await app.close();
  });

  it("202s and accepts a well-formed findings list", async () => {
    const { app } = await testServer();
    const sessionId = await startSession(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/findings`,
      payload: { findings: [finding] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(true);
    await app.close();
  });

  it("does not surface an unhandled rejection when the repair turn itself throws", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    try {
      // `complete`/`completeWithTools` throw for every call, so both the
      // session run and the later repair turn fail the way `agent-core` says a
      // provider that "cannot answer at all" does: an exception, not a status.
      const built = await buildServer({
        provider: new FakeProvider({ failWith: new Error("boom"), toolCalls: DRAWS_A_PULLEY }),
        store: new InMemoryStore(),
        config: testConfig(),
        logger: false,
      });

      const sessionId = await startSession(built.app);

      const res = await built.app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/findings`,
        payload: { findings: [finding] },
      });
      expect(res.statusCode).toBe(202);

      // Give the un-awaited repair a turn of the event loop to run -- and, if
      // its rejection were not caught, to surface as `unhandledRejection`.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejections).toHaveLength(0);

      await built.app.close();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
