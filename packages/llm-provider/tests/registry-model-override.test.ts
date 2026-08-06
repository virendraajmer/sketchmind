import { describe, expect, it } from "vitest";
import { FakeProvider, ProviderRegistry } from "../src/index.js";

describe("ProviderRegistry model override", () => {
  it("passes the override to the factory", () => {
    const registry = new ProviderRegistry();
    registry.register("fake", (_env, options) => new FakeProvider({ model: options?.model }));

    const provider = registry.create("fake", {}, { model: "gpt-4o" });
    expect(provider.model).toBe("gpt-4o");
  });

  it("leaves the factory's own choice alone when omitted", () => {
    const registry = new ProviderRegistry();
    registry.register("fake", (_env, options) => new FakeProvider({ model: options?.model }));

    expect(registry.create("fake", {}).model).toBe("fake-model");
  });

  it("still works for a factory that ignores the second argument", () => {
    const registry = new ProviderRegistry();
    registry.register("legacy", () => new FakeProvider({ id: "legacy" }));

    expect(registry.create("legacy", {}, { model: "ignored" }).id).toBe("legacy");
  });
});

describe("FakeProvider", () => {
  it("honours a model option", () => {
    expect(new FakeProvider({ model: "claude-sonnet-5" }).model).toBe("claude-sonnet-5");
  });

  it("can declare vision", () => {
    expect(new FakeProvider({ capabilities: { vision: true } }).capabilities.vision).toBe(true);
  });
});
