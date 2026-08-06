import { describe, expect, it, vi } from "vitest";

// `runVisionAgent`'s own loop needs a real LLM turn to ever call `critique`
// or `report` -- irrelevant to what this test checks (how `startVisionAgent`
// builds its request URLs). Replacing it with a stub that calls the client
// agent's callbacks directly isolates that, matching how `agent-vision`
// itself is exercised (a `ToolRegistry` around `capture`/`critique`/`report`,
// per `client-agent.ts`) without needing a fake LLM response shape.
vi.mock("@sketchmind/agent-vision", () => ({
  runVisionAgent: async (options: {
    capture: () => Promise<{ ok: boolean; value?: { mimeType: string; width: number; height: number; data: Uint8Array } }>;
    critique: (image: { mimeType: string; width: number; height: number; data: Uint8Array }) => Promise<unknown>;
    report: (findings: unknown[]) => Promise<void>;
  }) => {
    const captured = await options.capture();
    if (captured.ok && captured.value) {
      await options.critique(captured.value);
    }
    await options.report([]);
    return { reported: [], rounds: 1, stopReason: "done" };
  },
}));

const { startVisionAgent } = await import("../src/vision/bootstrap.js");

describe("startVisionAgent", () => {
  it("does nothing when the server says vision is disabled", async () => {
    const fetchImpl = vi.fn();
    await startVisionAgent({
      sessionId: "s1",
      request: "draw a box",
      visionEnabled: false,
      capture: async () => ({ ok: false, errors: [] }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: new AbortController().signal,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("builds every request against the passed apiBase, not the page's own origin", async () => {
    // Regression for the studio's own origin (no dev proxy) swallowing every
    // vision request when apiBase defaults to "". A capture that succeeds
    // exercises both the critique and the report call, which together cover
    // every request `startVisionAgent` issues besides the LLM proxy itself.
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ findings: [] }), { status: 200 });
    });

    await startVisionAgent({
      sessionId: "s1",
      request: "draw a box",
      visionEnabled: true,
      apiBase: "http://localhost:3001",
      capture: async () => ({
        ok: true,
        value: { mimeType: "image/png", width: 1, height: 1, data: new Uint8Array([0]) },
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: new AbortController().signal,
    });

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("http://localhost:3001/")).toBe(true);
    }
  });

  it("throws on a refused critique instead of reporting a clean board", async () => {
    // `return []` would tell the agent the drawing is fine -- the one thing the
    // critique route's contract says must never look like a closed gate, an
    // exhausted round budget or an unreachable upstream. `agent-core` turns the
    // throw into a `TOOL_THREW` outcome the agent can see and reason about.
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("Visual critique is switched off.", { status: 503 });
    });

    await expect(
      startVisionAgent({
        sessionId: "s1",
        request: "draw a box",
        visionEnabled: true,
        apiBase: "http://localhost:3001",
        capture: async () => ({
          ok: true,
          value: { mimeType: "image/png", width: 1, height: 1, data: new Uint8Array([0]) },
        }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/503/);

    // And the failure must not have been laundered into a "nothing to fix"
    // report: no findings were posted at all.
    expect(urls.some((url) => url.includes("/findings"))).toBe(false);
  });
});
