import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
import { createRelayConfigTable, loadFreezeState, persistFreeze } from "../freeze.js";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";

// === Unit tests for freeze persistence functions ===

describe("freeze persistence (unit)", () => {
  let db: DatabaseDriver;

  beforeEach(async () => {
    const moteDb = await openMotebitDatabase(":memory:");
    db = moteDb.db;
    createRelayConfigTable(db);
  });

  it("loadFreezeState returns unfrozen when no persisted state", () => {
    const state = loadFreezeState(db);
    expect(state.frozen).toBe(false);
    expect(state.reason).toBeNull();
  });

  it("persistFreeze writes to DB and updates cache", () => {
    const cache = { frozen: false, reason: null as string | null };

    persistFreeze(db, cache, true, "financial incident");

    // Cache is updated
    expect(cache.frozen).toBe(true);
    expect(cache.reason).toBe("financial incident");

    // DB is updated
    const loaded = loadFreezeState(db);
    expect(loaded.frozen).toBe(true);
    expect(loaded.reason).toBe("financial incident");
  });

  it("persistFreeze unfreeze clears state in DB and cache", () => {
    const cache = { frozen: true, reason: "test" as string | null };

    // Freeze first
    persistFreeze(db, cache, true, "incident");
    expect(loadFreezeState(db).frozen).toBe(true);

    // Unfreeze
    persistFreeze(db, cache, false, null);
    expect(cache.frozen).toBe(false);
    expect(cache.reason).toBeNull();

    const loaded = loadFreezeState(db);
    expect(loaded.frozen).toBe(false);
    expect(loaded.reason).toBeNull();
  });

  it("loadFreezeState survives corrupt JSON gracefully", () => {
    db.prepare("INSERT INTO relay_config (key, value) VALUES (?, ?)").run(
      "freeze_state",
      "not valid json{{{",
    );

    // Should not throw, returns default unfrozen
    const state = loadFreezeState(db);
    expect(state.frozen).toBe(false);
    expect(state.reason).toBeNull();
  });
});

// === Integration tests: freeze survives relay restart ===

describe("freeze persistence (integration)", () => {
  const API_TOKEN = "test-token";
  const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };
  const JSON_AUTH = { ...AUTH_HEADER, "Content-Type": "application/json" };

  let relay: SyncRelay;

  afterEach(() => {
    relay?.close();
  });

  it("freeze state persists across relay restart (same DB)", async () => {
    // Use a temp file DB so we can reopen it
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "motebit-freeze-"));
    const dbPath = join(dir, "test.db");

    // First relay: activate freeze
    relay = await createSyncRelay({
      dbPath,
      apiToken: API_TOKEN,
      enableDeviceAuth: false,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });

    const freezeRes = await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ reason: "double-credit suspected" }),
    });
    expect(freezeRes.status).toBe(200);
    expect(relay.emergencyFreeze).toBe(true);
    relay.close();

    // Second relay: same DB, freeze should be restored from DB
    relay = await createSyncRelay({
      dbPath,
      apiToken: API_TOKEN,
      enableDeviceAuth: false,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });

    expect(relay.emergencyFreeze).toBe(true);

    // Verify writes are blocked
    const writeRes = await relay.app.request("/sync/test-mote/push", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ events: [] }),
    });
    expect(writeRes.status).toBe(503);

    // Health should show frozen
    const healthRes = await relay.app.request("/health", { method: "GET" });
    const healthBody = (await healthRes.json()) as {
      frozen: boolean;
      freeze_reason?: string;
    };
    expect(healthBody.frozen).toBe(true);
    expect(healthBody.freeze_reason).toBe("double-credit suspected");

    // Clean up temp dir
    const { rmSync } = await import("node:fs");
    relay.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("unfreeze persists across restart", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "motebit-freeze-"));
    const dbPath = join(dir, "test.db");

    // First relay: freeze then unfreeze
    relay = await createSyncRelay({
      dbPath,
      apiToken: API_TOKEN,
      enableDeviceAuth: false,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });

    await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ reason: "investigation" }),
    });
    await relay.app.request("/api/v1/admin/unfreeze", {
      method: "POST",
      headers: AUTH_HEADER,
    });
    expect(relay.emergencyFreeze).toBe(false);
    relay.close();

    // Second relay: should start unfrozen
    relay = await createSyncRelay({
      dbPath,
      apiToken: API_TOKEN,
      enableDeviceAuth: false,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });

    expect(relay.emergencyFreeze).toBe(false);

    const { rmSync } = await import("node:fs");
    relay.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("config emergencyFreeze=true overrides unfrozen DB state and persists", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "motebit-freeze-"));
    const dbPath = join(dir, "test.db");

    // First relay: start with config override
    relay = await createSyncRelay({
      dbPath,
      apiToken: API_TOKEN,
      enableDeviceAuth: false,
      emergencyFreeze: true,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });

    expect(relay.emergencyFreeze).toBe(true);
    relay.close();

    // Second relay: no config override, but DB should have persisted freeze
    relay = await createSyncRelay({
      dbPath,
      apiToken: API_TOKEN,
      enableDeviceAuth: false,
      // emergencyFreeze NOT set
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });

    expect(relay.emergencyFreeze).toBe(true);

    const { rmSync } = await import("node:fs");
    relay.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
