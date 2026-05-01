/**
 * Phase 4b-3 — relay-side horizon advance + per-store truncate adapters.
 *
 * Covers:
 *   - Self-witnessed empty-anchor round-trip (no peers).
 *   - Multi-peer fan-out happy path (mocked fetch, two peers respond).
 *   - One-peer-times-out happy path (Path A floor met by remaining peer).
 *   - Zero-peers-respond → retry → fail (3 attempts, max-attempt error).
 *   - Concurrency guard: parallel calls for same storeId collapse to one.
 *   - Re-snapshot on retry: peer set change visible across attempts.
 *   - Per-adapter unit tests (5 truncate paths) — NULL guards on
 *     settlements, anchor-batches, disputes; lifecycle-terminal
 *     COALESCE on disputes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { signHorizonWitnessRequestBody } from "@motebit/crypto";
import { EMPTY_FEDERATION_GRAPH_ANCHOR } from "@motebit/protocol";
import type { WitnessSolicitationRequest, WitnessSolicitationResponse } from "@motebit/protocol";
import {
  advanceRelayHorizon,
  advanceRevocationHorizon,
  truncateExecutionLedgersBeforeHorizon,
  truncateSettlementsBeforeHorizon,
  truncateCredentialAnchorBatchesBeforeHorizon,
  truncateRevocationEventsBeforeHorizon,
  truncateDisputesBeforeHorizon,
  _resetHorizonAdvanceLocksForTests,
  type HorizonAdvanceContext,
} from "../horizon.js";
import { createFederationTables, insertRevocationEvent } from "../federation.js";
import type { RelayIdentity } from "../federation.js";
import { createPairingTables } from "../pairing.js";
import { createCredentialAnchoringTables } from "../credential-anchoring.js";
import { createDisputeTables } from "../disputes.js";
import { runMigrations, relayMigrations } from "../migrations.js";

/**
 * Set up the full table topology this test file exercises. Mirrors the
 * canonical setup order from `services/relay/src/index.ts` (federation
 * → pairing → migrations → credential-anchor → disputes), reduced to
 * the slice the horizon-advance + truncate-adapter tests need.
 */
function setupRelayTables(db: DatabaseDriver): void {
  createFederationTables(db);
  createPairingTables(db);
  runMigrations(db, relayMigrations);
  createCredentialAnchoringTables(db);
  createDisputeTables(db);
}

async function makeIdentity(seed = "issuer"): Promise<RelayIdentity> {
  const kp = await generateKeypair();
  return {
    relayMotebitId: `relay-${seed}-${crypto.randomUUID().slice(0, 8)}`,
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyHex: bytesToHex(kp.publicKey),
    did: `did:key:z${bytesToHex(kp.publicKey).slice(0, 16)}`,
  };
}

function insertPeer(
  db: DatabaseDriver,
  peerId: string,
  pubKeyHex: string,
  endpointUrl: string,
  peeredAt: number,
): void {
  db.prepare(
    `INSERT INTO relay_peers
       (peer_relay_id, public_key, endpoint_url, display_name, state, peered_at,
        last_heartbeat_at, missed_heartbeats, agent_count, trust_score, peer_protocol_version)
     VALUES (?, ?, ?, ?, 'active', ?, ?, 0, 0, 100, NULL)`,
  ).run(peerId, pubKeyHex, endpointUrl, peerId, peeredAt, peeredAt);
}

describe("horizon — self-witnessed (empty-anchor) round trip", () => {
  let db: DatabaseDriver;
  let identity: RelayIdentity;

  beforeEach(async () => {
    _resetHorizonAdvanceLocksForTests();
    const moteDb = await openMotebitDatabase(":memory:");
    db = moteDb.db;
    setupRelayTables(db);
    identity = await makeIdentity();
  });

  it("signs an EMPTY_FEDERATION_GRAPH_ANCHOR cert when no peers exist", async () => {
    await insertRevocationEvent(db, identity, "agent_revoked", "agent-1");
    const oldTs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    db.prepare("UPDATE relay_revocation_events SET timestamp = ?").run(oldTs);

    const result = await advanceRevocationHorizon(db, { relayIdentity: identity });

    expect(result.selfWitnessed).toBe(true);
    expect(result.cert.witnessed_by).toEqual([]);
    expect(result.cert.federation_graph_anchor).toEqual(EMPTY_FEDERATION_GRAPH_ANCHOR);
    expect(result.cert.subject).toEqual({
      kind: "operator",
      operator_id: identity.relayMotebitId,
    });
    expect(result.truncatedCount).toBe(1);
    expect(result.attemptsUsed).toBe(1);
  });

  it("persists the cert in relay_horizon_certs keyed by signature", async () => {
    const result = await advanceRevocationHorizon(db, { relayIdentity: identity });
    const row = db
      .prepare(
        "SELECT cert_signature, store_id, witness_count FROM relay_horizon_certs WHERE cert_signature = ?",
      )
      .get(result.cert.signature) as
      | { cert_signature: string; store_id: string; witness_count: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.store_id).toBe("relay_revocation_events");
    expect(row?.witness_count).toBe(0);
  });
});

