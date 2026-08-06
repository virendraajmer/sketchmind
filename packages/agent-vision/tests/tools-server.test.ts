import { describe, expect, it } from "vitest";
import { createVisionTools } from "../src/index.js";
import type { DiagramAST, LayoutModel } from "@sketchmind/shared-types";

const ast = { objects: [], relationships: [] } as unknown as DiagramAST;

const layout: LayoutModel = {
  version: "1.0",
  diagramId: "d1",
  strategy: "manual",
  canvas: { width: 200, height: 200 },
  nodes: [
    { objectId: "a", position: { x: 0, y: 0 }, size: { width: 20, height: 20 }, rotation: 0, bounds: { x: 0, y: 0, width: 20, height: 20 }, anchors: [], zIndex: 0 },
    { objectId: "b", position: { x: 10, y: 10 }, size: { width: 20, height: 20 }, rotation: 0, bounds: { x: 10, y: 10, width: 20, height: 20 }, anchors: [], zIndex: 0 },
  ],
  connectors: [],
  labels: [],
} as LayoutModel;

const context = {
  sessionId: "s1",
  signal: new AbortController().signal,
  locus: "server" as const,
  toolCallId: "c1",
};

describe("critique_diagram", () => {
  it("is registered under the expected name and locus", () => {
    const [tool] = createVisionTools({
      getAst: () => ast,
      getLayout: () => layout,
      getStrokes: () => undefined,
    });
    expect(tool?.name).toBe("critique_diagram");
    expect(tool?.locus).toBe("server");
    expect(tool?.readOnly).toBe(true);
  });

  it("returns findings for a flawed layout", async () => {
    const [tool] = createVisionTools({
      getAst: () => ast,
      getLayout: () => layout,
      getStrokes: () => undefined,
    });
    const result = (await tool!.handler({}, context)) as { ok: true; value: { findings: unknown[] } };
    expect(result.ok).toBe(true);
    expect(result.value.findings.length).toBeGreaterThan(0);
  });

  it("fails recoverably when no layout has been solved", async () => {
    const [tool] = createVisionTools({
      getAst: () => ast,
      getLayout: () => undefined,
      getStrokes: () => undefined,
    });
    const result = (await tool!.handler({}, context)) as {
      ok: false;
      errors: { code: string; recoverable: boolean }[];
    };
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("CRITIQUE_MISSING_INPUT");
    expect(result.errors[0]?.recoverable).toBe(true);
  });
});
