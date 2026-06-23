/**
 * Commitment-bond phase 1 — store, verifier loop, and additive eligibility.
 *
 * Phase 1 is an anti-sybil staked SIGNAL, never recourse (CLAUDE.md rule 19;
 * spec/bond-v1.md). These tests cover the three relay-side pieces:
 *   - bond-store: verify-then-persist + the relay's key→id binding + readers
 *   - bond-verifier: RPC-reads backing, never downgrades on transient error
 *   - eligibility: the additive bonded branch + its two anti-reuse defenses
 *
 * The happy paths AND the adversarial paths (cross-identity reuse, drain-
 * between-polls staleness, concurrent-ticket over-exposure) are first-class —
 * this is where a high-value settlement decision lives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import type { DatabaseDriver } from "@motebit/persistence";
import type { SolanaRpcAdapter } from "@motebit/wallet-solana";
import { SOLANA_MAINNET_CAIP2 } from "@motebit/wallet-solana";
import {
  generateKeypair,
  signBondCommitment,
  base58btcEncode,
  bytesToHex,
  type BondCommitment,
} from "@motebit/crypto";
import {
  recordBondCommitment,
  getBestLiveBond,
  workerInFlightP2pCostMicro,
  markBondBacking,
} from "../bond-store.js";
import { startBondVerifierLoop } from "../bond-verifier.js";
import { evaluateSettlementEligibility } from "../task-routing.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

async function registerAgent(
  relay: SyncRelay,
  motebitId: string,
  publicKeyHex: string,
  opts?: { settlementAddress?: string },
) {
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: publicKeyHex,
      settlement_address: opts?.settlementAddress ?? null,
      settlement_modes: "relay,p2p",
    }),
  });
}

function setTrust(
  db: DatabaseDriver,
  fromId: string,
  toId: string,
  trustLevel: string,
  interactionCount: number,
) {
  db.prepare(
    `INSERT OR REPLACE INTO agent_trust
     (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(fromId, toId, trustLevel, interactionCount, Date.now(), Date.now());
}

/** Insert a worker's in-flight (pending) p2p settlement — the cross-ticket
 *  exposure the bonded branch must subtract from available backing. */
function insertPendingP2p(
  db: DatabaseDriver,
  workerId: string,
  taskId: string,
  amountMicro: number,
) {
  db.prepare(
    `INSERT OR IGNORE INTO relay_settlements
     (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
      amount_settled, platform_fee, platform_fee_rate, status, settled_at,
      settlement_mode, p2p_tx_hash, payment_verification_status, delegator_id)
     VALUES (?, ?, ?, ?, '', ?, 0, 0, 'completed', ?, 'p2p', ?, 'pending', 'del-x')`,
  ).run(
    `stl-${taskId}`,
    `alloc-${taskId}`,
    taskId,
    workerId,
    amountMicro,
    Date.now(),
    `tx-${taskId}`,
  );
}

interface BondOverrides {
  bondId?: string;
  motebitId?: string;
  bondedPublicKey?: string;
  bondedAddress?: string;
  amountMicro?: number;
  expiresAt?: number;
  privateKey?: Uint8Array;
}

/** A keypair + its derived sovereign address + a signed-bond factory. */
async function makeWorkerKeys() {
  const kp = await generateKeypair();
  const pubHex = bytesToHex(kp.publicKey);
  const address = base58btcEncode(kp.publicKey);
  async function signBond(o: BondOverrides = {}): Promise<BondCommitment> {
    const issued = Date.now();
    const unsigned: Omit<BondCommitment, "signature" | "suite"> = {
      bond_id: o.bondId ?? "01900000-0000-7000-8000-00000000000a",
      motebit_id: o.motebitId ?? "bond-worker",
      bonded_public_key: o.bondedPublicKey ?? pubHex,
      bonded_address: o.bondedAddress ?? address,
      bond_amount_micro: o.amountMicro ?? 10_000_000,
      asset: "USDC",
      chain: SOLANA_MAINNET_CAIP2,
      issued_at: issued,
      expires_at: o.expiresAt ?? issued + 86_400_000,
    };
    return signBondCommitment(unsigned, o.privateKey ?? kp.privateKey);
  }
  return { kp, pubHex, address, signBond };
}

