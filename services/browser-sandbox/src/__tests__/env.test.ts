/**
 * Tests for `loadConfig()` — the env→config seam.
 *
 * Mirrors the relay's discipline of "single source of truth for env
 * reads": every env-sensitive value flows through here so tests pin
 * the schema, defaults, and validation without touching `process.env`
 * directly anywhere else in the service.
 *
 * The `parseIntEnv("NAME", default)` helper is exercised through
 * `loadConfig` rather than directly — that's the same shape
 * `check-deploy-parity` recognises as a name-bound env reader, so
 * coverage of the seam covers the gate's recognition pattern too.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../env.js";

const STRONG_TOKEN = "x".repeat(32);
// 32-byte Ed25519 public key in hex = 64 chars. Real-shape value is
// crucial — `loadConfig()` rejects malformed pubkeys.
const STRONG_RELAY_PUBKEY = "a".repeat(64);

const CONFIG_KEYS = [
  "MOTEBIT_API_TOKEN",
  "MOTEBIT_TRUSTED_RELAY_PUBKEY",
  "MOTEBIT_PORT",
  "BROWSER_SANDBOX_MAX_SESSIONS",
  "BROWSER_SANDBOX_IDLE_MS",
  "BROWSER_SANDBOX_VIEWPORT_WIDTH",
  "BROWSER_SANDBOX_VIEWPORT_HEIGHT",
] as const;

describe("loadConfig", () => {
  // Snapshot + restore so tests don't leak env mutations into siblings
  // (vitest workers can interleave by default; per-test cleanup is
  // the load-bearing isolation here).
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = {};
    for (const k of CONFIG_KEYS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of CONFIG_KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("auth path validation (MOTEBIT_API_TOKEN | MOTEBIT_TRUSTED_RELAY_PUBKEY)", () => {
    it("throws when neither auth path is set", () => {
      expect(() => loadConfig()).toThrowError(/at least one of/i);
    });

    it("throws when both auth paths are empty", () => {
      process.env["MOTEBIT_API_TOKEN"] = "";
      process.env["MOTEBIT_TRUSTED_RELAY_PUBKEY"] = "";
      expect(() => loadConfig()).toThrowError(/at least one of/i);
    });

    it("throws when MOTEBIT_API_TOKEN is set but shorter than 16 chars", () => {
      process.env["MOTEBIT_API_TOKEN"] = "x".repeat(15);
      expect(() => loadConfig()).toThrowError(/shorter than 16 chars/);
    });

    it("throws when MOTEBIT_TRUSTED_RELAY_PUBKEY is set but malformed", () => {
      process.env["MOTEBIT_TRUSTED_RELAY_PUBKEY"] = "not-hex";
      expect(() => loadConfig()).toThrowError(/64-char hex/);
    });

    it("accepts MOTEBIT_API_TOKEN alone (legacy single-tenant)", () => {
      process.env["MOTEBIT_API_TOKEN"] = "x".repeat(16);
      const config = loadConfig();
      expect(config.apiToken).toBe("x".repeat(16));
      expect(config.trustedRelayPublicKeyHex).toBeNull();
    });

    it("accepts MOTEBIT_TRUSTED_RELAY_PUBKEY alone (federation-grade)", () => {
      process.env["MOTEBIT_TRUSTED_RELAY_PUBKEY"] = STRONG_RELAY_PUBKEY;
      const config = loadConfig();
      expect(config.apiToken).toBeNull();
      expect(config.trustedRelayPublicKeyHex).toBe(STRONG_RELAY_PUBKEY);
    });

    it("accepts both — dualAuth transition", () => {
      process.env["MOTEBIT_API_TOKEN"] = STRONG_TOKEN;
      process.env["MOTEBIT_TRUSTED_RELAY_PUBKEY"] = STRONG_RELAY_PUBKEY;
      const config = loadConfig();
      expect(config.apiToken).toBe(STRONG_TOKEN);
      expect(config.trustedRelayPublicKeyHex).toBe(STRONG_RELAY_PUBKEY);
    });

    it("normalizes pubkey hex to lowercase", () => {
      process.env["MOTEBIT_TRUSTED_RELAY_PUBKEY"] = "A".repeat(64);
      expect(loadConfig().trustedRelayPublicKeyHex).toBe("a".repeat(64));
    });
  });

  describe("defaults", () => {
    it("returns sensible defaults when only the token is set", () => {
      process.env["MOTEBIT_API_TOKEN"] = STRONG_TOKEN;
      const config = loadConfig();
      expect(config.port).toBe(3500);
      expect(config.maxConcurrentSessions).toBe(4);
      expect(config.sessionIdleMs).toBe(10 * 60 * 1000);
      expect(config.viewportWidth).toBe(1280);
      expect(config.viewportHeight).toBe(800);
    });
  });

  describe("env overrides", () => {
    beforeEach(() => {
      process.env["MOTEBIT_API_TOKEN"] = STRONG_TOKEN;
    });

    it("honors MOTEBIT_PORT when set", () => {
      process.env["MOTEBIT_PORT"] = "4000";
      expect(loadConfig().port).toBe(4000);
    });

    it("honors BROWSER_SANDBOX_MAX_SESSIONS", () => {
      process.env["BROWSER_SANDBOX_MAX_SESSIONS"] = "8";
      expect(loadConfig().maxConcurrentSessions).toBe(8);
    });

    it("honors BROWSER_SANDBOX_IDLE_MS", () => {
      process.env["BROWSER_SANDBOX_IDLE_MS"] = "30000";
      expect(loadConfig().sessionIdleMs).toBe(30_000);
    });

    it("honors BROWSER_SANDBOX_VIEWPORT_WIDTH and HEIGHT", () => {
      process.env["BROWSER_SANDBOX_VIEWPORT_WIDTH"] = "1920";
      process.env["BROWSER_SANDBOX_VIEWPORT_HEIGHT"] = "1080";
      const config = loadConfig();
      expect(config.viewportWidth).toBe(1920);
      expect(config.viewportHeight).toBe(1080);
    });
  });

  describe("parseIntEnv fallback shape", () => {
    beforeEach(() => {
      process.env["MOTEBIT_API_TOKEN"] = STRONG_TOKEN;
    });

    it("falls back to default for empty string env", () => {
      process.env["MOTEBIT_PORT"] = "";
      expect(loadConfig().port).toBe(3500);
    });

    it("falls back to default for non-numeric values", () => {
      process.env["MOTEBIT_PORT"] = "abc";
      expect(loadConfig().port).toBe(3500);
    });

    it("falls back to default for zero (not positive)", () => {
      process.env["MOTEBIT_PORT"] = "0";
      expect(loadConfig().port).toBe(3500);
    });

    it("falls back to default for negative values", () => {
      process.env["MOTEBIT_PORT"] = "-1";
      expect(loadConfig().port).toBe(3500);
    });
  });
});
