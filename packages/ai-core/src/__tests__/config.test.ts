import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveConfig, DEFAULT_CONFIG } from "../config";
import { loadConfig } from "../config-loader";

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

describe("resolveConfig", () => {
  it("returns all defaults for empty partial", () => {
    const result = resolveConfig({});
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it("merges partial overrides with defaults", () => {
    const result = resolveConfig({ name: "Pebble", temperature: 0.5 });
    expect(result.name).toBe("Pebble");
    expect(result.temperature).toBe(0.5);
    expect(result.personality_notes).toBe("");
    expect(result.default_provider).toBe("anthropic");
  });

  it("allows full override", () => {
    const full = {
      name: "Spark",
      personality_notes: "Witty and sharp.",
      default_provider: "ollama" as const,
      default_model: "mistral",
      temperature: 0.9,
    };
    const result = resolveConfig(full);
    expect(result).toEqual(full);
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  let tmpDir: string;
  // eslint-disable-next-line no-console
  const originalWarn = console.warn;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-config-test-"));
    // eslint-disable-next-line no-console
    console.warn = vi.fn();
  });

  afterEach(() => {
    // eslint-disable-next-line no-console
    console.warn = originalWarn;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns defaults when file is missing", () => {
    const result = loadConfig(path.join(tmpDir, "nonexistent.json"));
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it("parses valid JSON and merges with defaults", () => {
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ name: "Pebble", personality_notes: "Loves puns." }),
    );

    const result = loadConfig(configPath);
    expect(result.name).toBe("Pebble");
    expect(result.personality_notes).toBe("Loves puns.");
    expect(result.default_provider).toBe("anthropic");
    expect(result.temperature).toBe(0.7);
  });

  it("returns defaults with warning for malformed JSON", () => {
    const configPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(configPath, "{ not valid json");

    const result = loadConfig(configPath);
    expect(result).toEqual(DEFAULT_CONFIG);
    // eslint-disable-next-line no-console
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("malformed config"),
    );
  });
});
