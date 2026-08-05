import { describe, it, expect } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/index";

describe("llm-provider package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/llm-provider");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});