describe("horizon — multi-peer fan-out", () => {
  let db: DatabaseDriver;
  let issuer: RelayIdentity;
  let peerA: RelayIdentity;
  let peerB: RelayIdentity;

  beforeEach(async () => {
    const moteDb = await openMotebitDatabase(":memory:");
    db = moteDb.db;
    setupRelayTables(db);
    issuer = await makeIdentity("issuer");
    peerA = await makeIdentity("peerA");
    peerB = await makeIdentity("peerB");
    const now = Date.now();
    insertPeer(db, peerA.relayMotebitId, peerA.publicKeyHex, "http://peerA.test", now - 60_000);
    insertPeer(db, peerB.relayMotebitId, peerB.publicKeyHex, "http://peerB.test", now - 60_000);
  });

  it("collects two valid witnesses and signs the cert with both in witnessed_by[]", async () => {
    // Mock fetch: each peer signs the canonical request body with its
    // own key and returns a valid WitnessSolicitationResponse.
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const peer = u.includes("peerA.test") ? peerA : peerB;
      const request = JSON.parse(init?.body as string) as WitnessSolicitationRequest;
      const sig = await signHorizonWitnessRequestBody(request.cert_body, peer.privateKey);
      const response: WitnessSolicitationResponse = {
        motebit_id: peer.relayMotebitId as never,
        signature: sig,
      };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await advanceRelayHorizon(db, "relay_revocation_events", Date.now() - 1000, {
      relayIdentity: issuer,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.selfWitnessed).toBe(false);
    expect(result.witnessCount).toBe(2);
    expect(result.cert.witnessed_by.map((w) => w.motebit_id).sort()).toEqual(
      [peerA.relayMotebitId, peerB.relayMotebitId].sort(),
    );
    expect(result.cert.federation_graph_anchor?.leaf_count).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Path A floor of 1: succeeds when one peer times out and one responds", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("peerA.test")) {
        // Simulate timeout by throwing AbortError-shaped error.
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      const request = JSON.parse(init?.body as string) as WitnessSolicitationRequest;
      const sig = await signHorizonWitnessRequestBody(request.cert_body, peerB.privateKey);
      const response: WitnessSolicitationResponse = {
        motebit_id: peerB.relayMotebitId as never,
        signature: sig,
      };
      return new Response(JSON.stringify(response), { status: 200 });
    });

    const result = await advanceRelayHorizon(db, "relay_revocation_events", Date.now() - 1000, {
      relayIdentity: issuer,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.witnessCount).toBe(1);
    expect(result.cert.witnessed_by[0]!.motebit_id).toBe(peerB.relayMotebitId);
  });

  it("rejects forged peer signatures (signature_invalid) and treats as non-response", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("peerA.test")) {
        // Forged signature — peerA returns valid-shaped response with garbage sig
        const response: WitnessSolicitationResponse = {
          motebit_id: peerA.relayMotebitId as never,
          signature:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        };
        return new Response(JSON.stringify(response), { status: 200 });
      }
      const request = JSON.parse(init?.body as string) as WitnessSolicitationRequest;
      const sig = await signHorizonWitnessRequestBody(request.cert_body, peerB.privateKey);
      return new Response(
        JSON.stringify({
          motebit_id: peerB.relayMotebitId,
          signature: sig,
        }),
        { status: 200 },
      );
    });

    const result = await advanceRelayHorizon(db, "relay_revocation_events", Date.now() - 1000, {
      relayIdentity: issuer,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    // Only peerB's valid signature lands; peerA's forged sig dropped.
    expect(result.witnessCount).toBe(1);
    expect(result.cert.witnessed_by[0]!.motebit_id).toBe(peerB.relayMotebitId);
  });
});

