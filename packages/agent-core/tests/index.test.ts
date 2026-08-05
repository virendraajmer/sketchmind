import { describe, it, expect } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/index.js";

describe("agent-core package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/agent-core");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});
