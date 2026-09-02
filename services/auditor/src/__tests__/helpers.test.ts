/**
 * Auditor config loading.
 *
 * `services/auditor` carried no `vitest.config.ts` (#546), so it had no coverage
 * floor and — without a config — vitest measured only the files its tests
 * imported, leaving `helpers.ts` out of the denominator entirely.
 *
 * The property worth pinning here is the relay-key posture. `relayPublicKey`
 * absent means trust-on-first-use via the verified self-signature of
 * `/.well-known/motebit-transparency.json`; present means a hard pin whose
 * mismatch is a refusal. Those are different trust models, so "absent" must stay
 * `null` and never be quietly defaulted to something.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../helpers.js";

const TOUCHED = [
  "MOTEBIT_PORT",
  "MOTEBIT_DB_PATH",
  "MOTEBIT_DATA_DIR",
  "MOTEBIT_RELAY_URL",
  "MOTEBIT_RELAY_PUBLIC_KEY",
  "MOTEBIT_RECEIPT_SAMPLE_N",
  "MOTEBIT_UNIT_COST",
  "MOTEBIT_AUTH_TOKEN",
  "MOTEBIT_SYNC_URL",
  "MOTEBIT_API_TOKEN",
  "MOTEBIT_PUBLIC_URL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("auditor loadConfig — relay resolution", () => {
  it("prefers MOTEBIT_RELAY_URL over MOTEBIT_SYNC_URL", () => {
    process.env["MOTEBIT_RELAY_URL"] = "https://audit-target.example";
    process.env["MOTEBIT_SYNC_URL"] = "https://home-relay.example";
    // The audit TARGET and the auditor's own home relay are different roles and
    // may be different hosts; the explicit target must win.
    expect(loadConfig().relayUrl).toBe("https://audit-target.example");
  });

  it("falls back to MOTEBIT_SYNC_URL when no explicit target is set", () => {
    process.env["MOTEBIT_SYNC_URL"] = "https://home-relay.example";
    expect(loadConfig().relayUrl).toBe("https://home-relay.example");
  });

  it("is null when neither is set — no invented audit target", () => {
    expect(loadConfig().relayUrl).toBeNull();
  });

  it("leaves an absent relay key null so trust-on-first-use stays the posture", () => {
    // Absent ⇒ TOFU via the verified self-signature. A fabricated default here
    // would silently become a pin against the wrong key.
    expect(loadConfig().relayPublicKey).toBeNull();
    process.env["MOTEBIT_RELAY_PUBLIC_KEY"] = "cd".repeat(32);
    expect(loadConfig().relayPublicKey).toBe("cd".repeat(32));
  });
});

describe("auditor loadConfig — defaults and overrides", () => {
  it("supplies defaults with no environment at all", () => {
    const c = loadConfig();
    expect(c.port).toBe(3600);
    expect(c.dbPath).toBe("./data/auditor.db");
    expect(c.dataDir).toBe("./data");
    expect(c.receiptSampleN).toBe(3);
    expect(c.unitCost).toBe(0.01);
    expect(c.authToken).toBeNull();
    expect(c.apiToken).toBeNull();
    expect(c.publicUrl).toBeNull();
  });

  it("reads every override from the environment", () => {
    process.env["MOTEBIT_PORT"] = "4200";
    process.env["MOTEBIT_DB_PATH"] = "/tmp/a.db";
    process.env["MOTEBIT_DATA_DIR"] = "/tmp/adata";
    process.env["MOTEBIT_RECEIPT_SAMPLE_N"] = "7";
    process.env["MOTEBIT_UNIT_COST"] = "0.5";
    process.env["MOTEBIT_AUTH_TOKEN"] = "tok";
    process.env["MOTEBIT_API_TOKEN"] = "api";
    process.env["MOTEBIT_PUBLIC_URL"] = "https://auditor.example";

    const c = loadConfig();
    expect(c.port).toBe(4200);
    expect(c.dbPath).toBe("/tmp/a.db");
    expect(c.dataDir).toBe("/tmp/adata");
    expect(c.receiptSampleN).toBe(7);
    expect(c.unitCost).toBe(0.5);
    expect(c.authToken).toBe("tok");
    expect(c.apiToken).toBe("api");
    expect(c.publicUrl).toBe("https://auditor.example");
  });
});
