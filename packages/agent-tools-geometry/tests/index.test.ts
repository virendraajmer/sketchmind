import { describe, it, expect } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/index.js";

describe("agent-tools-geometry package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/agent-tools-geometry");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});
