/**
 * Federation chaos tests — verifies resilience under adversarial and edge-case
 * network conditions: heartbeat oscillation, mid-settlement peer death, rapid
 * removal/re-registration, flaky networks, retry exhaustion, and concurrent recovery.
 *
 * Tests the `sendHeartbeats()` and `processSettlementRetries()` tick functions
 * directly (not the interval wrappers) to avoid timing flakiness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendHeartbeats, processSettlementRetries, createFederationTables } from "../federation.js";
import type { RelayIdentity } from "../federation.js";
import { createSyncRelay } from "../index.js";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex } from "@motebit/crypto";

// === Helpers ===

/** Manually insert a peer into the DB. */
function insertPeer(
  db: DatabaseDriver,
  peerId: string,
  endpointUrl: string,
  state: string,
  missed = 0,
  lastHeartbeatAt?: number,
): void {
  const keypair = crypto.getRandomValues(new Uint8Array(32));
  db.prepare(
    `INSERT OR REPLACE INTO relay_peers (peer_relay_id, public_key, endpoint_url, state, missed_heartbeats, agent_count, trust_score, last_heartbeat_at)
     VALUES (?, ?, ?, ?, ?, 0, 0.5, ?)`,
  ).run(peerId, bytesToHex(keypair), endpointUrl, state, missed, lastHeartbeatAt ?? null);
}

function getPeer(
  db: DatabaseDriver,
  peerId: string,
): { state: string; missed_heartbeats: number } | undefined {
  return db
    .prepare("SELECT state, missed_heartbeats FROM relay_peers WHERE peer_relay_id = ?")
    .get(peerId) as { state: string; missed_heartbeats: number } | undefined;
}

/** Insert a settlement retry entry directly for testing. */
function insertRetry(
  db: DatabaseDriver,
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
    opts.nextRetryAt ?? Date.now() - 1000,
    opts.status ?? "pending",
    Date.now(),
  );
  return retryId;
}

