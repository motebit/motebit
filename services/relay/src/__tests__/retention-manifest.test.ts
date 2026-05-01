/**
 * Operator retention manifest tests — phase 6a + commit-5 (4b-3) projection.
 *
 * Four invariants:
 *   1. The signed manifest verifies through `verifyRetentionManifest`
 *      against the relay's public key.
 *   2. Tampering with any field invalidates the signature.
 *   3. The manifest's content (stores list, honest_gaps, default
 *      sensitivity) matches what the source-of-truth declares.
 *   4. `witness_required` is derived from the federation peer count at
 *      build time — `false` baseline (no peers), `true` when any
 *      active/suspended peer exists. (Phase 4b-3 commit-5 addition.)
 *
 * Sibling to transparency.test.ts. Same suite, same signing flow.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { verifyRetentionManifest } from "@motebit/crypto";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
import { buildSignedManifest, RETENTION_MANIFEST_CONTENT } from "../retention-manifest.js";
import { createFederationTables } from "../federation.js";
import type { RelayIdentity } from "../federation.js";

let relayIdentity: RelayIdentity;
let db: DatabaseDriver;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeypair();
  relayIdentity = {
    relayMotebitId: "01975554-3001-7c00-9d05-test-relay-keys",
    publicKey,
    privateKey,
    publicKeyHex: "ignored-in-test",
    did: "did:motebit:01975554-3001-7c00-9d05-test-relay-keys",
  };
});

beforeEach(async () => {
  // Fresh in-memory db per test — every case starts from a no-peers
  // baseline so `witness_required` defaults to `false` unless the test
  // explicitly inserts a peer row.
  const moteDb = await openMotebitDatabase(":memory:");
  db = moteDb.db;
  createFederationTables(db);
});

describe("retention manifest — sign + verify round-trip", () => {
  it("signs a manifest that verifies through verifyRetentionManifest", async () => {
    const manifest = await buildSignedManifest(relayIdentity, db);

    const result = await verifyRetentionManifest(manifest, relayIdentity.publicKey);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest).not.toBeNull();
    expect(result.manifest?.spec).toBe("motebit/retention-manifest@1");
    expect(result.manifest?.suite).toBe("motebit-jcs-ed25519-hex-v1");
    expect(result.manifest?.operator_id).toBe(relayIdentity.relayMotebitId);
  });

  it("rejects a manifest tampered after signing", async () => {
    const manifest = await buildSignedManifest(relayIdentity, db);
    const tampered = {
      ...manifest,
      pre_classification_default_sensitivity: "secret" as const,
    };
    const result = await verifyRetentionManifest(tampered, relayIdentity.publicKey);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("does not verify against operator_public_key")),
    ).toBe(true);
  });

  it("rejects a manifest signed by a different key", async () => {
    const manifest = await buildSignedManifest(relayIdentity, db);
    const wrong = await generateKeypair();
    const result = await verifyRetentionManifest(manifest, wrong.publicKey);
    expect(result.valid).toBe(false);
  });

  it("rejects a manifest with the wrong spec value", async () => {
    const manifest = await buildSignedManifest(relayIdentity, db);
    const wrongSpec = { ...manifest, spec: "motebit/retention-manifest@2" as never };
    const result = await verifyRetentionManifest(wrongSpec, relayIdentity.publicKey);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unexpected spec"))).toBe(true);
  });

  it("rejects a non-hex signature", async () => {
    const manifest = await buildSignedManifest(relayIdentity, db);
    const badSig = { ...manifest, signature: "not-hex-bytes" };
    const result = await verifyRetentionManifest(badSig, relayIdentity.publicKey);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("128-char hex"))).toBe(true);
  });
});

describe("retention manifest — content honesty", () => {
  it("stores list contains the five operational ledgers under append_only_horizon", async () => {
    const storeIds = RETENTION_MANIFEST_CONTENT.stores.map((s) => s.store_id).sort();
    expect(storeIds).toEqual(
      [
        "relay_credential_anchor_batches",
        "relay_disputes",
        "relay_execution_ledgers",
        "relay_revocation_events",
        "relay_settlements",
      ].sort(),
    );
    for (const store of RETENTION_MANIFEST_CONTENT.stores) {
      expect(store.shape.kind).toBe("append_only_horizon");
    }
  });

  it("per-store horizon_advance_period_days defaults match the commit-5 design call", async () => {
    const byId = new Map(RETENTION_MANIFEST_CONTENT.stores.map((s) => [s.store_id, s]));
    const expected: Record<string, number> = {
      relay_execution_ledgers: 365,
      relay_settlements: 365,
      relay_credential_anchor_batches: 90,
      relay_revocation_events: 7,
      relay_disputes: 90,
    };
    for (const [storeId, periodDays] of Object.entries(expected)) {
      const shape = byId.get(storeId)?.shape;
      expect(shape?.kind).toBe("append_only_horizon");
      if (shape?.kind === "append_only_horizon") {
        expect(shape.horizon_advance_period_days).toBe(periodDays);
      }
    }
  });

  it("declares pre_classification_default_sensitivity = personal", async () => {
    expect(RETENTION_MANIFEST_CONTENT.pre_classification_default_sensitivity).toBe("personal");
  });

  it("honest_gaps reduced to out_of_deployment + different_mechanism + onchain-anchor (no operational-ledger pending entry — those moved to stores[])", async () => {
    const gaps = RETENTION_MANIFEST_CONTENT.honest_gaps;
    expect(gaps).toBeDefined();
    if (gaps === undefined) return;
    for (const gap of gaps) {
      expect(
        gap.startsWith("pending:") ||
          gap.startsWith("out_of_deployment:") ||
          gap.startsWith("different_mechanism:"),
      ).toBe(true);
    }
    // The operational-ledger pending entry from phase 6a is gone —
    // phase 4b-3 commit 5 promoted those to stores[].
    expect(gaps.some((g) => g.startsWith("pending:") && g.includes("operational ledgers"))).toBe(
      false,
    );
    expect(
      gaps.some(
        (g) =>
          g.startsWith("out_of_deployment:") &&
          g.includes("conversation_messages") &&
          g.toLowerCase().includes("phase 5-ship"),
      ),
    ).toBe(true);
    expect(gaps.some((g) => g.startsWith("different_mechanism:") && g.includes("presence"))).toBe(
      true,
    );
    expect(gaps.some((g) => g.startsWith("pending:") && g.includes("onchain anchor"))).toBe(true);
  });
});

describe("retention manifest — witness_required derivation (commit-5)", () => {
  it("witness_required is false on every store when no peers exist (no-peer baseline)", async () => {
    // beforeEach gave us a fresh db with createFederationTables but no
    // relay_peers rows.
    const manifest = await buildSignedManifest(relayIdentity, db);
    for (const store of manifest.stores) {
      if (store.shape.kind === "append_only_horizon") {
        expect(store.shape.witness_required).toBe(false);
      }
    }
  });

  it("witness_required is true on every store when ≥1 active peer exists", async () => {
    const peerKp = await generateKeypair();
    const now = Date.now();
    db.prepare(
      `INSERT INTO relay_peers
         (peer_relay_id, public_key, endpoint_url, display_name, state, peered_at,
          last_heartbeat_at, missed_heartbeats, agent_count, trust_score, peer_protocol_version)
       VALUES (?, ?, ?, ?, 'active', ?, ?, 0, 0, 100, NULL)`,
    ).run("relay-peer-1", bytesToHex(peerKp.publicKey), "http://peer1.test", "peer-1", now, now);

    const manifest = await buildSignedManifest(relayIdentity, db);
    for (const store of manifest.stores) {
      if (store.shape.kind === "append_only_horizon") {
        expect(store.shape.witness_required).toBe(true);
      }
    }
  });

  it("witness_required also derives true from suspended peers (still expected to witness once recovered)", async () => {
    const peerKp = await generateKeypair();
    db.prepare(
      `INSERT INTO relay_peers
         (peer_relay_id, public_key, endpoint_url, display_name, state, peered_at,
          last_heartbeat_at, missed_heartbeats, agent_count, trust_score, peer_protocol_version)
       VALUES (?, ?, ?, ?, 'suspended', ?, ?, 3, 0, 100, NULL)`,
    ).run(
      "relay-peer-suspended",
      bytesToHex(peerKp.publicKey),
      "http://peer-s.test",
      "peer-s",
      Date.now(),
      Date.now() - 600_000,
    );

    const manifest = await buildSignedManifest(relayIdentity, db);
    for (const store of manifest.stores) {
      if (store.shape.kind === "append_only_horizon") {
        expect(store.shape.witness_required).toBe(true);
      }
    }
  });

  it("removed/pending peers do NOT flip witness_required to true", async () => {
    const peerKp = await generateKeypair();
    db.prepare(
      `INSERT INTO relay_peers
         (peer_relay_id, public_key, endpoint_url, display_name, state, peered_at,
          last_heartbeat_at, missed_heartbeats, agent_count, trust_score, peer_protocol_version)
       VALUES (?, ?, ?, ?, 'removed', ?, NULL, 0, 0, 100, NULL)`,
    ).run(
      "relay-peer-gone",
      bytesToHex(peerKp.publicKey),
      "http://peer-g.test",
      "peer-g",
      Date.now(),
    );

    const manifest = await buildSignedManifest(relayIdentity, db);
    for (const store of manifest.stores) {
      if (store.shape.kind === "append_only_horizon") {
        expect(store.shape.witness_required).toBe(false);
      }
    }
  });

  it("manifest issued_at is signed (changing it invalidates the signature)", async () => {
    const manifest = await buildSignedManifest(relayIdentity, db, 1700000000000);
    const tampered = { ...manifest, issued_at: 1700000001000 };
    const result = await verifyRetentionManifest(tampered, relayIdentity.publicKey);
    expect(result.valid).toBe(false);
  });
});