describe("bond-store — verify + persist", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });
  afterEach(async () => {
    await relay.close();
  });

  it("records a valid bond from a registered worker", async () => {
    const w = await makeWorkerKeys();
    await registerAgent(relay, "bond-worker", w.pubHex, { settlementAddress: WORKER_ADDR });
    const bond = await w.signBond();

    const res = await recordBondCommitment(relay.moteDb.db, bond);
    expect(res.ok).toBe(true);

    const stored = getBestLiveBond(relay.moteDb.db, "bond-worker", Date.now());
    expect(stored).not.toBeNull();
    expect(stored?.bond_amount_micro).toBe(10_000_000);
    expect(stored?.backing_state).toBe("pending"); // not yet checked by the verifier
  });

  it("rejects a bond from an unregistered agent (no key to bind)", async () => {
    const w = await makeWorkerKeys();
    const bond = await w.signBond(); // never registered
    const res = await recordBondCommitment(relay.moteDb.db, bond);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bonding_agent_not_registered");
  });

  it("rejects a bond whose bonded key is not the registry key (key→id binding)", async () => {
    // Register the worker under key A; sign a self-consistent bond under key B
    // claiming the same motebit_id. The standalone verifier passes (the bond is
    // self-anchoring to B), but the relay's separate key→id binding rejects it —
    // otherwise an agent could bond an identity whose key it does not control.
    const a = await makeWorkerKeys();
    const b = await makeWorkerKeys();
    await registerAgent(relay, "bond-worker", a.pubHex, { settlementAddress: WORKER_ADDR });
    const imposterBond = await b.signBond({
      motebitId: "bond-worker",
      bondedPublicKey: b.pubHex,
      bondedAddress: b.address,
      privateKey: b.kp.privateKey,
    });
    const res = await recordBondCommitment(relay.moteDb.db, imposterBond);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bonded_key_not_registry_key");
  });

  it("rejects a tampered bond (signature/binding invalid)", async () => {
    const w = await makeWorkerKeys();
    await registerAgent(relay, "bond-worker", w.pubHex, { settlementAddress: WORKER_ADDR });
    const bond = await w.signBond();
    const tampered: BondCommitment = { ...bond, bond_amount_micro: 999_000_000 };
    const res = await recordBondCommitment(relay.moteDb.db, tampered);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bond_signature_or_binding_invalid");
  });

  it("sums a worker's in-flight pending p2p value (cross-ticket exposure input)", () => {
    insertPendingP2p(relay.moteDb.db, "bond-worker", "t1", 1_000_000);
    insertPendingP2p(relay.moteDb.db, "bond-worker", "t2", 2_500_000);
    expect(workerInFlightP2pCostMicro(relay.moteDb.db, "bond-worker")).toBe(3_500_000n);
    expect(workerInFlightP2pCostMicro(relay.moteDb.db, "other")).toBe(0n);
  });
});

