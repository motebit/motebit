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
});
