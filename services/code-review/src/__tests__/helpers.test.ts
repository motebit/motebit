import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../helpers.js";

describe("loadConfig", () => {
  // Snapshot and restore every env var loadConfig reads so tests are hermetic.
  const KEYS = [
    "MOTEBIT_PORT",
    "MOTEBIT_DB_PATH",
    "MOTEBIT_DATA_DIR",
    "MOTEBIT_AUTH_TOKEN",
    "MOTEBIT_SYNC_URL",
    "MOTEBIT_API_TOKEN",
    "MOTEBIT_PUBLIC_URL",
    "ANTHROPIC_API_KEY",
    "MOTEBIT_READ_URL_URL",
    "MOTEBIT_READ_URL_TARGET_ID",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};
  for (const key of KEYS) snapshot[key] = process.env[key];
  // Start each test from a clean slate.
  for (const key of KEYS) delete process.env[key];

  afterEach(() => {
    for (const key of KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
      // Then clear again so the next test starts fresh — the restore above
      // only matters for the final test.
      if (snapshot[key] === undefined) delete process.env[key];
    }
    for (const key of KEYS) delete process.env[key];
  });

  it("falls back to defaults when env vars are unset", () => {
    const config = loadConfig();
    expect(config.port).toBe(3300);
    expect(config.dbPath).toBe("./data/code-review.db");
    expect(config.dataDir).toBe("./data");
    expect(config.authToken).toBeUndefined();
    expect(config.syncUrl).toBeUndefined();
    expect(config.apiToken).toBeUndefined();
    expect(config.publicUrl).toBeUndefined();
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.readUrlUrl).toBeUndefined();
    expect(config.readUrlTargetId).toBeUndefined();
  });

  it("parses MOTEBIT_PORT as an integer", () => {
    process.env["MOTEBIT_PORT"] = "4500";
    expect(loadConfig().port).toBe(4500);
  });

  it("reads MOTEBIT_DATA_DIR override", () => {
    process.env["MOTEBIT_DATA_DIR"] = "/data";
    expect(loadConfig().dataDir).toBe("/data");
  });

  it("reads MOTEBIT_DB_PATH override", () => {
    process.env["MOTEBIT_DB_PATH"] = "/custom/path.db";
    expect(loadConfig().dbPath).toBe("/custom/path.db");
  });

  it("propagates all optional fields when set", () => {
    process.env["MOTEBIT_AUTH_TOKEN"] = "auth";
    process.env["MOTEBIT_SYNC_URL"] = "https://sync";
    process.env["MOTEBIT_API_TOKEN"] = "api";
    process.env["MOTEBIT_PUBLIC_URL"] = "https://public";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant";
    process.env["MOTEBIT_READ_URL_URL"] = "http://localhost:3500/mcp";
    process.env["MOTEBIT_READ_URL_TARGET_ID"] = "mote-rdu-abc";

    const config = loadConfig();
    expect(config.authToken).toBe("auth");
    expect(config.syncUrl).toBe("https://sync");
    expect(config.apiToken).toBe("api");
    expect(config.publicUrl).toBe("https://public");
    expect(config.anthropicApiKey).toBe("sk-ant");
    expect(config.readUrlUrl).toBe("http://localhost:3500/mcp");
    expect(config.readUrlTargetId).toBe("mote-rdu-abc");
  });
});