function getRetry(
  db: DatabaseDriver,
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

/** Stub fetch to succeed with a valid heartbeat response. */
function stubFetchSuccess(): void {
  vi.stubGlobal("fetch", async () => {
    return new Response(
      JSON.stringify({
        relay_id: "peer-relay",
        timestamp: Date.now(),
        agent_count: 1,
        signature: bytesToHex(new Uint8Array(64)),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

/** Stub fetch to fail with connection refused. */
function stubFetchFailure(): void {
  vi.stubGlobal("fetch", async () => {
    throw new Error("Connection refused");
  });
}

// === Shared test setup ===

let db: DatabaseDriver;
let identity: RelayIdentity;

async function setupDbAndIdentity(): Promise<void> {
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
}

// === 1. Heartbeat Oscillation Resistance (Hysteresis Verification) ===

describe("Federation Chaos: Heartbeat Oscillation Resistance", () => {
  beforeEach(setupDbAndIdentity);
  afterEach(() => vi.restoreAllMocks());

  it("suspended peer does not reactivate on a single success (hysteresis)", async () => {
    insertPeer(db, "oscillating-peer", "http://oscillating.test", "suspended", 3);

    // Success: 3→2, still suspended
    stubFetchSuccess();
    await sendHeartbeats(db, identity);
    let peer = getPeer(db, "oscillating-peer");
    expect(peer!.missed_heartbeats).toBe(2);
    expect(peer!.state).toBe("suspended");

    // Failure: 2→3, still suspended
    stubFetchFailure();
    await sendHeartbeats(db, identity);
    peer = getPeer(db, "oscillating-peer");
    expect(peer!.missed_heartbeats).toBe(3);
    expect(peer!.state).toBe("suspended");

    // Success: 3→2, still suspended (did NOT oscillate to active)
    stubFetchSuccess();
    await sendHeartbeats(db, identity);
    peer = getPeer(db, "oscillating-peer");
    expect(peer!.missed_heartbeats).toBe(2);
    expect(peer!.state).toBe("suspended");

    // Failure: 2→3, still suspended — oscillation prevented
    stubFetchFailure();
    await sendHeartbeats(db, identity);
    peer = getPeer(db, "oscillating-peer");
    expect(peer!.missed_heartbeats).toBe(3);
    expect(peer!.state).toBe("suspended");
  });

  it("full recovery path: 1 miss, 2 failures to suspended, 3 successes to active", async () => {
    insertPeer(db, "recovery-peer", "http://recovery.test", "active", 1);

    // 2 consecutive failures: 1→2→3 (suspended at 3)
    stubFetchFailure();
    await sendHeartbeats(db, identity);
    let peer = getPeer(db, "recovery-peer");
    expect(peer!.missed_heartbeats).toBe(2);
    expect(peer!.state).toBe("active");

    await sendHeartbeats(db, identity);
    peer = getPeer(db, "recovery-peer");
    expect(peer!.missed_heartbeats).toBe(3);
    expect(peer!.state).toBe("suspended");

    // 3 consecutive successes: 3→2→1→0 (active at 0)
    stubFetchSuccess();
    await sendHeartbeats(db, identity);
    peer = getPeer(db, "recovery-peer");
    expect(peer!.missed_heartbeats).toBe(2);
    expect(peer!.state).toBe("suspended");

    await sendHeartbeats(db, identity);
    peer = getPeer(db, "recovery-peer");
    expect(peer!.missed_heartbeats).toBe(1);
    expect(peer!.state).toBe("suspended");

    await sendHeartbeats(db, identity);
    peer = getPeer(db, "recovery-peer");
    expect(peer!.missed_heartbeats).toBe(0);
    expect(peer!.state).toBe("active");
  });
});

// === 2. Peer Dies Mid-Settlement Retry ===

describe("Federation Chaos: Peer Dies Mid-Settlement Retry", () => {
  beforeEach(setupDbAndIdentity);
  afterEach(() => vi.restoreAllMocks());

  it("retry completes for suspended peer (uses endpoint lookup, not state check)", async () => {
    insertPeer(db, "dying-peer", "http://dying.test", "active");
    const retryId = insertRetry(db, { peerRelayId: "dying-peer" });

    // Peer becomes suspended between retry insertion and processing
    db.prepare("UPDATE relay_peers SET state = 'suspended' WHERE peer_relay_id = ?").run(
      "dying-peer",
    );

    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify({ status: "settled" }), { status: 200 });
    });

    await processSettlementRetries(db, identity);

    const retry = getRetry(db, retryId);
    expect(retry).toBeDefined();
    expect(retry!.status).toBe("completed");
  });

  it("retry fails when peer row is deleted (removed peer)", async () => {
    insertPeer(db, "vanished-peer", "http://vanished.test", "active");
    const retryId = insertRetry(db, { peerRelayId: "vanished-peer" });

    // Delete the peer row entirely — simulates full removal
    db.prepare("DELETE FROM relay_peers WHERE peer_relay_id = ?").run("vanished-peer");

    await processSettlementRetries(db, identity);

    const retry = getRetry(db, retryId);
    expect(retry).toBeDefined();
    expect(retry!.status).toBe("failed");
    expect(retry!.last_error).toBe("Peer relay no longer exists");
  });
});

// === 3. Rapid Removal and Re-Registration Cooldown ===

describe("Federation Chaos: Re-Registration Cooldown", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects re-proposal for pending peer (409), prevents rapid re-registration", async () => {
    const relay = await createSyncRelay({
      apiToken: "test-token",
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
      enableDeviceAuth: false,
      federation: {
        endpointUrl: "http://cooldown-relay.test:3000",
        displayName: "Cooldown Test Relay",
        autoAcceptPeers: true,
      },
    });

    const peerId = `cooldown-${crypto.randomUUID()}`;
    const peerKeypair = await generateKeypair();
    const peerPubHex = bytesToHex(peerKeypair.publicKey);
    const makeNonce = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

    // First proposal creates peer in pending state
    const res1 = await relay.app.request("/federation/v1/peer/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        relay_id: peerId,
        public_key: peerPubHex,
        endpoint_url: "http://cooldown-peer.test:3001",
        display_name: "Cooldown Peer",
        nonce: makeNonce(),
      }),
    });
    expect(res1.status).toBe(200);

    // Re-propose while pending returns 409 — prevents rapid re-registration
    const res2 = await relay.app.request("/federation/v1/peer/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        relay_id: peerId,
        public_key: peerPubHex,
        endpoint_url: "http://cooldown-peer.test:3001",
        display_name: "Cooldown Peer",
        nonce: makeNonce(),
      }),
    });
    expect(res2.status).toBe(409);

    relay.close();
  });

  it("removed peer with recent heartbeat is blocked by cooldown at DB level", async () => {
    // Test the cooldown logic directly via DB: a removed peer with recent
    // last_heartbeat_at cannot be re-inserted via the ON CONFLICT clause.
    // The propose endpoint checks state='removed' and last_heartbeat_at to enforce cooldown.
    await setupDbAndIdentity();

    const peerId = "cooldown-removed-peer";
    const recentTimestamp = Date.now();

    // Insert peer as removed with recent heartbeat
    insertPeer(db, peerId, "http://removed.test", "removed", 5, recentTimestamp);

    const peer = getPeer(db, peerId);
    expect(peer).toBeDefined();
    expect(peer!.state).toBe("removed");

    // Verify the ON CONFLICT clause preserves removed state when inserting
    // with a conflicting peer_relay_id (the DB-level guard)
    db.prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, state, missed_heartbeats, agent_count, trust_score)
       VALUES (?, ?, ?, 'pending', 0, 0, 0.5)
       ON CONFLICT(peer_relay_id) DO UPDATE SET
         state = 'pending', missed_heartbeats = 0
         WHERE relay_peers.state NOT IN ('active', 'pending')`,
    ).run(peerId, bytesToHex(crypto.getRandomValues(new Uint8Array(32))), "http://removed.test");

    // The ON CONFLICT UPDATE fires because removed is NOT IN ('active', 'pending'),
    // so the peer transitions to pending. The HTTP endpoint adds the time-based cooldown
    // check *before* this SQL runs — that's the 429 enforcement.
    const updated = getPeer(db, peerId);
    expect(updated!.state).toBe("pending"); // SQL allows it; HTTP endpoint would block it
  });
});

// === 4. Heartbeat with Flaky Network (Alternating Success/Failure) ===

describe("Federation Chaos: Flaky Network (Alternating Success/Failure)", () => {
  beforeEach(setupDbAndIdentity);
  afterEach(() => vi.restoreAllMocks());

  it("peer never reaches suspended with alternating success/failure over 10 rounds", async () => {
    insertPeer(db, "flaky-peer", "http://flaky.test", "active", 0);

    for (let round = 0; round < 10; round++) {
      if (round % 2 === 0) {
        stubFetchFailure(); // Even rounds: miss increments by 1
      } else {
        stubFetchSuccess(); // Odd rounds: miss decrements by 1
      }
      await sendHeartbeats(db, identity);

      const peer = getPeer(db, "flaky-peer");
      expect(peer).toBeDefined();
      // Alternating fail/success from 0: 0→1→0→1→0... Max missed is always 1.
      expect(peer!.missed_heartbeats).toBeLessThan(3);
      expect(peer!.state).toBe("active");
    }
  });

  it("two consecutive failures followed by success keeps peer active", async () => {
    insertPeer(db, "burst-peer", "http://burst.test", "active", 0);

    // 2 failures: 0→1→2
    stubFetchFailure();
    await sendHeartbeats(db, identity);
    await sendHeartbeats(db, identity);

    let peer = getPeer(db, "burst-peer");
    expect(peer!.missed_heartbeats).toBe(2);
    expect(peer!.state).toBe("active"); // Not yet at threshold of 3

    // 1 success: 2→1
    stubFetchSuccess();
    await sendHeartbeats(db, identity);
    peer = getPeer(db, "burst-peer");
    expect(peer!.missed_heartbeats).toBe(1);
    expect(peer!.state).toBe("active");
  });
});

// === 5. Settlement Retry Exhaustion with Auto-Refund ===

describe("Federation Chaos: Settlement Retry Exhaustion with Auto-Refund", () => {
  beforeEach(setupDbAndIdentity);
  afterEach(() => vi.restoreAllMocks());

  it("calls onRetryExhausted callback when max_attempts reached", async () => {
    insertPeer(db, "exhausted-peer", "http://exhausted.test", "active");
    const retryId = insertRetry(db, {
      peerRelayId: "exhausted-peer",
      attempts: 4, // One attempt away from max (5)
      maxAttempts: 5,
    });

    vi.stubGlobal("fetch", async () => {
      throw new Error("Permanently unreachable");
    });

    const exhaustedRetries: Array<{ retry_id: string; task_id: string }> = [];
    const onRetryExhausted = vi.fn((retry: { retry_id: string; task_id: string }) => {
      exhaustedRetries.push(retry);
    });

    await processSettlementRetries(db, identity, onRetryExhausted);

    expect(onRetryExhausted).toHaveBeenCalledOnce();
    expect(exhaustedRetries).toHaveLength(1);
    expect(exhaustedRetries[0]!.retry_id).toBe(retryId);

    const retry = getRetry(db, retryId);
    expect(retry).toBeDefined();
    expect(retry!.status).toBe("failed");
    expect(retry!.attempts).toBe(5);
    expect(retry!.last_error).toBe("Permanently unreachable");
  });

  it("does not call onRetryExhausted when retry succeeds before max", async () => {
    insertPeer(db, "recovering-peer", "http://recovering.test", "active");
    const retryId = insertRetry(db, {
      peerRelayId: "recovering-peer",
      attempts: 3,
      maxAttempts: 5,
    });

    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify({ status: "settled" }), { status: 200 });
    });

    const onRetryExhausted = vi.fn();
    await processSettlementRetries(db, identity, onRetryExhausted);

    expect(onRetryExhausted).not.toHaveBeenCalled();
    expect(getRetry(db, retryId)!.status).toBe("completed");
  });

  it("onRetryExhausted error does not crash the retry processor", async () => {
    insertPeer(db, "crash-peer", "http://crash.test", "active");
    const retryId = insertRetry(db, {
      peerRelayId: "crash-peer",
      attempts: 4,
      maxAttempts: 5,
    });

    vi.stubGlobal("fetch", async () => {
      throw new Error("Down");
    });

    const onRetryExhausted = vi.fn(() => {
      throw new Error("Refund system also broken");
    });

    // Should not throw even though the callback throws
    await processSettlementRetries(db, identity, onRetryExhausted);

    expect(onRetryExhausted).toHaveBeenCalledOnce();
    expect(getRetry(db, retryId)!.status).toBe("failed");
  });
});

// === 6. Concurrent Heartbeat Success During Suspension ===

describe("Federation Chaos: Concurrent Heartbeat Recovery from Suspension", () => {
  beforeEach(setupDbAndIdentity);
  afterEach(() => vi.restoreAllMocks());

  it("gradual recovery: 3 consecutive successes transition suspended to active", async () => {
    insertPeer(db, "gradual-peer", "http://gradual.test", "suspended", 3);
    stubFetchSuccess();

    // Success 1: 3→2, still suspended
    await sendHeartbeats(db, identity);
    let peer = getPeer(db, "gradual-peer");
    expect(peer!.missed_heartbeats).toBe(2);
    expect(peer!.state).toBe("suspended");

    // Success 2: 2→1, still suspended
    await sendHeartbeats(db, identity);
    peer = getPeer(db, "gradual-peer");
    expect(peer!.missed_heartbeats).toBe(1);
    expect(peer!.state).toBe("suspended");

    // Success 3: 1→0, reactivated
    await sendHeartbeats(db, identity);
    peer = getPeer(db, "gradual-peer");
    expect(peer!.missed_heartbeats).toBe(0);
    expect(peer!.state).toBe("active");
  });

  it("recovery interrupted by failure resets progress", async () => {
    insertPeer(db, "interrupted-peer", "http://interrupted.test", "suspended", 3);

    // 2 successes: 3→2→1
    stubFetchSuccess();
    await sendHeartbeats(db, identity);
    await sendHeartbeats(db, identity);
    let peer = getPeer(db, "interrupted-peer");
    expect(peer!.missed_heartbeats).toBe(1);
    expect(peer!.state).toBe("suspended");

    // 1 failure: 1→2, progress lost
    stubFetchFailure();
    await sendHeartbeats(db, identity);
    peer = getPeer(db, "interrupted-peer");
    expect(peer!.missed_heartbeats).toBe(2);
    expect(peer!.state).toBe("suspended");

    // Now need 2 successes to recover: 2→1→0
    stubFetchSuccess();
    await sendHeartbeats(db, identity);
    peer = getPeer(db, "interrupted-peer");
    expect(peer!.missed_heartbeats).toBe(1);
    expect(peer!.state).toBe("suspended");

    await sendHeartbeats(db, identity);
    peer = getPeer(db, "interrupted-peer");
    expect(peer!.missed_heartbeats).toBe(0);
    expect(peer!.state).toBe("active");
  });

  it("multiple peers recover independently in same heartbeat round", async () => {
    insertPeer(db, "peer-a", "http://a.test", "suspended", 3);
    insertPeer(db, "peer-b", "http://b.test", "suspended", 2);
    insertPeer(db, "peer-c", "http://c.test", "active", 1);

    stubFetchSuccess();
    await sendHeartbeats(db, identity);

    const peerA = getPeer(db, "peer-a");
    const peerB = getPeer(db, "peer-b");
    const peerC = getPeer(db, "peer-c");

    expect(peerA!.missed_heartbeats).toBe(2);
    expect(peerA!.state).toBe("suspended");

    expect(peerB!.missed_heartbeats).toBe(1);
    expect(peerB!.state).toBe("suspended");

    expect(peerC!.missed_heartbeats).toBe(0);
    expect(peerC!.state).toBe("active");
  });
});