describe("horizon — quorum failure + retry", () => {
  let db: DatabaseDriver;
  let issuer: RelayIdentity;
  let peerA: RelayIdentity;
  // Fast-retry schedule for tests — production uses 1s/3s/9s. Real
  // timers (no fake-timer choreography across the awaited cert-signing
  // pipeline) keep the test honest about microtask ordering.
  const FAST_BACKOFF = [10, 10] as const;

  beforeEach(async () => {
    _resetHorizonAdvanceLocksForTests();
    const moteDb = await openMotebitDatabase(":memory:");
    db = moteDb.db;
    setupRelayTables(db);
    issuer = await makeIdentity("issuer");
    peerA = await makeIdentity("peerA");
    const now = Date.now();
    insertPeer(db, peerA.relayMotebitId, peerA.publicKeyHex, "http://peerA.test", now - 60_000);
  });

  it("throws after 3 attempts when all peers fail every retry", async () => {
    const fetchMock = vi.fn(async () => new Response("err", { status: 503 }));
    await expect(
      advanceRelayHorizon(db, "relay_revocation_events", Date.now() - 1000, {
        relayIdentity: issuer,
        fetchImpl: fetchMock as unknown as typeof fetch,
        _retryBackoffMsForTests: FAST_BACKOFF,
      }),
    ).rejects.toThrow(/3 attempts failed/);
    // 3 attempts × 1 peer = 3 fetch calls.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("re-snapshots peer set on retry — new peer added mid-flight shows up in attempt 2's anchor", async () => {
    // Setup: peerA already inserted in beforeEach. peerB joins between
    // attempt 1 and attempt 2, triggered by the first fetchMock call.
    const peerBKp = await generateKeypair();
    const peerBId = "relay-peerB-late";
    let peerBJoined = false;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      // Side effect: as soon as peerA's first solicitation arrives,
      // simulate peerB joining the federation. The peer is in DB by
      // the time attempt 2 re-snapshots.
      if (!peerBJoined) {
        peerBJoined = true;
        insertPeer(
          db,
          peerBId,
          bytesToHex(peerBKp.publicKey),
          "http://peerB.test",
          Date.now() - 60_000,
        );
      }
      if (u.includes("peerA.test")) {
        return new Response("err", { status: 503 });
      }
      // peerB path — returns valid signature.
      const request = JSON.parse(init?.body as string) as WitnessSolicitationRequest;
      // Re-snapshot proof: attempt 2's request body anchors a 2-peer set.
      expect(request.cert_body.federation_graph_anchor?.leaf_count).toBe(2);
      const sig = await signHorizonWitnessRequestBody(request.cert_body, peerBKp.privateKey);
      return new Response(JSON.stringify({ motebit_id: peerBId, signature: sig }), { status: 200 });
    });

    const result = await advanceRelayHorizon(db, "relay_revocation_events", Date.now() - 1000, {
      relayIdentity: issuer,
      fetchImpl: fetchMock as unknown as typeof fetch,
      _retryBackoffMsForTests: FAST_BACKOFF,
    });

    // Attempt 1 saw 1 peer (peerA → 503). Attempt 2 re-snapshotted, saw 2
    // peers, peerB returned a valid signature. Floor of 1 met.
    expect(result.attemptsUsed).toBe(2);
    expect(result.witnessCount).toBe(1);
    expect(result.cert.witnessed_by[0]!.motebit_id).toBe(peerBId);
    expect(result.cert.federation_graph_anchor?.leaf_count).toBe(2);
  });
});

describe("horizon — concurrency guard", () => {
  let db: DatabaseDriver;
  let identity: RelayIdentity;

  beforeEach(async () => {
    _resetHorizonAdvanceLocksForTests();
    const moteDb = await openMotebitDatabase(":memory:");
    db = moteDb.db;
    setupRelayTables(db);
    identity = await makeIdentity();
  });

  it("collapses parallel calls for same storeId to a single in-flight attempt", async () => {
    const ctx: HorizonAdvanceContext = { relayIdentity: identity };
    // No peers — self-witnessed path is fast and deterministic, ideal
    // for asserting the in-process map guard collapses N parallel calls.
    const [a, b, c] = await Promise.all([
      advanceRevocationHorizon(db, ctx),
      advanceRevocationHorizon(db, ctx),
      advanceRevocationHorizon(db, ctx),
    ]);
    // All three resolve to the SAME cert (same signature, same horizon)
    // — proves they shared one in-flight promise.
    expect(a.cert.signature).toBe(b.cert.signature);
    expect(b.cert.signature).toBe(c.cert.signature);
    // Only one cert row persisted (the parallel calls didn't each create one).
    const count = (
      db.prepare("SELECT COUNT(*) as cnt FROM relay_horizon_certs").get() as { cnt: number }
    ).cnt;
    expect(count).toBe(1);
  });
});

