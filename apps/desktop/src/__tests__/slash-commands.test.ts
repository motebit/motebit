import { describe, it, expect } from "vitest";
import {
  isSlashCommand,
  parseSlashCommand,
  filterCommands,
  formatHelpText,
  SLASH_COMMANDS,
  COMMAND_MAP,
} from "../ui/slash-commands";

// ---------------------------------------------------------------------------
// isSlashCommand
// ---------------------------------------------------------------------------

describe("isSlashCommand", () => {
  it("returns true for strings starting with /", () => {
    expect(isSlashCommand("/model")).toBe(true);
    expect(isSlashCommand("/help")).toBe(true);
    expect(isSlashCommand("/model mistral")).toBe(true);
    expect(isSlashCommand("/")).toBe(true);
  });

  it("returns false for regular text", () => {
    expect(isSlashCommand("hello")).toBe(false);
    expect(isSlashCommand("")).toBe(false);
    expect(isSlashCommand(" /model")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseSlashCommand
// ---------------------------------------------------------------------------

describe("parseSlashCommand", () => {
  it("parses command without args", () => {
    expect(parseSlashCommand("/model")).toEqual({ command: "model", args: "" });
    expect(parseSlashCommand("/help")).toEqual({ command: "help", args: "" });
  });

  it("parses command with args", () => {
    expect(parseSlashCommand("/model mistral")).toEqual({ command: "model", args: "mistral" });
    expect(parseSlashCommand("/forget node-123")).toEqual({ command: "forget", args: "node-123" });
  });

  it("trims whitespace from args", () => {
    expect(parseSlashCommand("/model  spaced  arg ")).toEqual({
      command: "model",
      args: "spaced  arg",
    });
  });

  it("handles single slash", () => {
    expect(parseSlashCommand("/")).toEqual({ command: "", args: "" });
  });

  it("lowercases command name", () => {
    expect(parseSlashCommand("/MODEL")).toEqual({ command: "model", args: "" });
    expect(parseSlashCommand("/Help")).toEqual({ command: "help", args: "" });
    expect(parseSlashCommand("/Model Mistral")).toEqual({ command: "model", args: "Mistral" });
  });

  it("trims leading/trailing whitespace from input", () => {
    expect(parseSlashCommand("  /model  ")).toEqual({ command: "model", args: "" });
    expect(parseSlashCommand("  /model foo  ")).toEqual({ command: "model", args: "foo" });
  });
});

// ---------------------------------------------------------------------------
// filterCommands
// ---------------------------------------------------------------------------

describe("filterCommands", () => {
  it("returns all commands when partial is empty", () => {
    const result = filterCommands("");
    expect(result).toEqual(SLASH_COMMANDS);
    expect(result.length).toBeGreaterThan(0);
  });

  it("filters by prefix", () => {
    const result = filterCommands("m");
    expect(result.every((cmd) => cmd.name.startsWith("m"))).toBe(true);
    expect(result.map((cmd) => cmd.name)).toContain("model");
    expect(result.map((cmd) => cmd.name)).toContain("memories");
  });

  it("returns exact match", () => {
    const result = filterCommands("help");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("help");
  });

  it("returns empty array for non-matching prefix", () => {
    const result = filterCommands("xyz");
    expect(result).toEqual([]);
  });

  it("is case-insensitive", () => {
    const result = filterCommands("M");
    expect(result.map((cmd) => cmd.name)).toContain("model");
    expect(result.map((cmd) => cmd.name)).toContain("memories");
  });

  it("filters to single match for unique prefix", () => {
    const result = filterCommands("oper");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("operator");
  });

  it("returns multiple matches for shared prefix", () => {
    const result = filterCommands("s");
    expect(result.length).toBeGreaterThanOrEqual(2);
    const names = result.map((cmd) => cmd.name);
    expect(names).toContain("state");
    expect(names).toContain("settings");
    expect(names).toContain("summarize");
    expect(names).toContain("sync");
  });
});

// ---------------------------------------------------------------------------
// formatHelpText
// ---------------------------------------------------------------------------

describe("formatHelpText", () => {
  it("starts with 'Available commands:'", () => {
    const text = formatHelpText();
    expect(text.startsWith("Available commands:")).toBe(true);
  });

  it("includes all registered commands", () => {
    const text = formatHelpText();
    for (const cmd of SLASH_COMMANDS) {
      expect(text).toContain(`/${cmd.name}`);
    }
  });

  it("includes descriptions", () => {
    const text = formatHelpText();
    for (const cmd of SLASH_COMMANDS) {
      expect(text).toContain(cmd.description);
    }
  });

  it("includes arg hints for commands that accept args", () => {
    const text = formatHelpText();
    const cmdsWithArgs = SLASH_COMMANDS.filter((cmd) => cmd.hasArgs === true);
    expect(cmdsWithArgs.length).toBeGreaterThan(0);
    for (const cmd of cmdsWithArgs) {
      if (cmd.argHint != null && cmd.argHint !== "") {
        expect(text).toContain(cmd.argHint);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// SLASH_COMMANDS + COMMAND_MAP consistency
// ---------------------------------------------------------------------------

describe("SLASH_COMMANDS", () => {
  it("has no duplicate command names", () => {
    const names = SLASH_COMMANDS.map((cmd) => cmd.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("all commands have non-empty name and description", () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.name.length).toBeGreaterThan(0);
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  it("includes the 14 expected commands", () => {
    const expected = [
      "model",
      "memories",
      "state",
      "forget",
      "export",
      "clear",
      "conversations",
      "goals",
      "tools",
      "settings",
      "operator",
      "summarize",
      "sync",
      "help",
    ];
    const names = SLASH_COMMANDS.map((cmd) => cmd.name);
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });
});

describe("COMMAND_MAP", () => {
  it("has the same size as SLASH_COMMANDS", () => {
    expect(COMMAND_MAP.size).toBe(SLASH_COMMANDS.length);
  });

  it("maps every command by name", () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(COMMAND_MAP.get(cmd.name)).toBe(cmd);
    }
  });
});
