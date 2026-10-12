/**
 * Heartbeat sender tests — verifies liveness detection, suspension, and removal.
 *
 * Tests the `sendHeartbeats()` tick function directly (not the interval wrapper)
 * to avoid timing flakiness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendHeartbeats, createFederationTables } from "../federation.js";
import type { RelayIdentity } from "../federation.js";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { ackingFetch } from "./federation-messages.js";

/** Manually insert a peer into the DB for heartbeat testing. */
/** Each inserted peer's private key — the v2 ack a stub peer answers with is signed by it. */
const PEER_KEYS = new Map<string, Uint8Array>();

async function insertPeer(
  db: DatabaseDriver,
  peerId: string,
  endpointUrl: string,
  state: string,
  missed = 0,
): Promise<void> {
  const keypair = await generateKeypair();
  PEER_KEYS.set(peerId, keypair.privateKey);
  db.prepare(
    // A peer row is a confirmed handshake (`peered_at` set): a never-confirmed
    // row confers no authority (relay-federation@1.5 §3.1).
    `INSERT OR REPLACE INTO relay_peers (peer_relay_id, public_key, endpoint_url, state, missed_heartbeats, agent_count, trust_score, peered_at)
     VALUES (?, ?, ?, ?, ?, 0, 0.5, ?)`,
  ).run(peerId, bytesToHex(keypair.publicKey), endpointUrl, state, missed, Date.now() - 60_000);
}

function getPeer(
  db: DatabaseDriver,
  peerId: string,
): { state: string; missed_heartbeats: number } | undefined {
  return db
    .prepare("SELECT state, missed_heartbeats FROM relay_peers WHERE peer_relay_id = ?")
    .get(peerId) as { state: string; missed_heartbeats: number } | undefined;
}

describe("Heartbeat Sender", () => {
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
    createFederationTables(moteDb.db);
    moteDb.db.exec(
      "CREATE TABLE IF NOT EXISTS agent_registry (motebit_id TEXT PRIMARY KEY, expires_at INTEGER, delisted_at INTEGER)",
    );
    db = moteDb.db;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("increments missed_heartbeats when peer is unreachable", async () => {
    await insertPeer(db, "dead-peer", "http://unreachable.test:9999", "active", 0);

    // Stub fetch to fail
    vi.stubGlobal("fetch", async () => {
      throw new Error("Connection refused");
    });

    await sendHeartbeats(db, identity);

    const peer = getPeer(db, "dead-peer");
    expect(peer).toBeDefined();
    expect(peer!.missed_heartbeats).toBe(1);
    expect(peer!.state).toBe("active"); // Still active after 1 miss
  });

  it("suspends peer at 3 missed heartbeats", async () => {
    await insertPeer(db, "flaky-peer", "http://flaky.test:9999", "active", 2); // Already missed 2

    vi.stubGlobal("fetch", async () => {
      throw new Error("Connection refused");
    });

    await sendHeartbeats(db, identity);

    const peer = getPeer(db, "flaky-peer");
    expect(peer).toBeDefined();
    expect(peer!.missed_heartbeats).toBe(3);
    expect(peer!.state).toBe("suspended");
  });

  it("removes peer at 5 missed heartbeats", async () => {
    await insertPeer(db, "gone-peer", "http://gone.test:9999", "suspended", 4); // Already missed 4

    vi.stubGlobal("fetch", async () => {
      throw new Error("Connection refused");
    });

    await sendHeartbeats(db, identity);

    const peer = getPeer(db, "gone-peer");
    expect(peer).toBeDefined();
    expect(peer!.missed_heartbeats).toBe(5);
    expect(peer!.state).toBe("removed");
  });

  it("decrements missed count on successful heartbeat (hysteresis)", async () => {
    await insertPeer(db, "recovering-peer", "http://recovering.test", "suspended", 3);

    // Each success is a heartbeat whose signed v2 ack verifies (§3.2).
    vi.stubGlobal("fetch", ackingFetch(PEER_KEYS, identity.publicKeyHex));

    // First success: 3 → 2 (still suspended)
    await sendHeartbeats(db, identity);
    let peer = getPeer(db, "recovering-peer");
    expect(peer!.missed_heartbeats).toBe(2);
    expect(peer!.state).toBe("suspended");

    // Second success: 2 → 1 (still suspended)
    await sendHeartbeats(db, identity);
    peer = getPeer(db, "recovering-peer");
    expect(peer!.missed_heartbeats).toBe(1);
    expect(peer!.state).toBe("suspended");

    // Third success: 1 → 0 (reactivated)
    await sendHeartbeats(db, identity);
    peer = getPeer(db, "recovering-peer");
    expect(peer!.missed_heartbeats).toBe(0);
    expect(peer!.state).toBe("active");
  });

  it("skips removed peers", async () => {
    await insertPeer(db, "removed-peer", "http://removed.test:9999", "removed", 10);

    let fetchCalled = false;
    vi.stubGlobal("fetch", async () => {
      fetchCalled = true;
      return new Response("ok", { status: 200 });
    });

    await sendHeartbeats(db, identity);

    // Fetch should NOT be called — removed peers are excluded
    expect(fetchCalled).toBe(false);
  });

  it("handles concurrent peers independently", async () => {
    await insertPeer(db, "alive-peer", "http://alive.test", "active", 0);
    await insertPeer(db, "dead-peer-2", "http://dead.test", "active", 0);

    vi.stubGlobal(
      "fetch",
      ackingFetch(PEER_KEYS, identity.publicKeyHex, (peerId) => peerId === "alive-peer"),
    );

    await sendHeartbeats(db, identity);

    const alive = getPeer(db, "alive-peer");
    const dead = getPeer(db, "dead-peer-2");
    expect(alive!.missed_heartbeats).toBe(0);
    expect(alive!.state).toBe("active");
    expect(dead!.missed_heartbeats).toBe(1);
    expect(dead!.state).toBe("active");
  });

  it("counts an unverified 2xx as a missed heartbeat (the ack must verify)", async () => {
    await insertPeer(db, "liar-peer", "http://liar.test", "active", 0);
    // The v1 response shape, or any 2xx without a valid ack under the peer's key.
    vi.stubGlobal("fetch", async () => {
      return new Response(
        JSON.stringify({
          relay_id: "liar-peer",
          timestamp: Date.now(),
          agent_count: 1,
          signature: "aa",
        }),
        { status: 200 },
      );
    });
    await sendHeartbeats(db, identity);
    expect(getPeer(db, "liar-peer")!.missed_heartbeats).toBe(1);

    // An ack signed by a different peer's key is not this peer's ack.
    await insertPeer(db, "other-peer", "http://other.test", "removed", 0);
    const keys = new Map([["liar-peer", PEER_KEYS.get("other-peer")!]]);
    vi.stubGlobal("fetch", ackingFetch(keys, identity.publicKeyHex));
    await sendHeartbeats(db, identity);
    expect(getPeer(db, "liar-peer")!.missed_heartbeats).toBe(2);
  });
});