describe("horizon — per-store truncate adapters", () => {
  let db: DatabaseDriver;

  beforeEach(async () => {
    _resetHorizonAdvanceLocksForTests();
    const moteDb = await openMotebitDatabase(":memory:");
    db = moteDb.db;
    setupRelayTables(db);
  });

  it("truncateExecutionLedgersBeforeHorizon — by created_at", () => {
    const oldTs = Date.now() - 100_000;
    const newTs = Date.now() + 100_000;
    const insert = db.prepare(
      "INSERT INTO relay_execution_ledgers (ledger_id, motebit_id, goal_id, plan_id, manifest_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("L1", "M1", "G1", null, "{}", "hash1", oldTs);
    insert.run("L2", "M2", "G2", null, "{}", "hash2", newTs);
    const deleted = truncateExecutionLedgersBeforeHorizon(db, Date.now());
    expect(deleted).toBe(1);
  });

  it("truncateSettlementsBeforeHorizon — old settled rows truncated, recent preserved", () => {
    const oldTs = Date.now() - 100_000;
    const newTs = Date.now() + 100_000;
    // task_id has a UNIQUE-with-settlement_mode index from later migrations,
    // so each row gets a distinct task_id even though the column has a
    // default '' fallback.
    const insert = db.prepare(
      "INSERT INTO relay_settlements (settlement_id, allocation_id, task_id, amount_settled, status, settled_at) VALUES (?, ?, ?, ?, 'settled', ?)",
    );
    insert.run("S1", "A1", "T-old", 100, oldTs);
    insert.run("S2", "A2", "T-new", 200, newTs);
    const deleted = truncateSettlementsBeforeHorizon(db, Date.now());
    expect(deleted).toBe(1);
    // The defensive `settled_at IS NOT NULL` guard in the adapter
    // covers a future schema relaxation; current schema (migration 8)
    // declares settled_at NOT NULL so the guard is dead code today.
  });

  it("truncateCredentialAnchorBatchesBeforeHorizon — NULL anchored_at preserved", () => {
    const oldTs = Date.now() - 100_000;
    const insert = db.prepare(
      "INSERT INTO relay_credential_anchor_batches (batch_id, relay_id, merkle_root, leaf_count, first_issued_at, last_issued_at, signature, anchored_at, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)",
    );
    insert.run("B1", "rel-1", "deadbeef", oldTs, oldTs, "sig1", oldTs, oldTs);
    insert.run("B2", "rel-1", "cafebabe", oldTs, oldTs, "sig2", null, oldTs);
    const deleted = truncateCredentialAnchorBatchesBeforeHorizon(db, Date.now());
    expect(deleted).toBe(1);
    // Unanchored batch preserved (anchored_at IS NULL — pending chain confirmation).
    const remaining = db
      .prepare("SELECT COUNT(*) as cnt FROM relay_credential_anchor_batches")
      .get() as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });

  it("truncateRevocationEventsBeforeHorizon — by timestamp", () => {
    const oldTs = Date.now() - 100_000;
    const newTs = Date.now() + 100_000;
    const insert = db.prepare(
      "INSERT INTO relay_revocation_events (event_id, type, motebit_id, timestamp, signature) VALUES (?, 'agent_revoked', ?, ?, 'x')",
    );
    insert.run("E1", "A1", oldTs);
    insert.run("E2", "A2", newTs);
    const deleted = truncateRevocationEventsBeforeHorizon(db, Date.now());
    expect(deleted).toBe(1);
  });

  it("truncateDisputesBeforeHorizon — pre-terminal disputes preserved", () => {
    const oldTs = Date.now() - 100_000;
    const insertSql = `INSERT INTO relay_disputes
      (dispute_id, task_id, allocation_id, filed_by, respondent, category, description,
       state, filed_at, evidence_deadline, final_at, expired_at)
      VALUES (?, ?, ?, ?, ?, 'quality', '', ?, ?, ?, ?, ?)`;
    // Open dispute (filed_at set, no terminal cols) — must NOT be truncated
    db.prepare(insertSql).run(
      "D-open",
      "T1",
      "A1",
      "F",
      "R",
      "opened",
      oldTs,
      oldTs + 1000,
      null,
      null,
    );
    // Final dispute (final_at set, before horizon) — MUST be truncated
    db.prepare(insertSql).run(
      "D-final",
      "T2",
      "A2",
      "F",
      "R",
      "final",
      oldTs,
      oldTs + 1000,
      oldTs + 1,
      null,
    );
    // Expired dispute (expired_at set, before horizon) — MUST be truncated
    db.prepare(insertSql).run(
      "D-exp",
      "T3",
      "A3",
      "F",
      "R",
      "expired",
      oldTs,
      oldTs + 1000,
      null,
      oldTs + 1,
    );

    const deleted = truncateDisputesBeforeHorizon(db, Date.now());
    expect(deleted).toBe(2);
    // Pre-terminal preserved.
    const remaining = db.prepare("SELECT dispute_id FROM relay_disputes").all() as {
      dispute_id: string;
    }[];
    expect(remaining.map((r) => r.dispute_id)).toEqual(["D-open"]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
