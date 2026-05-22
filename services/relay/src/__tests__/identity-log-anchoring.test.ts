/**
 * Identity-log anchoring: snapshot the bindings, sign + persist the root, submit
 * on-chain via an injected ChainAnchorSubmitter, and expose the latest confirmed
 * root. The on-chain submission is mocked; the focus is the cut → sign → confirm
 * state machine that makes the log root non-equivocable.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/crypto";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
import type { ChainAnchorSubmitter } from "@motebit/sdk";
import type { RelayIdentity } from "../federation.js";
import {
  createIdentityLogAnchorTables,
  anchorIdentityLog,
  submitIdentityLogAnchorOnChain,
  getLatestAnchoredRoot,
  runIdentityLogAnchorTick,
  startIdentityLogAnchorLoop,
} from "../identity-log-anchoring.js";
import { buildIdentityLog } from "../identity-log.js";
import { readIdentityBindings } from "../identity-transparency.js";

function mockSubmitter(txHash: string, throws = false): ChainAnchorSubmitter {
  return {
    chain: "solana:mainnet",
    network: "mainnet-beta",
    submitMerkleRoot: async () => {
      if (throws) throw new Error("rpc down");
      return { txHash };
    },
  } as unknown as ChainAnchorSubmitter;
}

describe("identity-log anchoring", () => {
  let db: DatabaseDriver;
  let relayIdentity: RelayIdentity;

  beforeEach(async () => {
    db = (await openMotebitDatabase(":memory:")).db;
    db.exec("DROP TABLE IF EXISTS agent_registry");
    db.exec(
      "CREATE TABLE agent_registry (motebit_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, registered_at INTEGER NOT NULL)",
    );
    createIdentityLogAnchorTables(db);
    const kp = await generateKeypair();
    relayIdentity = {
      relayMotebitId: "relay-test",
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      publicKeyHex: bytesToHex(kp.publicKey),
      did: "did:key:test",
    };
  });

  async function register(motebitId: string): Promise<void> {
    const k = bytesToHex((await generateKeypair()).publicKey);
    db.prepare(
      "INSERT INTO agent_registry (motebit_id, public_key, registered_at) VALUES (?, ?, ?)",
    ).run(motebitId, k, 1000);
  }

  it("anchors the current binding snapshot's root (signed, not yet on-chain)", async () => {
    await register("mote-a");
    await register("mote-b");

    const rec = await anchorIdentityLog(db, relayIdentity);
    expect(rec).not.toBeNull();
    expect(rec!.leaf_count).toBe(2);
    expect(rec!.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect(rec!.signature).toMatch(/^[0-9a-f]+$/);

    // The anchored root equals a fresh build of the same bindings (snapshot fidelity).
    const fresh = await buildIdentityLog(readIdentityBindings(db));
    expect(rec!.merkle_root).toBe(fresh.root);

    const row = db
      .prepare("SELECT status, tx_hash FROM relay_identity_log_anchors WHERE anchor_id = ?")
      .get(rec!.anchor_id) as { status: string; tx_hash: string | null };
    expect(row.status).toBe("signed");
    expect(row.tx_hash).toBeNull();
  });

  it("returns null when there are no bindings", async () => {
    expect(await anchorIdentityLog(db, relayIdentity)).toBeNull();
  });

  it("on-chain submission confirms the anchor; getLatestAnchoredRoot returns it", async () => {
    await register("mote-a");
    const rec = await anchorIdentityLog(db, relayIdentity);
    expect(getLatestAnchoredRoot(db)).toBeNull(); // signed, not confirmed

    const ok = await submitIdentityLogAnchorOnChain(
      db,
      rec!.anchor_id,
      mockSubmitter("tx-confirmed"),
    );
    expect(ok).toBe(true);

    const latest = getLatestAnchoredRoot(db);
    expect(latest).not.toBeNull();
    expect(latest!.merkle_root).toBe(rec!.merkle_root);
    expect(latest!.tx_hash).toBe("tx-confirmed");
    expect(latest!.network).toBe("mainnet-beta");
  });

  it("submit failure leaves the anchor unconfirmed (retryable)", async () => {
    await register("mote-a");
    const rec = await anchorIdentityLog(db, relayIdentity);
    const ok = await submitIdentityLogAnchorOnChain(db, rec!.anchor_id, mockSubmitter("x", true));
    expect(ok).toBe(false);
    expect(getLatestAnchoredRoot(db)).toBeNull();
  });

  describe("periodic anchor tick", () => {
    /** A submitter whose confirmations we can count across ticks. */
    function countingSubmitter(): { submitter: ChainAnchorSubmitter; calls: () => number } {
      let n = 0;
      const submitter = {
        chain: "solana:mainnet",
        network: "mainnet-beta",
        submitMerkleRoot: async () => {
          n += 1;
          return { txHash: `tx-${n}` };
        },
      } as unknown as ChainAnchorSubmitter;
      return { submitter, calls: () => n };
    }

    function anchorCount(): number {
      return (
        db.prepare("SELECT COUNT(*) AS c FROM relay_identity_log_anchors").get() as { c: number }
      ).c;
    }

    it("anchors on the first tick when bindings exist, and confirms on-chain", async () => {
      await register("mote-a");
      const { submitter, calls } = countingSubmitter();

      await runIdentityLogAnchorTick(db, relayIdentity, { submitter });

      expect(anchorCount()).toBe(1);
      expect(calls()).toBe(1);
      expect(getLatestAnchoredRoot(db)).not.toBeNull();
    });

    it("does not re-anchor an unchanged set within the interval", async () => {
      await register("mote-a");
      const { submitter } = countingSubmitter();
      // Large interval → only the root-change trigger can fire, not staleness.
      const cfg = { submitter, intervalMs: 3_600_000 };

      await runIdentityLogAnchorTick(db, relayIdentity, cfg);
      await runIdentityLogAnchorTick(db, relayIdentity, cfg);
      await runIdentityLogAnchorTick(db, relayIdentity, cfg);

      expect(anchorCount()).toBe(1);
    });

    it("re-anchors when a new registration changes the root", async () => {
      await register("mote-a");
      const { submitter } = countingSubmitter();
      const cfg = { submitter, intervalMs: 3_600_000 };

      await runIdentityLogAnchorTick(db, relayIdentity, cfg);
      expect(anchorCount()).toBe(1);

      await register("mote-b"); // root moves
      await runIdentityLogAnchorTick(db, relayIdentity, cfg);
      expect(anchorCount()).toBe(2);
    });

    it("re-anchors an unchanged set once it is stale (freshness signal)", async () => {
      await register("mote-a");
      const { submitter } = countingSubmitter();

      // intervalMs 0 → any prior anchor is immediately "stale".
      await runIdentityLogAnchorTick(db, relayIdentity, { submitter, intervalMs: 0 });
      await runIdentityLogAnchorTick(db, relayIdentity, { submitter, intervalMs: 0 });

      expect(anchorCount()).toBe(2); // same root, re-attested
    });

    it("retries a previously signed-but-unsubmitted anchor", async () => {
      await register("mote-a");
      // A pre-existing signed anchor that never reached the chain.
      const rec = await anchorIdentityLog(db, relayIdentity);
      expect(getLatestAnchoredRoot(db)).toBeNull();

      const { submitter, calls } = countingSubmitter();
      await runIdentityLogAnchorTick(db, relayIdentity, { submitter, intervalMs: 3_600_000 });

      // The stale signed record got submitted; root is unchanged so no new cut.
      expect(calls()).toBe(1);
      expect(anchorCount()).toBe(1);
      const latest = getLatestAnchoredRoot(db);
      expect(latest!.merkle_root).toBe(rec!.merkle_root);
    });

    it("anchors nothing when there are no bindings", async () => {
      const { submitter } = countingSubmitter();
      await runIdentityLogAnchorTick(db, relayIdentity, { submitter });
      expect(anchorCount()).toBe(0);
    });

    it("the interval loop fires the tick and respects isFrozen", async () => {
      await register("mote-a");
      const { submitter } = countingSubmitter();

      // Frozen: the loop ticks but the freeze gate short-circuits before any work.
      const frozen = startIdentityLogAnchorLoop(
        db,
        relayIdentity,
        { submitter, intervalMs: 10 },
        () => true,
      );
      await new Promise((r) => setTimeout(r, 40));
      clearInterval(frozen);
      expect(anchorCount()).toBe(0);

      // Unfrozen: the loop cuts an anchor on its own cadence.
      const live = startIdentityLogAnchorLoop(db, relayIdentity, { submitter, intervalMs: 10 });
      await new Promise((r) => setTimeout(r, 40));
      clearInterval(live);
      expect(anchorCount()).toBeGreaterThanOrEqual(1);
    });
  });
});
