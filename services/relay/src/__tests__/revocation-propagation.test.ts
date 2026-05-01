/**
 * Revocation propagation via federation heartbeat.
 *
 * Tests: insertion, querying, cleanup of revocation events,
 * processing of incoming events (valid/invalid signatures),
 * and unknown event type handling.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createFederationTables,
  insertRevocationEvent,
  getRevocationEventsSince,
  processIncomingRevocations,
} from "../federation.js";
import type { RelayIdentity, RevocationEvent } from "../federation.js";
import { advanceRevocationHorizon } from "../horizon.js";
import { createPairingTables } from "../pairing.js";
import { runMigrations, relayMigrations } from "../migrations.js";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, sign, bytesToHex } from "@motebit/encryption";

describe("Revocation Propagation", () => {
  let db: DatabaseDriver;
  let identity: RelayIdentity;

  beforeEach(async () => {
    const keypair = await generateKeypair();
    identity = {
      relayMotebitId: `relay-${crypto.randomUUID()}`,
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      publicKeyHex: bytesToHex(keypair.publicKey),
      did: `did:key:z${bytesToHex(keypair.publicKey).slice(0, 16)}`,
    };

    const moteDb = await openMotebitDatabase(":memory:");
    db = moteDb.db;
    createFederationTables(db);
    createPairingTables(db);
    // Phase 4b-3 horizon-cert tables (v16) — `advanceRevocationHorizon`
    // requires `relay_horizon_certs` to persist its signed cert before
    // truncating. Run all migrations rather than partial-bootstrapping
    // since the migration framework is the canonical setup path.
    runMigrations(db, relayMigrations);

    // Create agent_registry and relay_revoked_credentials for processing tests
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_registry (
        motebit_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        endpoint_url TEXT,
        capabilities TEXT,
        metadata TEXT,
        registered_at INTEGER,
        last_heartbeat INTEGER,
        expires_at INTEGER,
        revoked INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS relay_revoked_credentials (
        credential_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        revoked_at TEXT DEFAULT (datetime('now')),
        reason TEXT,
        revoked_by TEXT
      );
    `);
  });

  it("inserts and retrieves revocation events", async () => {
    await insertRevocationEvent(db, identity, "agent_revoked", "agent-1");
    const events = getRevocationEventsSince(db, 0);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("agent_revoked");
    expect(events[0]!.motebit_id).toBe("agent-1");
  });

  it("key rotation event includes new_public_key", async () => {
    await insertRevocationEvent(db, identity, "key_rotated", "agent-2", {
      newPublicKey: "abc123",
    });
    const events = getRevocationEventsSince(db, 0);
    expect(events).toHaveLength(1);
    expect(events[0]!.new_public_key).toBe("abc123");
  });

  it("credential revocation event includes credential_id", async () => {
    await insertRevocationEvent(db, identity, "credential_revoked", "agent-3", {
      credentialId: "cred-xyz",
    });
    const events = getRevocationEventsSince(db, 0);
    expect(events).toHaveLength(1);
    expect(events[0]!.credential_id).toBe("cred-xyz");
  });

  it("filters events by timestamp", async () => {
    await insertRevocationEvent(db, identity, "agent_revoked", "agent-1");
    const future = Date.now() + 10_000;
    const events = getRevocationEventsSince(db, future);
    expect(events).toHaveLength(0);
  });

  it("advances the revocation horizon — signed self-witnessed cert truncates >7d events", async () => {
    // Phase 4b-3 — `cleanupRevocationEvents` is gone; the replacement
    // is `advanceRevocationHorizon`, which signs an
    // `append_only_horizon` cert (self-witnessed when no peers exist,
    // as in this test setup) before truncating the prefix.
    await insertRevocationEvent(db, identity, "agent_revoked", "old-agent");
    const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    db.prepare("UPDATE relay_revocation_events SET timestamp = ?").run(oldTimestamp);

    const result = await advanceRevocationHorizon(db, { relayIdentity: identity });
    expect(result.truncatedCount).toBe(1);
    expect(result.selfWitnessed).toBe(true);
    expect(result.cert.witnessed_by).toEqual([]);
    expect(result.cert.federation_graph_anchor?.leaf_count).toBe(0);
    expect(getRevocationEventsSince(db, 0)).toHaveLength(0);
    // Cert persisted in relay_horizon_certs for future audit / dispute lookup.
    const persisted = db
      .prepare("SELECT cert_signature, store_id FROM relay_horizon_certs WHERE store_id = ?")
      .get("relay_revocation_events") as { cert_signature: string; store_id: string } | undefined;
    expect(persisted?.cert_signature).toBe(result.cert.signature);
  });

  describe("processIncomingRevocations", () => {
    it("processes agent revocation with valid signature", async () => {
      const motebitId = "agent-to-revoke";
      const now = Date.now();
      db.prepare(
        "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, registered_at, last_heartbeat, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(motebitId, "deadbeef", "http://test.local", now, now, now + 86_400_000);

      const timestamp = Date.now();
      const payload = `revocation:agent_revoked:${motebitId}:${timestamp}`;
      const sig = await sign(new TextEncoder().encode(payload), identity.privateKey);

      const events: RevocationEvent[] = [
        {
          type: "agent_revoked",
          motebit_id: motebitId,
          timestamp,
          signature: bytesToHex(sig),
        },
      ];

      const result = await processIncomingRevocations(db, events, identity.publicKey);
      expect(result.processed).toBe(1);
      expect(result.rejected).toBe(0);

      const agent = db
        .prepare("SELECT revoked FROM agent_registry WHERE motebit_id = ?")
        .get(motebitId) as { revoked: number };
      expect(agent.revoked).toBe(1);
    });

    it("processes key rotation — updates public key", async () => {
      const motebitId = "agent-rotating";
      const now = Date.now();
      db.prepare(
        "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, registered_at, last_heartbeat, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(motebitId, "oldkey", "http://test.local", now, now, now + 86_400_000);

      const timestamp = Date.now();
      const payload = `revocation:key_rotated:${motebitId}:${timestamp}`;
      const sig = await sign(new TextEncoder().encode(payload), identity.privateKey);

      const events: RevocationEvent[] = [
        {
          type: "key_rotated",
          motebit_id: motebitId,
          new_public_key: "newkey123",
          timestamp,
          signature: bytesToHex(sig),
        },
      ];

      const result = await processIncomingRevocations(db, events, identity.publicKey);
      expect(result.processed).toBe(1);

      const agent = db
        .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
        .get(motebitId) as { public_key: string };
      expect(agent.public_key).toBe("newkey123");
    });

    it("processes credential revocation — stores in revoked credentials table", async () => {
      const timestamp = Date.now();
      const motebitId = "agent-cred-revoked";
      const credentialId = "cred-fed-1";
      const payload = `revocation:credential_revoked:${motebitId}:${timestamp}`;
      const sig = await sign(new TextEncoder().encode(payload), identity.privateKey);

      const events: RevocationEvent[] = [
        {
          type: "credential_revoked",
          motebit_id: motebitId,
          credential_id: credentialId,
          timestamp,
          signature: bytesToHex(sig),
        },
      ];

      const result = await processIncomingRevocations(db, events, identity.publicKey);
      expect(result.processed).toBe(1);

      const row = db
        .prepare("SELECT * FROM relay_revoked_credentials WHERE credential_id = ?")
        .get(credentialId) as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row!.revoked_by).toBe("federation");
    });

    it("rejects events with invalid signature (fail-closed)", async () => {
      const events: RevocationEvent[] = [
        {
          type: "agent_revoked",
          motebit_id: "agent-bad",
          timestamp: Date.now(),
          signature: "deadbeef".repeat(16), // invalid signature
        },
      ];

      const otherKeypair = await generateKeypair();
      const result = await processIncomingRevocations(db, events, otherKeypair.publicKey);
      expect(result.processed).toBe(0);
      expect(result.rejected).toBe(1);
    });

    it("safely ignores events for unknown agents", async () => {
      const timestamp = Date.now();
      const payload = `revocation:agent_revoked:nonexistent-agent:${timestamp}`;
      const sig = await sign(new TextEncoder().encode(payload), identity.privateKey);

      const events: RevocationEvent[] = [
        {
          type: "agent_revoked",
          motebit_id: "nonexistent-agent",
          timestamp,
          signature: bytesToHex(sig),
        },
      ];

      // Should not throw
      const result = await processIncomingRevocations(db, events, identity.publicKey);
      expect(result.processed).toBe(1); // processed (UPDATE affected 0 rows but no error)
      expect(result.rejected).toBe(0);
    });
  });
});
