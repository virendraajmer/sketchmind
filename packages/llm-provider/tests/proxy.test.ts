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

  it("sends a body matching the proxy route's request shape", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(response), { status: 200 }),
    );
    const provider = createProxyProvider({ endpoint: "/api/agent/llm", fetchImpl });

    await provider.completeWithTools({
      system: "be helpful",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "draw", description: "draws a thing", parameters: {} }],
      toolChoice: "auto",
      maxOutputTokens: 500,
      temperature: 0.2,
    });

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      system: "be helpful",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "draw", description: "draws a thing", parameters: {} }],
      toolChoice: "auto",
      maxOutputTokens: 500,
      temperature: 0.2,
    });
    // `allowParallelCalls` is a server-side decision (see routes/llm.ts) --
    // the browser has no basis to assert it and must not send it.
    expect(body.allowParallelCalls).toBeUndefined();
  });

  it("throws LLMProviderError on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 502 }));
    const provider = createProxyProvider({ endpoint: "/api/agent/llm", fetchImpl });

    await expect(
      provider.completeWithTools({ messages: [{ role: "user", content: "hi" }], tools: [] }),
    ).rejects.toBeInstanceOf(LLMProviderError);
  });

  it.each([
    [400, "PROVIDER_BAD_REQUEST"],
    [429, "PROVIDER_RATE_LIMITED"],
    [502, "PROVIDER_UNAVAILABLE"],
  ])("classifies a %i proxy response as %s", async (status, code) => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status }));
    const provider = createProxyProvider({ endpoint: "/api/agent/llm", fetchImpl });

    let error: LLMProviderError | undefined;
    try {
      await provider.completeWithTools({ messages: [{ role: "user", content: "hi" }], tools: [] });
    } catch (e) {
      error = e as LLMProviderError;
    }

    expect(error).toBeInstanceOf(LLMProviderError);
    expect(error?.error.code).toBe(code);
  });

  it("rejects the methods the proxy does not carry", async () => {
    const provider = createProxyProvider({ endpoint: "/api/agent/llm" });
    await expect(
      provider.completeWithImages({ messages: [{ role: "user", content: "x" }], images: [] }),
    ).rejects.toBeInstanceOf(LLMProviderError);
  });
});
