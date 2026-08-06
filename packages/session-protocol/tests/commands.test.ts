import { describe, expect, it } from "vitest";
import { parseClientCommand, type ClientCommand } from "../src/index.js";

describe("parseClientCommand", () => {
  it("parses each command in the union", () => {
    const inputs: unknown[] = [
      { type: "StartSession", userInput: "Draw a movable pulley" },
      { type: "CancelSession", sessionId: "s1", reason: "user clicked stop" },
      { type: "FollowUpRequest", sessionId: "s1", message: "add a label" },
      { type: "AgentToolProxy", sessionId: "s1", toolName: "highlight", args: { objectId: "pulley" } },
    ];

    const types = inputs.map((input) => {
      const result = parseClientCommand(input);
      expect(result.ok, JSON.stringify(input)).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      return result.value.type;
    });

    expect(types).toEqual(["StartSession", "CancelSession", "FollowUpRequest", "AgentToolProxy"]);
  });

  it("exhausts in a switch, so a new command breaks its consumers loudly", () => {
    const route = (command: ClientCommand): string => {
      switch (command.type) {
        case "StartSession":
          return command.userInput;
        case "CancelSession":
          return command.sessionId;
        case "FollowUpRequest":
          return command.message;
        case "AgentToolProxy":
          return command.toolName;
      }
    };

    expect(route({ type: "StartSession", userInput: "hi" })).toBe("hi");
  });

  it("reports every problem at once rather than the first", () => {
    const result = parseClientCommand({ type: "AgentToolProxy", sessionId: "", toolName: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(1);
    expect(result.errors.map((e) => e.path)).toContain("sessionId");
  });

  it("rejects an unknown command type", () => {
    const result = parseClientCommand({ type: "DropDatabase", sessionId: "s1" });
    expect(result.ok).toBe(false);
  });

  it("rejects a prompt long enough to be an attack rather than a request", () => {
    const result = parseClientCommand({ type: "StartSession", userInput: "x".repeat(2001) });
    expect(result.ok).toBe(false);
  });

  it("attributes errors to this package, so a bad frame is traceable", () => {
    const result = parseClientCommand({ type: "StartSession", userInput: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.package).toBe("@sketchmind/session-protocol");
  });
});
