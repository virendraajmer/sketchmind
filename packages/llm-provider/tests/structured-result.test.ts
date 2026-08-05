import { describe, it, expect } from "vitest";
import { z } from "zod";
import { FakeProvider, LLMProviderError, requestStructured } from "../src/index.js";
import { ProviderErrorCode, providerError } from "../src/internal/errors.js";

const Schema = z.object({ subject: z.string().min(1) });
const origin = { package: "@sketchmind/test-stage", stage: "intent" } as const;

function request(provider: FakeProvider) {
  return requestStructured(
    provider,
    { messages: [{ role: "user" as const, content: "go" }], schema: Schema, name: "Thing" },
    origin,
  );
}

describe("requestStructured", () => {
  it("returns the parsed value when the model answers correctly", async () => {
    const provider = new FakeProvider({ responses: [JSON.stringify({ subject: "pulley" })] });
    const { result, usage } = await request(provider);

    expect(result.ok && result.value.subject).toBe("pulley");
    expect(usage?.totalTokens).toBeGreaterThan(0);
  });

  /**
   * The decision this file exists for: bad model output is an observation the
   * agent fixes (AD-2), so it must never arrive as an exception.
   */
  it("turns unusable model output into structured errors, not a throw", async () => {
    const provider = new FakeProvider({ responses: ["I would rather not."], capabilities: { structuredOutput: false } });
    const { result } = await request(provider);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.recoverable).toBe(true);
  });

  it("re-attributes a recoverable failure to the stage that asked", async () => {
    const provider = new FakeProvider({ responses: ["nonsense"], capabilities: { structuredOutput: false } });
    const { result } = await request(provider);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.package).toBe(origin.package);
    expect(result.errors[0]?.stage).toBe("intent");
    // The provider's own attribution is kept, because "which transport said so"
    // is the first thing anyone debugging this asks.
    expect(result.errors[0]?.details?.providerPackage).toBe("@sketchmind/llm-provider");
  });

  it("rethrows a non-recoverable provider failure", async () => {
    const provider = new FakeProvider({
      failWith: providerError(ProviderErrorCode.AuthFailed, "bad key", "@sketchmind/llm-provider"),
    });

    await expect(request(provider)).rejects.toBeInstanceOf(LLMProviderError);
  });
});
