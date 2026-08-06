import { describe, expect, it } from "vitest";
import { critiqueGeometry } from "@sketchmind/agent-vision";
import { FakeProvider } from "@sketchmind/llm-provider";
import { loadConfig } from "../apps/api/src/config.js";
import type { DiagramAST, LayoutModel } from "@sketchmind/shared-types";

const ast = { objects: [], relationships: [] } as unknown as DiagramAST;

/** A pulley whose rope endpoint misses the groove anchor by 40 units. */
const MISPLACED: LayoutModel = {
  version: "1.0",
  diagramId: "pulley",
  strategy: "manual",
  canvas: { width: 400, height: 400 },
  nodes: [
    {
      objectId: "pulley_1",
      position: { x: 180, y: 40 },
      size: { width: 40, height: 40 },
      rotation: 0,
      bounds: { x: 180, y: 40, width: 40, height: 40 },
      anchors: [{ name: "groove", point: { x: 200, y: 80 } }],
      zIndex: 0,
    },
    {
      objectId: "weight_1",
      position: { x: 180, y: 300 },
      size: { width: 40, height: 40 },
      rotation: 0,
      bounds: { x: 180, y: 300, width: 40, height: 40 },
      anchors: [],
      zIndex: 0,
    },
  ],
  connectors: [
    {
      relationshipId: "rope_1",
      routing: "straight",
      points: [
        { x: 240, y: 80 },
        { x: 200, y: 300 },
      ],
      metadata: { sourceAnchor: "pulley_1:groove" },
    },
  ],
  labels: [],
} as LayoutModel;

/** The same diagram after the repair the findings ask for. */
const CORRECTED: LayoutModel = {
  ...MISPLACED,
  connectors: [
    {
      ...MISPLACED.connectors[0]!,
      points: [
        { x: 200, y: 80 },
        { x: 200, y: 300 },
      ],
    },
  ],
} as LayoutModel;

describe("acceptance: tier 1 alone detects and verifies a misplaced component", () => {
  it("detects the rope not meeting the pulley", () => {
    const findings = critiqueGeometry({ ast, layout: MISPLACED });
    const anchorMiss = findings.filter((f) => f.check === "anchor-miss");

    expect(anchorMiss).toHaveLength(1);
    expect(anchorMiss[0]?.objectIds).toContain("pulley_1");
    expect(anchorMiss[0]?.tier).toBe("geometric");
  });

  it("passes the corrected layout with no findings", () => {
    expect(critiqueGeometry({ ast, layout: CORRECTED })).toEqual([]);
  });

  it("proposes a fix in words, never a coordinate", () => {
    const [finding] = critiqueGeometry({ ast, layout: MISPLACED }).filter(
      (f) => f.check === "anchor-miss",
    );
    expect(finding?.proposal).toBeDefined();
    expect(JSON.stringify(finding?.proposal)).not.toMatch(/\d{2,}/);
  });
});

describe("acceptance: vision off means no image anywhere", () => {
  it("keeps the tier inert with mode off", () => {
    expect(loadConfig({}).vision.mode).toBe("off");
  });

  it("never constructs a vision request when the provider cannot see", async () => {
    const provider = new FakeProvider({ capabilities: { vision: false } });
    const { critiqueImage } = await import("@sketchmind/agent-vision");

    const result = await critiqueImage({
      provider,
      image: { mimeType: "image/png", width: 1, height: 1, data: new Uint8Array([1]) },
      request: "draw a box",
      layoutSummary: "1 object",
    });

    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("acceptance: enabling the tier is configuration, not code", () => {
  it("turns on with mode=auto and a vision-capable provider", () => {
    const config = loadConfig({ SKETCHMIND_VISION_MODE: "auto" });
    const provider = new FakeProvider({ capabilities: { vision: true } });

    const enabled = config.vision.mode !== "off" && provider.capabilities.vision;
    expect(enabled).toBe(true);
  });

  it("stays off with mode=auto and a text-only provider", () => {
    const config = loadConfig({ SKETCHMIND_VISION_MODE: "auto" });
    const provider = new FakeProvider({ capabilities: { vision: false } });

    const enabled = config.vision.mode !== "off" && provider.capabilities.vision;
    expect(enabled).toBe(false);
  });
});

describe("acceptance: provider independence", () => {
  it("drives the visual tier identically under two different provider ids", async () => {
    const { critiqueImage } = await import("@sketchmind/agent-vision");
    const reply = JSON.stringify({ findings: [] });

    for (const id of ["alpha", "beta"]) {
      const provider = new FakeProvider({ id, capabilities: { vision: true }, responses: [reply] });
      const result = await critiqueImage({
        provider,
        image: { mimeType: "image/png", width: 1, height: 1, data: new Uint8Array([1]) },
        request: "draw a box",
        layoutSummary: "1 object",
      });
      expect(result.ok).toBe(true);
    }
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);

function sourceFiles(dir: string): string[] {
  const fullPath = join(rootDir, dir);
  return readdirSync(fullPath).flatMap((entry) => {
    const path = join(fullPath, entry);
    if (entry === "node_modules" || entry === "dist") return [];
    if (statSync(path).isDirectory()) return sourceFiles(join(dir, entry));
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

describe("acceptance: no vendor names outside the composition root", () => {
  const FORBIDDEN = /azure|openai|anthropic|claude|gpt-/i;

  it("agent-vision names no vendor", () => {
    for (const file of sourceFiles("packages/agent-vision/src")) {
      expect(FORBIDDEN.test(readFileSync(file, "utf8")), file).toBe(false);
    }
  });

  it("the critique route names no vendor", () => {
    expect(FORBIDDEN.test(readFileSync(join(rootDir, "apps/api/src/routes/vision.ts"), "utf8"))).toBe(false);
  });

  it("the studio vision code names no vendor", () => {
    for (const file of sourceFiles("apps/studio/src/vision")) {
      expect(FORBIDDEN.test(readFileSync(file, "utf8")), file).toBe(false);
    }
  });
});
