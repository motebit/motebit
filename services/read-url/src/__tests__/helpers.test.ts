import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, fromHex } from "../helpers.js";

describe("fromHex", () => {
  it("converts hex string to Uint8Array", () => {
    const result = fromHex("deadbeef");
    expect(result).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("handles all zeros", () => {
    const result = fromHex("00000000");
    expect(result).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it("handles all ff", () => {
    const result = fromHex("ffff");
    expect(result).toEqual(new Uint8Array([255, 255]));
  });

  it("returns empty array for empty string", () => {
    const result = fromHex("");
    expect(result).toEqual(new Uint8Array([]));
  });

  it("handles a 32-byte Ed25519 public key hex", () => {
    const hex = "a".repeat(64); // 32 bytes
    const result = fromHex(hex);
    expect(result.length).toBe(32);
    expect(result.every((b) => b === 0xaa)).toBe(true);
  });
});

describe("loadConfig", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "MOTEBIT_PORT",
    "MOTEBIT_DB_PATH",
    "MOTEBIT_IDENTITY_PATH",
    "MOTEBIT_PRIVATE_KEY_HEX",
    "MOTEBIT_SYNC_URL",
    "MOTEBIT_API_TOKEN",
    "MOTEBIT_PUBLIC_URL",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("returns defaults when no env vars set", () => {
    const config = loadConfig();
    expect(config.port).toBe(3200);
    expect(config.dbPath).toBe("./data/read-url.db");
    expect(config.identityPath).toBe("./motebit.md");
    expect(config.privateKeyHex).toBeUndefined();
    expect(config.syncUrl).toBeUndefined();
    expect(config.apiToken).toBeUndefined();
    expect(config.publicUrl).toBeUndefined();
  });

  it("reads port from MOTEBIT_PORT", () => {
    process.env["MOTEBIT_PORT"] = "4500";
    const config = loadConfig();
    expect(config.port).toBe(4500);
  });

  it("reads all optional env vars", () => {
    process.env["MOTEBIT_DB_PATH"] = "/tmp/test.db";
    process.env["MOTEBIT_IDENTITY_PATH"] = "/etc/motebit.md";
    process.env["MOTEBIT_PRIVATE_KEY_HEX"] = "abcd";
    process.env["MOTEBIT_SYNC_URL"] = "https://relay.example.com";
    process.env["MOTEBIT_API_TOKEN"] = "tok_123";
    process.env["MOTEBIT_PUBLIC_URL"] = "https://agent.example.com";

    const config = loadConfig();
    expect(config.dbPath).toBe("/tmp/test.db");
    expect(config.identityPath).toBe("/etc/motebit.md");
    expect(config.privateKeyHex).toBe("abcd");
    expect(config.syncUrl).toBe("https://relay.example.com");
    expect(config.apiToken).toBe("tok_123");
    expect(config.publicUrl).toBe("https://agent.example.com");
  });
});
