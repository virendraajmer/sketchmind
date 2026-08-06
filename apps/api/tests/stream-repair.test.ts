/**
 * The stream has to outlive the session's own terminal event.
 *
 * Tier 2's whole shape depends on it: the browser's vision agent only *starts*
 * when `SessionCompleted` arrives, and the repair turn it triggers through
 * `POST /api/sessions/:id/findings` emits `VisionCritique`, `AgentStep` and
 * possibly `DiagramASTReady` through the same stream afterwards. The route used
 * to `reply.raw.end()` on the terminal event, which sent all of that nowhere --
 * and made a native `EventSource` reconnect every ~3s, replaying
 * `SessionCompleted` and launching another vision agent each time.
 *
 * A real socket, not `app.inject`: `inject` resolves only once the response
 * ends, which is precisely the behaviour under test.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { InMemoryStore } from "@sketchmind/agent-memory";
import type { CritiqueFinding } from "@sketchmind/shared-types";
import { buildServer, type SketchMindServer } from "../src/server.js";
import { pulleyProvider, testConfig } from "./support.js";

const finding: CritiqueFinding = {
  id: "f1",
  tier: "visual",
  check: "overlap",
  severity: "error",
  message: "The load overlaps the pulley.",
  objectIds: ["pulley", "load"],
};

const ENV = {
  // Any provider that reports `vision` opens the gate; the value is never used
  // here because no image is ever critiqued -- only the gate's effect on the
  // stream's lifetime is under test.
  SKETCHMIND_LLM_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "k",
  ANTHROPIC_VISION: "true",
} as const;

const saved = new Map<string, string | undefined>();
let server: SketchMindServer | undefined;

afterEach(async () => {
  await server?.app.close();
  server = undefined;
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

/**
 * Reads the SSE body incrementally, failing loudly on the two outcomes this
 * test exists to catch: the server ending the response, and nothing arriving.
 */
function streamReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  return {
    get text(): string {
      return text;
    },
    cancel: (): Promise<void> => reader.cancel().catch(() => undefined),
    async until(predicate: (seen: string) => boolean, timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(text)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timed out waiting. Saw:\n${text.slice(0, 2000)}`);

        let timer: NodeJS.Timeout | undefined;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("No further events arrived.")), remaining);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });

        // The regression itself: the server ending its side is indistinguishable
        // from a dropped connection to a browser, and is what caused the
        // reconnect/resend loop.
        if (chunk.done) throw new Error(`The server closed the stream. Saw:\n${text.slice(0, 2000)}`);
        text += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

async function listen(): Promise<string> {
  for (const [key, value] of Object.entries(ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }

  server = await buildServer({
    provider: pulleyProvider(),
    store: new InMemoryStore(),
    config: testConfig({
      tickMs: 1000,
      vision: { geometric: true, mode: "auto", maxRounds: 2, maxImageBytes: 4_000_000 },
    }),
    logger: false,
  });

  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = server.app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("the stream past a terminal event", () => {
  it(
    "carries a /findings repair turn's events to a reader that connected before SessionCompleted",
    async () => {
      const base = await listen();

      const start = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userInput: "Draw a movable pulley" }),
      });
      expect(start.status).toBe(202);
      const { sessionId } = (await start.json()) as { sessionId: string };

      // Connected while the run is still going, and never re-opened -- exactly
      // the browser's own sequence.
      const response = await fetch(`${base}/api/sessions/${sessionId}/stream`);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const stream = streamReader(response.body!);

      await stream.until((seen) => seen.includes('"SessionCompleted"'), 30_000);

      // Everything from here must be attributable to the repair, not to the
      // buffered history the run already produced.
      const afterTerminal = stream.text.length;

      const posted = await fetch(`${base}/api/sessions/${sessionId}/findings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ findings: [finding] }),
      });
      expect(posted.status).toBe(202);

      await stream.until(
        (seen) => seen.slice(afterTerminal).includes('"VisionCritique"'),
        15_000,
      );

      await stream.cancel();
    },
    45_000,
  );
});
