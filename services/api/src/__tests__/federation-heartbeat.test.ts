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
import { generateKeypair, bytesToHex } from "@motebit/crypto";

/** Manually insert a peer into the DB for heartbeat testing. */
function insertPeer(
  db: DatabaseDriver,
  peerId: string,
  endpointUrl: string,
  state: string,
  missed = 0,
): void {
  const keypair = crypto.getRandomValues(new Uint8Array(32));
  db.prepare(
    `INSERT OR REPLACE INTO relay_peers (peer_relay_id, public_key, endpoint_url, state, missed_heartbeats, agent_count, trust_score)
     VALUES (?, ?, ?, ?, ?, 0, 0.5)`,
  ).run(peerId, bytesToHex(keypair), endpointUrl, state, missed);
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
      "CREATE TABLE IF NOT EXISTS agent_registry (motebit_id TEXT PRIMARY KEY, expires_at INTEGER)",
    );
    db = moteDb.db;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("increments missed_heartbeats when peer is unreachable", async () => {
    insertPeer(db, "dead-peer", "http://unreachable.test:9999", "active", 0);

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
    insertPeer(db, "flaky-peer", "http://flaky.test:9999", "active", 2); // Already missed 2

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
    insertPeer(db, "gone-peer", "http://gone.test:9999", "suspended", 4); // Already missed 4

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
    insertPeer(db, "recovering-peer", "http://recovering.test", "suspended", 3);

    vi.stubGlobal("fetch", async () => {
      return new Response(
        JSON.stringify({
          relay_id: "peer-relay",
          timestamp: Date.now(),
          agent_count: 5,
          signature: bytesToHex(new Uint8Array(64)),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

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
    insertPeer(db, "removed-peer", "http://removed.test:9999", "removed", 10);

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
    insertPeer(db, "alive-peer", "http://alive.test", "active", 0);
    insertPeer(db, "dead-peer-2", "http://dead.test", "active", 0);

    vi.stubGlobal("fetch", async (url: string) => {
      if (typeof url === "string" && url.includes("alive.test")) {
        return new Response(
          JSON.stringify({
            relay_id: "alive",
            timestamp: Date.now(),
            agent_count: 1,
            signature: "aa",
          }),
          { status: 200 },
        );
      }
      throw new Error("Connection refused");
    });

    await sendHeartbeats(db, identity);

    const alive = getPeer(db, "alive-peer");
    const dead = getPeer(db, "dead-peer-2");
    expect(alive!.missed_heartbeats).toBe(0);
    expect(alive!.state).toBe("active");
    expect(dead!.missed_heartbeats).toBe(1);
    expect(dead!.state).toBe("active");
  });
});
