import { describe, expect, it, vi } from "vitest";
import { VisionWorkspace, createClientVisionTools } from "../src/index.js";
import { ok } from "@sketchmind/shared-types";
import type { CritiqueFinding } from "@sketchmind/shared-types";

const image = { mimeType: "image/png", width: 4, height: 4, data: new Uint8Array([1, 2, 3]) };

const finding: CritiqueFinding = {
  id: "v1",
  tier: "visual",
  check: "reads-wrong",
  severity: "warning",
  message: "The rope hangs beside the pulley.",
  objectIds: ["rope_1"],
};

const context = {
  sessionId: "s1",
  signal: new AbortController().signal,
  locus: "client" as const,
  toolCallId: "c1",
};

function build(overrides: Partial<Parameters<typeof createClientVisionTools>[0]> = {}) {
  const workspace = new VisionWorkspace();
  const tools = createClientVisionTools({
    workspace,
    capture: async () => ok(image),
    critique: async () => [finding],
    report: async () => {},
    ...overrides,
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { workspace, tools, byName };
}

describe("client vision tools", () => {
  it("registers three client-locus tools", () => {
    const { tools } = build();
    expect(tools.map((t) => t.name)).toEqual(["capture_canvas", "critique_canvas", "report_findings"]);
    expect(tools.every((t) => t.locus === "client")).toBe(true);
  });

  it("capture_canvas stores the image and returns only its shape", async () => {
    const { byName, workspace } = build();
    const result = (await byName.capture_canvas!.handler({}, context)) as {
      ok: true;
      value: { width: number; height: number; byteLength: number };
    };

    expect(result.value).toEqual({ width: 4, height: 4, byteLength: 3 });
    expect(workspace.image).toBe(image);
    // The bytes must never reach the model's context.
    expect(JSON.stringify(result)).not.toContain("data");
  });

  it("critique_canvas fails recoverably before a capture", async () => {
    const { byName } = build();
    const result = (await byName.critique_canvas!.handler({}, context)) as {
      ok: false;
      errors: { code: string }[];
    };
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("CRITIQUE_NO_IMAGE");
  });

  it("critique_canvas returns findings after a capture", async () => {
    const { byName } = build();
    await byName.capture_canvas!.handler({}, context);
    const result = (await byName.critique_canvas!.handler({}, context)) as {
      ok: true;
      value: { findings: CritiqueFinding[] };
    };
    expect(result.value.findings).toEqual([finding]);
  });

  it("report_findings forwards only what it was given", async () => {
    const report = vi.fn(async () => {});
    const { byName } = build({ report });

    await byName.report_findings!.handler({ findings: [finding] }, context);
    expect(report).toHaveBeenCalledWith([finding]);
  });

  it("report_findings rejects a finding that is not well formed", async () => {
    const { byName } = build();
    const result = (await byName.report_findings!.handler(
      { findings: [{ check: "x" }] } as never,
      context,
    )) as { ok: false };
    expect(result.ok).toBe(false);
  });
});
