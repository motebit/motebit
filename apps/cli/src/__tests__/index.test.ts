import { describe, it, expect } from "vitest";
import {
  parseCliArgs,
  printHelp,
  printVersion,
  trimHistory,
  isSlashCommand,
  parseSlashCommand,
} from "../index.js";

describe("parseCliArgs", () => {
  it("returns defaults when no args provided", () => {
    const config = parseCliArgs([]);
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.dbPath).toBeUndefined();
    expect(config.noStream).toBe(false);
    expect(config.version).toBe(false);
    expect(config.help).toBe(false);
  });

  it("parses --provider anthropic with default model", () => {
    const config = parseCliArgs(["--provider", "anthropic"]);
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-6");
  });

  it("parses --provider local-server with default model", () => {
    const config = parseCliArgs(["--provider", "local-server"]);
    expect(config.provider).toBe("local-server");
    expect(config.model).toBe("llama3.2");
  });

  it("accepts --provider ollama as an ergonomic alias for local-server", () => {
    const config = parseCliArgs(["--provider", "ollama"]);
    // Internal representation is always the vendor-agnostic name.
    expect(config.provider).toBe("local-server");
    expect(config.model).toBe("llama3.2");
  });

  it("--model overrides provider default", () => {
    const config = parseCliArgs(["--provider", "local-server", "--model", "mistral"]);
    expect(config.provider).toBe("local-server");
    expect(config.model).toBe("mistral");
  });

  it("parses openai provider", () => {
    const config = parseCliArgs(["--provider", "openai"]);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-5.4-mini");
  });

  it("throws on unknown provider", () => {
    expect(() => parseCliArgs(["--provider", "gemini"])).toThrow('Unknown provider "gemini"');
  });

  it("parses --model flag", () => {
    const config = parseCliArgs(["--model", "claude-haiku-3"]);
    expect(config.model).toBe("claude-haiku-3");
  });

  it("parses --db-path flag", () => {
    const config = parseCliArgs(["--db-path", "/tmp/test.db"]);
    expect(config.dbPath).toBe("/tmp/test.db");
  });

  it("parses --no-stream flag", () => {
    const config = parseCliArgs(["--no-stream"]);
    expect(config.noStream).toBe(true);
  });

  it("parses --version flag", () => {
    const config = parseCliArgs(["--version"]);
    expect(config.version).toBe(true);
  });

  it("parses -v short flag", () => {
    const config = parseCliArgs(["-v"]);
    expect(config.version).toBe(true);
  });

  it("parses --help flag", () => {
    const config = parseCliArgs(["--help"]);
    expect(config.help).toBe(true);
  });

  it("parses -h short flag", () => {
    const config = parseCliArgs(["-h"]);
    expect(config.help).toBe(true);
  });

  it("parses --sync-url and --sync-token", () => {
    const config = parseCliArgs(["--sync-url", "http://localhost:3000", "--sync-token", "tok"]);
    expect(config.syncUrl).toBe("http://localhost:3000");
    expect(config.syncToken).toBe("tok");
  });

  it("defaults syncUrl and syncToken to undefined", () => {
    const config = parseCliArgs([]);
    expect(config.syncUrl).toBeUndefined();
    expect(config.syncToken).toBeUndefined();
  });

  it("parses multiple flags together", () => {
    const config = parseCliArgs(["--model", "gpt-4", "--no-stream", "--db-path", "/tmp/db"]);
    expect(config.model).toBe("gpt-4");
    expect(config.noStream).toBe(true);
    expect(config.dbPath).toBe("/tmp/db");
  });

  it("throws on unknown flags", () => {
    expect(() => parseCliArgs(["--unknown"])).toThrow();
  });
});

describe("printHelp", () => {
  it("does not throw", () => {
    expect(() => printHelp()).not.toThrow();
  });
});

describe("printVersion", () => {
  it("does not throw", () => {
    expect(() => printVersion()).not.toThrow();
  });
});

describe("trimHistory", () => {
  it("returns history unchanged when under limit", () => {
    const history = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    expect(trimHistory(history)).toEqual(history);
  });

  it("caps at 40 messages (20 exchanges)", () => {
    const history: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 0; i < 25; i++) {
      history.push({ role: "user", content: `msg ${i}` });
      history.push({ role: "assistant", content: `reply ${i}` });
    }
    // 50 messages total, should trim to 40
    const trimmed = trimHistory(history);
    expect(trimmed.length).toBe(40);
    // Should keep the last 40 messages (exchanges 5-24)
    expect(trimmed[0]).toEqual({ role: "user", content: "msg 5" });
    expect(trimmed[trimmed.length - 1]).toEqual({ role: "assistant", content: "reply 24" });
  });

  it("returns exact 40 messages unchanged", () => {
    const history: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 0; i < 20; i++) {
      history.push({ role: "user", content: `msg ${i}` });
      history.push({ role: "assistant", content: `reply ${i}` });
    }
    expect(trimHistory(history)).toEqual(history);
    expect(trimHistory(history).length).toBe(40);
  });
});

describe("isSlashCommand", () => {
  it("returns true for slash-prefixed input", () => {
    expect(isSlashCommand("/help")).toBe(true);
    expect(isSlashCommand("/memories")).toBe(true);
    expect(isSlashCommand("/forget abc-123")).toBe(true);
  });

  it("returns false for regular input", () => {
    expect(isSlashCommand("hello")).toBe(false);
    expect(isSlashCommand("quit")).toBe(false);
    expect(isSlashCommand("")).toBe(false);
  });
});

describe("parseSlashCommand", () => {
  it("parses command without args", () => {
    expect(parseSlashCommand("/help")).toEqual({ command: "help", args: "" });
    expect(parseSlashCommand("/memories")).toEqual({ command: "memories", args: "" });
    expect(parseSlashCommand("/clear")).toEqual({ command: "clear", args: "" });
    expect(parseSlashCommand("/state")).toEqual({ command: "state", args: "" });
    expect(parseSlashCommand("/export")).toEqual({ command: "export", args: "" });
  });

  it("parses command with args", () => {
    expect(parseSlashCommand("/forget abc-123")).toEqual({
      command: "forget",
      args: "abc-123",
    });
    expect(parseSlashCommand("/model claude-haiku-3")).toEqual({
      command: "model",
      args: "claude-haiku-3",
    });
  });

  it("trims whitespace from args", () => {
    expect(parseSlashCommand("/forget   abc-123  ")).toEqual({
      command: "forget",
      args: "abc-123",
    });
  });
});