describe("bond-verifier loop — RPC backing reads", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });
  afterEach(async () => {
    await relay.close();
  });

  function stubAdapter(balance: bigint | (() => Promise<bigint>)): SolanaRpcAdapter {
    const getUsdcBalanceOf =
      typeof balance === "function" ? vi.fn(balance) : vi.fn().mockResolvedValue(balance);
    return {
      ownAddress: "stub",
      getUsdcBalance: vi.fn().mockResolvedValue(0n),
      getUsdcBalanceOf,
      getSolBalance: vi.fn().mockResolvedValue(0n),
      sendUsdc: vi.fn(),
      sendUsdcBatch: vi.fn(),
      isReachable: vi.fn().mockResolvedValue(true),
      getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
    };
  }

  async function tickOnce(adapter: SolanaRpcAdapter): Promise<void> {
    const handle = startBondVerifierLoop(relay.moteDb.db, {
      rpcUrl: "http://stub",
      intervalMs: 20,
      maxPerCycle: 100,
      adapter,
    });
    await new Promise((r) => setTimeout(r, 80));
    clearInterval(handle);
  }

  async function recordWorkerBond(amountMicro = 10_000_000): Promise<void> {
    const w = await makeWorkerKeys();
    await registerAgent(relay, "bond-worker", w.pubHex, { settlementAddress: WORKER_ADDR });
    const bond = await w.signBond({ amountMicro });
    const res = await recordBondCommitment(relay.moteDb.db, bond);
    expect(res.ok).toBe(true);
  }

  it("marks a fully-funded bond backed and stamps last_checked_at", async () => {
    await recordWorkerBond(10_000_000);
    await tickOnce(stubAdapter(10_000_000n));

    const stored = getBestLiveBond(relay.moteDb.db, "bond-worker", Date.now());
    expect(stored?.backing_state).toBe("backed");
    expect(stored?.backed_amount_micro).toBe(10_000_000);
    expect(stored?.last_checked_at).not.toBeNull();
  });

  it("marks an under-funded bond underbacked", async () => {
    await recordWorkerBond(10_000_000);
    await tickOnce(stubAdapter(4_000_000n));

    const stored = getBestLiveBond(relay.moteDb.db, "bond-worker", Date.now());
    expect(stored?.backing_state).toBe("underbacked");
    expect(stored?.backed_amount_micro).toBe(4_000_000);
  });

  it("never downgrades a prior reading on a transient RPC error", async () => {
    await recordWorkerBond(10_000_000);
    // First cycle: backed.
    await tickOnce(stubAdapter(10_000_000n));
    const backed = getBestLiveBond(relay.moteDb.db, "bond-worker", Date.now());
    expect(backed?.backing_state).toBe("backed");
    const checkedAt = backed?.last_checked_at;

    // Second cycle: RPC throws — the row MUST be left untouched (no downgrade,
    // last_checked_at unchanged so it ages into stale and forces a sync re-check).
    await tickOnce(stubAdapter(() => Promise.reject(new Error("RPC down"))));
    const after = getBestLiveBond(relay.moteDb.db, "bond-worker", Date.now());
    expect(after?.backing_state).toBe("backed");
    expect(after?.last_checked_at).toBe(checkedAt);
  });
});

