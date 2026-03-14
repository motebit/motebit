/**
 * Settlement retry queue tests — verifies retry on failure, exponential backoff,
 * max_attempts exhaustion, and successful retry clearing.
 *
 * Tests the `processSettlementRetries()` tick function directly (not the interval
 * wrapper) to avoid timing flakiness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { processSettlementRetries, createFederationTables } from "../federation.js";
import type { RelayIdentity } from "../federation.js";
import { openMotebitDatabase } from "@motebit/persistence";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair } from "@motebit/crypto";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Insert a peer so settlement retries can look up the endpoint. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function insertPeer(db: any, peerId: string, endpointUrl: string, state = "active"): void {
  const keypair = crypto.getRandomValues(new Uint8Array(32));
  db.prepare(
    `INSERT OR REPLACE INTO relay_peers (peer_relay_id, public_key, endpoint_url, state, missed_heartbeats, agent_count, trust_score)
     VALUES (?, ?, ?, ?, 0, 0, 0.5)`,
  ).run(peerId, bytesToHex(keypair), endpointUrl, state);
}

/** Insert a retry entry directly for testing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function insertRetry(
  db: any,
  opts: {
    retryId?: string;
    settlementId?: string;
    taskId?: string;
    peerRelayId: string;
    attempts?: number;
    maxAttempts?: number;
    nextRetryAt?: number;
    status?: string;
  },
): string {
  const retryId = opts.retryId ?? crypto.randomUUID();
  const payload = {
    task_id: opts.taskId ?? "task-1",
    settlement_id: opts.settlementId ?? "settle-1",
    origin_relay: "self-relay",
    gross_amount: 100,
    receipt_hash: "abc123",
  };
  db.prepare(
    `INSERT INTO relay_settlement_retries (retry_id, settlement_id, task_id, peer_relay_id, payload_json, attempts, max_attempts, next_retry_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    retryId,
    opts.settlementId ?? "settle-1",
    opts.taskId ?? "task-1",
    opts.peerRelayId,
    JSON.stringify(payload),
    opts.attempts ?? 0,
    opts.maxAttempts ?? 5,
    opts.nextRetryAt ?? Date.now() - 1000, // Past due by default
    opts.status ?? "pending",
    Date.now(),
  );
  return retryId;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRetry(
  db: any,
  retryId: string,
):
  | { status: string; attempts: number; next_retry_at: number; last_error: string | null }
  | undefined {
  return db
    .prepare(
      "SELECT status, attempts, next_retry_at, last_error FROM relay_settlement_retries WHERE retry_id = ?",
    )
    .get(retryId) as
    | { status: string; attempts: number; next_retry_at: number; last_error: string | null }
    | undefined;
}

describe("Settlement Retry Queue", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
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
    createFederationTables(moteDb.db);
    moteDb.db.exec(
      "CREATE TABLE IF NOT EXISTS agent_registry (motebit_id TEXT PRIMARY KEY, expires_at INTEGER)",
    );
    db = moteDb.db;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts into retry queue on settlement forward failure", () => {
    // This tests the pattern used in index.ts — inserting into retry queue
    insertPeer(db, "peer-1", "http://peer.test");
    const retryId = insertRetry(db, { peerRelayId: "peer-1" });

    const retry = getRetry(db, retryId);
    expect(retry).toBeDefined();
    expect(retry!.status).toBe("pending");
    expect(retry!.attempts).toBe(0);
  });

  it("completes retry on successful forward", async () => {
    insertPeer(db, "peer-1", "http://peer.test");
    const retryId = insertRetry(db, { peerRelayId: "peer-1" });

    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify({ status: "settled" }), { status: 200 });
    });

    await processSettlementRetries(db, identity);

    const retry = getRetry(db, retryId);
    expect(retry).toBeDefined();
    expect(retry!.status).toBe("completed");
  });

  it("increments attempts and applies exponential backoff on failure", async () => {
    insertPeer(db, "peer-1", "http://peer.test");
    const retryId = insertRetry(db, { peerRelayId: "peer-1", attempts: 0 });

    vi.stubGlobal("fetch", async () => {
      throw new Error("Connection refused");
    });

    const before = Date.now();
    await processSettlementRetries(db, identity);
    const after = Date.now();

    const retry = getRetry(db, retryId);
    expect(retry).toBeDefined();
    expect(retry!.status).toBe("pending");
    expect(retry!.attempts).toBe(1);
    // First backoff is 30s — next_retry_at should be ~30s from when the function ran
    expect(retry!.next_retry_at).toBeGreaterThanOrEqual(before + 30_000 - 5_000);
    expect(retry!.next_retry_at).toBeLessThanOrEqual(after + 30_000 + 5_000);
    expect(retry!.last_error).toBe("Connection refused");
  });

  it("applies increasing backoff on subsequent failures", async () => {
    insertPeer(db, "peer-1", "http://peer.test");
    const retryId = insertRetry(db, { peerRelayId: "peer-1", attempts: 1 });

    vi.stubGlobal("fetch", async () => {
      throw new Error("Still down");
    });

    const before = Date.now();
    await processSettlementRetries(db, identity);
    const after = Date.now();

    const retry = getRetry(db, retryId);
    expect(retry).toBeDefined();
    expect(retry!.status).toBe("pending");
    expect(retry!.attempts).toBe(2);
    // Second backoff is 2min (120s) — next_retry_at should be ~120s from when the function ran
    expect(retry!.next_retry_at).toBeGreaterThanOrEqual(before + 120_000 - 5_000);
    expect(retry!.next_retry_at).toBeLessThanOrEqual(after + 120_000 + 5_000);
  });

  it("marks as failed at max_attempts", async () => {
    insertPeer(db, "peer-1", "http://peer.test");
    const retryId = insertRetry(db, { peerRelayId: "peer-1", attempts: 4, maxAttempts: 5 });

    vi.stubGlobal("fetch", async () => {
      throw new Error("Still unreachable");
    });

    await processSettlementRetries(db, identity);

    const retry = getRetry(db, retryId);
    expect(retry).toBeDefined();
    expect(retry!.status).toBe("failed");
    expect(retry!.attempts).toBe(5);
    expect(retry!.last_error).toBe("Still unreachable");
  });

  it("marks as failed when peer no longer exists", async () => {
    // No peer inserted — peer_relay_id has no matching row
    const retryId = insertRetry(db, { peerRelayId: "vanished-peer" });

    await processSettlementRetries(db, identity);

    const retry = getRetry(db, retryId);
    expect(retry).toBeDefined();
    expect(retry!.status).toBe("failed");
    expect(retry!.last_error).toBe("Peer relay no longer exists");
  });

  it("skips retries not yet due", async () => {
    insertPeer(db, "peer-1", "http://peer.test");
    const retryId = insertRetry(db, {
      peerRelayId: "peer-1",
      nextRetryAt: Date.now() + 60_000, // 1 minute in the future
    });

    let fetchCalled = false;
    vi.stubGlobal("fetch", async () => {
      fetchCalled = true;
      return new Response("ok", { status: 200 });
    });

    await processSettlementRetries(db, identity);

    expect(fetchCalled).toBe(false);
    const retry = getRetry(db, retryId);
    expect(retry!.status).toBe("pending");
    expect(retry!.attempts).toBe(0);
  });

  it("skips retries already completed or failed", async () => {
    insertPeer(db, "peer-1", "http://peer.test");
    const completedId = insertRetry(db, { peerRelayId: "peer-1", status: "completed" });
    const failedId = insertRetry(db, {
      peerRelayId: "peer-1",
      status: "failed",
      retryId: crypto.randomUUID(),
    });

    let fetchCalled = false;
    vi.stubGlobal("fetch", async () => {
      fetchCalled = true;
      return new Response("ok", { status: 200 });
    });

    await processSettlementRetries(db, identity);

    expect(fetchCalled).toBe(false);
    expect(getRetry(db, completedId)!.status).toBe("completed");
    expect(getRetry(db, failedId)!.status).toBe("failed");
  });

  it("handles HTTP error response as failure", async () => {
    insertPeer(db, "peer-1", "http://peer.test");
    const retryId = insertRetry(db, { peerRelayId: "peer-1" });

    vi.stubGlobal("fetch", async () => {
      return new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      });
    });

    await processSettlementRetries(db, identity);

    const retry = getRetry(db, retryId);
    expect(retry).toBeDefined();
    expect(retry!.status).toBe("pending");
    expect(retry!.attempts).toBe(1);
    expect(retry!.last_error).toContain("500");
  });
});
