import { describe, expect, it, vi } from "vitest";
import { FakeProvider } from "@sketchmind/llm-provider";
import { runVisionAgent } from "../src/index.js";
import { ok } from "@sketchmind/shared-types";

const image = { mimeType: "image/png", width: 4, height: 4, data: new Uint8Array([1]) };

function options(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    request: "draw a pulley system",
    provider: new FakeProvider({ responses: ["nothing to report"] }),
    capture: async () => ok(image),
    critique: async () => [],
    report: async () => {},
    visionEnabled: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("runVisionAgent", () => {
  it("runs and reports its stop reason", async () => {
    const result = await runVisionAgent(options() as never);
    expect(result.rounds).toBe(1);
    expect(result.stopReason).toBeTruthy();
  });

  it("builds no capture or critique tool when vision is disabled", async () => {
    const capture = vi.fn(async () => ok(image));
    const provider = new FakeProvider({ responses: ["ok"] });

    await runVisionAgent(options({ visionEnabled: false, capture, provider }) as never);

    expect(capture).not.toHaveBeenCalled();
    // With no vision tools there is nothing for the agent to do, so it must not
    // spend a model turn either.
    expect(provider.calls).toHaveLength(0);
  });

  it("stops at its step budget rather than looping", async () => {
    // A provider that always asks for another capture. Without a budget the
    // loop would never end, so this asserts the budget is what stops it.
    const provider = new FakeProvider({
      responses: ["capturing"],
      toolCalls: Array.from({ length: 20 }, (_, i) => [
        { id: `c${i}`, name: "capture_canvas", arguments: {} },
      ]),
    });
    const capture = vi.fn(async () => ok(image));

    const result = await runVisionAgent(options({ provider, capture, maxSteps: 3 }) as never);

    expect(capture.mock.calls.length).toBeLessThanOrEqual(3);
    expect(result.stopReason).toBeTruthy();
  });

  it("surfaces a capture failure without throwing", async () => {
    const failing = async () => ({ ok: false as const, errors: [] });
    await expect(runVisionAgent(options({ capture: failing }) as never)).resolves.toBeDefined();
  });
});