describe("evaluateSettlementEligibility — additive bonded branch", () => {
  let relay: SyncRelay;
  let worker: Awaited<ReturnType<typeof makeWorkerKeys>>;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const delKp = await generateKeypair();
    await registerAgent(relay, "del-b", bytesToHex(delKp.publicKey));
    worker = await makeWorkerKeys();
    // A NON-sovereign random id — so the sovereign branch never flips it; only
    // the bond can. This is what makes the bonded branch demonstrably additive.
    await registerAgent(relay, "bond-worker", worker.pubHex, { settlementAddress: WORKER_ADDR });
    // first_contact (0.3) + 2 interactions: below the strict 0.6/5 bar.
    setTrust(relay.moteDb.db, "del-b", "bond-worker", "first_contact", 2);
  });
  afterEach(async () => {
    await relay.close();
  });

  /** Record a bond and mark it freshly backed at `backedMicro` (skips the RPC loop). */
  async function freshBackedBond(committedMicro: number, backedMicro: number, ageMs = 0) {
    const bond = await worker.signBond({ amountMicro: committedMicro });
    expect((await recordBondCommitment(relay.moteDb.db, bond)).ok).toBe(true);
    const stored = getBestLiveBond(relay.moteDb.db, "bond-worker", Date.now())!;
    markBondBacking(relay.moteDb.db, stored.bond_id, "backed", backedMicro, Date.now() - ageMs);
  }

  it("is byte-identical without bondEval — an unbonded sub-threshold pair is rejected", async () => {
    const result = await evaluateSettlementEligibility(relay.moteDb.db, "del-b", "bond-worker");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("did not acknowledge");
  });

  it("a backed bond qualifies the worker at the relaxed bar (ticket ≤ bond/k)", async () => {
    await freshBackedBond(10_000_000, 10_000_000);
    // Without bondEval: still rejected (proves the branch is opt-in).
    const noOpt = await evaluateSettlementEligibility(relay.moteDb.db, "del-b", "bond-worker");
    expect(noOpt.allowed).toBe(false);

    // With bondEval: $1 ticket, k=10 → required $10, backing $10 → qualifies.
    const result = await evaluateSettlementEligibility(
      relay.moteDb.db,
      "del-b",
      "bond-worker",
      false,
      { unitCostMicro: 1_000_000n },
    );
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.mode).toBe("p2p");
      expect(result.reason).toContain("Bonded worker");
    }
  });

  it("rejects when backing is below the k× coverage requirement", async () => {
    await freshBackedBond(10_000_000, 10_000_000);
    // $2 ticket needs $20 backing; only $10 present → reject (falls through to
    // the no-acknowledgment rejection).
    const result = await evaluateSettlementEligibility(
      relay.moteDb.db,
      "del-b",
      "bond-worker",
      false,
      { unitCostMicro: 2_000_000n },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("did not acknowledge");
  });

  it("drain-between-polls: a STALE backed read is never trusted (fail-closed without an adapter)", async () => {
    // Backed reading, but 2 minutes old (> 60s staleness bound). No adapter to
    // re-verify → the bond does not qualify.
    await freshBackedBond(10_000_000, 10_000_000, 120_000);
    const result = await evaluateSettlementEligibility(
      relay.moteDb.db,
      "del-b",
      "bond-worker",
      false,
      { unitCostMicro: 1_000_000n },
    );
    expect(result.allowed).toBe(false);
  });

  it("drain-between-polls: accept-time re-verification catches a drained address", async () => {
    // Stale "backed" cache, but the address has actually been drained to 0. The
    // synchronous re-read (adapter) observes 0 → underbacked → reject.
    await freshBackedBond(10_000_000, 10_000_000, 120_000);
    const drainedAdapter = { getUsdcBalanceOf: vi.fn().mockResolvedValue(0n) };
    const result = await evaluateSettlementEligibility(
      relay.moteDb.db,
      "del-b",
      "bond-worker",
      false,
      { unitCostMicro: 1_000_000n, adapter: drainedAdapter },
    );
    expect(result.allowed).toBe(false);
    expect(drainedAdapter.getUsdcBalanceOf).toHaveBeenCalledOnce();
  });

  it("accept-time re-verification confirms a still-funded address on a stale cache", async () => {
    await freshBackedBond(10_000_000, 10_000_000, 120_000);
    const fundedAdapter = { getUsdcBalanceOf: vi.fn().mockResolvedValue(10_000_000n) };
    const result = await evaluateSettlementEligibility(
      relay.moteDb.db,
      "del-b",
      "bond-worker",
      false,
      { unitCostMicro: 1_000_000n, adapter: fundedAdapter },
    );
    expect(result.allowed).toBe(true);
    expect(fundedAdapter.getUsdcBalanceOf).toHaveBeenCalledOnce();
  });

  it("concurrent-ticket over-exposure: in-flight p2p value consumes bond capacity", async () => {
    await freshBackedBond(10_000_000, 10_000_000);
    // No in-flight: $1 ticket qualifies against the $10 bond.
    const first = await evaluateSettlementEligibility(
      relay.moteDb.db,
      "del-b",
      "bond-worker",
      false,
      { unitCostMicro: 1_000_000n },
    );
    expect(first.allowed).toBe(true);

    // Now the worker has $1 of in-flight (pending) p2p value. required becomes
    // k×($1 ticket + $1 in-flight) = $20 > $10 backing → reject. One bond cannot
    // back unbounded concurrent tickets.
    insertPendingP2p(relay.moteDb.db, "bond-worker", "inflight-1", 1_000_000);
    const second = await evaluateSettlementEligibility(
      relay.moteDb.db,
      "del-b",
      "bond-worker",
      false,
      { unitCostMicro: 1_000_000n },
    );
    expect(second.allowed).toBe(false);
  });

  it("an expired bond does not qualify", async () => {
    const expired = await worker.signBond({
      amountMicro: 10_000_000,
      expiresAt: Date.now() - 1000,
    });
    expect((await recordBondCommitment(relay.moteDb.db, expired)).ok).toBe(true);
    const result = await evaluateSettlementEligibility(
      relay.moteDb.db,
      "del-b",
      "bond-worker",
      false,
      { unitCostMicro: 1_000_000n },
    );
    expect(result.allowed).toBe(false);
  });
});
