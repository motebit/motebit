import { describe, it, expect, afterEach } from "vitest";
import { fromHex, loadConfig } from "../helpers.js";

describe("fromHex", () => {
  it("decodes a hex string to Uint8Array", () => {
    expect(fromHex("deadbeef")).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("handles empty string", () => {
    expect(fromHex("")).toEqual(new Uint8Array(0));
  });

  it("round-trips with all byte values", () => {
    const hex = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0")).join("");
    const bytes = fromHex(hex);
    expect(bytes.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      expect(bytes[i]).toBe(i);
    }
  });

  it("is case-insensitive", () => {
    expect(fromHex("DEADBEEF")).toEqual(fromHex("deadbeef"));
  });
});

describe("loadConfig", () => {
  const KEYS = [
    "MOTEBIT_PORT",
    "MOTEBIT_DB_PATH",
    "MOTEBIT_DATA_DIR",
    "MOTEBIT_AUTH_TOKEN",
    "MOTEBIT_SYNC_URL",
    "MOTEBIT_API_TOKEN",
    "MOTEBIT_PUBLIC_URL",
    "ANTHROPIC_API_KEY",
    "MOTEBIT_WEB_SEARCH_URL",
    "MOTEBIT_READ_URL_URL",
    "MOTEBIT_WEB_SEARCH_TARGET_ID",
    "MOTEBIT_READ_URL_TARGET_ID",
    "MOTEBIT_MAX_TOOL_CALLS",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};
  for (const key of KEYS) snapshot[key] = process.env[key];
  for (const key of KEYS) delete process.env[key];

  afterEach(() => {
    for (const key of KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
      if (snapshot[key] === undefined) delete process.env[key];
    }
    for (const key of KEYS) delete process.env[key];
  });

  it("falls back to defaults when env vars are unset", () => {
    const config = loadConfig();
    expect(config.port).toBe(3400);
    expect(config.dbPath).toBe("./data/research.db");
    expect(config.dataDir).toBe("./data");
    expect(config.authToken).toBeUndefined();
    expect(config.syncUrl).toBeUndefined();
    expect(config.apiToken).toBeUndefined();
    expect(config.publicUrl).toBeUndefined();
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.webSearchUrl).toBeUndefined();
    expect(config.readUrlUrl).toBeUndefined();
    expect(config.webSearchTargetId).toBeUndefined();
    expect(config.readUrlTargetId).toBeUndefined();
    expect(config.maxToolCalls).toBe(8);
  });

  it("parses MOTEBIT_PORT as integer", () => {
    process.env["MOTEBIT_PORT"] = "4500";
    expect(loadConfig().port).toBe(4500);
  });

  it("parses MOTEBIT_MAX_TOOL_CALLS as integer", () => {
    process.env["MOTEBIT_MAX_TOOL_CALLS"] = "12";
    expect(loadConfig().maxToolCalls).toBe(12);
  });

  it("reads MOTEBIT_DATA_DIR override", () => {
    process.env["MOTEBIT_DATA_DIR"] = "/data";
    expect(loadConfig().dataDir).toBe("/data");
  });

  it("reads MOTEBIT_DB_PATH override", () => {
    process.env["MOTEBIT_DB_PATH"] = "/custom/path.db";
    expect(loadConfig().dbPath).toBe("/custom/path.db");
  });

  it("reads atom URLs and target IDs", () => {
    process.env["MOTEBIT_WEB_SEARCH_URL"] = "http://web-search:3200/mcp";
    process.env["MOTEBIT_READ_URL_URL"] = "http://read-url:3500/mcp";
    process.env["MOTEBIT_WEB_SEARCH_TARGET_ID"] = "ws-mote";
    process.env["MOTEBIT_READ_URL_TARGET_ID"] = "ru-mote";
    const config = loadConfig();
    expect(config.webSearchUrl).toBe("http://web-search:3200/mcp");
    expect(config.readUrlUrl).toBe("http://read-url:3500/mcp");
    expect(config.webSearchTargetId).toBe("ws-mote");
    expect(config.readUrlTargetId).toBe("ru-mote");
  });

  it("propagates all optional fields when set", () => {
    process.env["MOTEBIT_AUTH_TOKEN"] = "auth";
    process.env["MOTEBIT_SYNC_URL"] = "https://sync";
    process.env["MOTEBIT_API_TOKEN"] = "api";
    process.env["MOTEBIT_PUBLIC_URL"] = "https://public";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant";

    const config = loadConfig();
    expect(config.authToken).toBe("auth");
    expect(config.syncUrl).toBe("https://sync");
    expect(config.apiToken).toBe("api");
    expect(config.publicUrl).toBe("https://public");
    expect(config.anthropicApiKey).toBe("sk-ant");
  });
});
