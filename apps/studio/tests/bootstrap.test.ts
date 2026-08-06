import { describe, expect, it, vi } from "vitest";
import { startVisionAgent } from "../src/vision/bootstrap.js";

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
});
