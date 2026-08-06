import { describe, expect, it } from "vitest";
import { FakeProvider } from "@sketchmind/llm-provider";
import { critiqueImage } from "../src/index.js";

const image = {
  mimeType: "image/png",
  width: 4,
  height: 4,
  data: new Uint8Array([137, 80, 78, 71]),
};

const base = { image, request: "draw a pulley system", layoutSummary: "2 nodes, 1 connector" };

const findingJson = JSON.stringify({
  findings: [
    {
      check: "reads-wrong",
      severity: "warning",
      message: "The rope hangs beside the pulley rather than over it.",
      objectIds: ["rope_1"],
      proposal: { kind: "move_object", objectId: "rope_1", hint: "drape it over the wheel" },
    },
  ],
});

describe("critiqueImage", () => {
  it("parses findings and tags them visual", async () => {
    const provider = new FakeProvider({ capabilities: { vision: true }, responses: [findingJson] });
    const result = await critiqueImage({ provider, ...base });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.tier).toBe("visual");
    expect(result.value[0]?.id).toBeTruthy();
  });

  it("returns a validation failure for unparseable output rather than throwing", async () => {
    const provider = new FakeProvider({ capabilities: { vision: true }, responses: ["I think it looks fine!"] });
    const result = await critiqueImage({ provider, ...base });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("CRITIQUE_UNPARSEABLE");
    expect(result.errors[0]?.recoverable).toBe(true);
  });

  it("returns a validation failure for a schema-invalid finding", async () => {
    const bad = JSON.stringify({ findings: [{ check: "x", severity: "catastrophic", message: "m" }] });
    const provider = new FakeProvider({ capabilities: { vision: true }, responses: [bad] });

    const result = await critiqueImage({ provider, ...base });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Each issue must carry its own `path` -- that is what lets the agent target
    // a repair ("finding[0].severity is invalid") instead of a collapsed string.
    expect(result.errors[0]?.path).toBeTruthy();
  });

  it("refuses a provider that cannot see, without calling it", async () => {
    const provider = new FakeProvider({ capabilities: { vision: false } });
    const result = await critiqueImage({ provider, ...base });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("CRITIQUE_VISION_UNAVAILABLE");
    expect(provider.calls).toHaveLength(0);
  });

  it("accepts an empty findings list as a clean verdict", async () => {
    const provider = new FakeProvider({
      capabilities: { vision: true },
      responses: [JSON.stringify({ findings: [] })],
    });
    const result = await critiqueImage({ provider, ...base });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("sends the image and never the layout coordinates", async () => {
    const provider = new FakeProvider({
      capabilities: { vision: true },
      responses: [JSON.stringify({ findings: [] })],
    });
    // Ids and counts only -- if a coordinate ever leaked into `layoutSummary`
    // upstream, this test's own fixture would already violate the guarantee it
    // is meant to check, so the shape here matters as much as the assertion.
    const layoutSummary = "2 nodes (pulley_1, rope_1), 1 connector";
    await critiqueImage({ provider, image, request: "draw a pulley system", layoutSummary });

    const sent = JSON.stringify(provider.calls[0]);
    expect(sent).toContain("draw a pulley system");

    // The image travels as base64, not as coordinates -- assert the bytes are
    // actually present in what was sent.
    const expectedBase64 = Buffer.from(image.data).toString("base64");
    expect(sent).toContain(expectedBase64);

    // No coordinate-shaped content: no bare numbers (pixel/point values), and
    // none of the field names a layout model would use to carry geometry.
    expect(sent).not.toMatch(/"x"\s*:\s*-?\d/);
    expect(sent).not.toMatch(/"y"\s*:\s*-?\d/);
    expect(sent).not.toMatch(/\b\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\b/);
  });
});
