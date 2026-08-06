import { describe, expect, it } from "vitest";
import { runRepair } from "../src/session/repair.js";
import { ToolRegistry } from "@sketchmind/agent-core";
import { FakeProvider } from "@sketchmind/llm-provider";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session/manager.js";
import type { CritiqueFinding } from "@sketchmind/shared-types";

const finding: CritiqueFinding = {
  id: "f1",
  tier: "geometric",
  check: "overlap",
  severity: "error",
  message: "a and b overlap.",
  objectIds: ["a", "b"],
};

function setup() {
  const sessions = new SessionManager();
  const record = sessions.create("s1", "draw two boxes");
  const emitted: string[] = [];
  sessions.subscribe("s1", (event) => emitted.push(event.type));
  return { sessions, record, emitted };
}

describe("runRepair", () => {
  it("runs an agent turn and emits a VisionCritique event", async () => {
    const { sessions, record, emitted } = setup();
    await runRepair({
      sessionId: "s1",
      findings: [finding],
      provider: new FakeProvider({ responses: ["fixed"] }),
      registry: new ToolRegistry([]),
      config: loadConfig({}),
      record,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(emitted).toContain("VisionCritique");
    expect(record.repairRounds).toBe(1);
  });

  it("refuses once the repair round cap is reached", async () => {
    const { sessions, record } = setup();
    record.repairRounds = 2;
    const provider = new FakeProvider({ responses: ["fixed"] });

    await runRepair({
      sessionId: "s1",
      findings: [finding],
      provider,
      registry: new ToolRegistry([]),
      config: loadConfig({}),
      record,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(provider.calls).toHaveLength(0);
    expect(record.repairRounds).toBe(2);
  });

  it("refuses when the findings repeat the previous round", async () => {
    const { sessions, record } = setup();
    record.lastFindings = [finding];
    const provider = new FakeProvider({ responses: ["fixed"] });

    await runRepair({
      sessionId: "s1",
      findings: [finding],
      provider,
      registry: new ToolRegistry([]),
      config: loadConfig({}),
      record,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(provider.calls).toHaveLength(0);
  });

  it("does nothing for an empty findings list", async () => {
    const { sessions, record } = setup();
    const provider = new FakeProvider({ responses: ["fixed"] });

    await runRepair({
      sessionId: "s1",
      findings: [],
      provider,
      registry: new ToolRegistry([]),
      config: loadConfig({}),
      record,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(provider.calls).toHaveLength(0);
    expect(record.repairRounds).toBe(0);
  });

  it("terminates against findings that never change", async () => {
    const { sessions, record } = setup();
    const provider = new FakeProvider({ responses: ["still broken"] });
    const emit = (event: Parameters<typeof sessions.emit>[1]) => sessions.emit("s1", event);

    for (let round = 0; round < 10; round += 1) {
      await runRepair({
        sessionId: "s1",
        findings: [finding],
        provider,
        registry: new ToolRegistry([]),
        config: loadConfig({}),
        record,
        emit,
      });
    }

    expect(record.repairRounds).toBeLessThanOrEqual(2);
  });
});
