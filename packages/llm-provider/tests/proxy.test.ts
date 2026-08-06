import { describe, expect, it, vi } from "vitest";
import { createProxyProvider, LLMProviderError } from "../src/index.js";

const response = {
  toolCalls: [],
  text: "ok",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  model: "proxy",
  finishReason: "stop",
};

describe("createProxyProvider", () => {
  it("POSTs a tool request to the endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(response), { status: 200 }),
    );
    const provider = createProxyProvider({ endpoint: "/api/agent/llm", fetchImpl });

    const result = await provider.completeWithTools({ messages: [{ role: "user", content: "hi" }], tools: [] });

    expect(result.text).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/agent/llm");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("declares vision false — images never go through the proxy", () => {
    const provider = createProxyProvider({ endpoint: "/api/agent/llm" });
    expect(provider.capabilities.vision).toBe(false);
    expect(provider.capabilities.toolCalling).toBe(true);
  });

  it("throws LLMProviderError on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 502 }));
    const provider = createProxyProvider({ endpoint: "/api/agent/llm", fetchImpl });

    await expect(
      provider.completeWithTools({ messages: [{ role: "user", content: "hi" }], tools: [] }),
    ).rejects.toBeInstanceOf(LLMProviderError);
  });

  it("rejects the methods the proxy does not carry", async () => {
    const provider = createProxyProvider({ endpoint: "/api/agent/llm" });
    await expect(
      provider.completeWithImages({ messages: [{ role: "user", content: "x" }], images: [] }),
    ).rejects.toBeInstanceOf(LLMProviderError);
  });
});
