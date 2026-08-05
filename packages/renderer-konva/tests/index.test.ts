import { describe, it, expect } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/index.js";

describe("renderer-konva package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/renderer-konva");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});
