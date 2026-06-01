/**
 * buildP2pPaymentProof — the delegator-side proof construction primitive.
 *
 * Per `@motebit/wallet-solana` rule 3, these run against the adapter interface
 * with no network: a minimal in-memory `SolanaRpcAdapter` double stands in for
 * `Web3JsRpcAdapter`. The primitive's contract is (a) broadcast worker + fee
 * legs in one atomic transaction, (b) assemble a `P2pPaymentProof` from the
 * confirmed signature, (c) refuse to emit a proof if the legs failed or did not
 * share one signature.
 */
import { describe, it, expect } from "vitest";
import { buildP2pPaymentProof } from "../p2p-payment-proof.js";
import { SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2 } from "../memo-submitter.js";
import type { SolanaRpcAdapter, SendUsdcArgs, SendUsdcBatchItemResult } from "../adapter.js";

const WORKER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
const TREASURY = "GsbwXfJraMomNxBcjsLBdbtZ4qZqL1HNbDmFqxK4y8Vh";
const EXECUTOR_TREASURY = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UTREASURY";
const SIG = "5".repeat(88);

interface RecordingAdapter extends SolanaRpcAdapter {
  lastBatch: readonly SendUsdcArgs[] | null;
}

/** Build an in-memory adapter whose `sendUsdcBatch` returns a scripted result. */
function fakeAdapter(
  onBatch: (items: readonly SendUsdcArgs[]) => SendUsdcBatchItemResult[],
): RecordingAdapter {
  const adapter: RecordingAdapter = {
    ownAddress: "De1egator11111111111111111111111111111111111",
    lastBatch: null,
    async getUsdcBalance() {
      return 0n;
    },
    async getSolBalance() {
      return 0n;
    },
    async sendUsdc() {
      throw new Error("sendUsdc not used by buildP2pPaymentProof");
    },
    async sendUsdcBatch(items) {
      adapter.lastBatch = items;
      return onBatch(items);
    },
    async getTransaction() {
      throw new Error("getTransaction not used by buildP2pPaymentProof");
    },
    async isReachable() {
      return true;
    },
  };
  return adapter;
}

const bothOk = (): SendUsdcBatchItemResult[] => [
  { ok: true, signature: SIG, slot: 42, reason: null },
  { ok: true, signature: SIG, slot: 42, reason: null },
];

describe("buildP2pPaymentProof", () => {
  it("broadcasts both legs as one atomic batch and assembles the proof", async () => {
    const adapter = fakeAdapter(bothOk);
    const proof = await buildP2pPaymentProof(adapter, {
      workerAddress: WORKER,
      treasuryAddress: TREASURY,
      amountMicro: 1_000_000,
      feeAmountMicro: 52_632,
    });

    expect(proof).toEqual({
      tx_hash: SIG,
      chain: "solana",
      network: SOLANA_MAINNET_CAIP2,
      to_address: WORKER,
      amount_micro: 1_000_000,
      fee_to_address: TREASURY,
      fee_amount_micro: 52_632,
    });
  });

  it("sends the worker leg and fee leg with the exact micro amounts", async () => {
    const adapter = fakeAdapter(bothOk);
    await buildP2pPaymentProof(adapter, {
      workerAddress: WORKER,
      treasuryAddress: TREASURY,
      amountMicro: 2_000_000,
      feeAmountMicro: 105_263,
    });

    expect(adapter.lastBatch).toEqual([
      { toAddress: WORKER, microAmount: 2_000_000n },
      { toAddress: TREASURY, microAmount: 105_263n },
    ]);
  });

  it("federated: broadcasts three legs and emits the b_fee executor-relay leg", async () => {
    const threeOk = (): SendUsdcBatchItemResult[] => [
      { ok: true, signature: SIG, slot: 42, reason: null },
      { ok: true, signature: SIG, slot: 42, reason: null },
      { ok: true, signature: SIG, slot: 42, reason: null },
    ];
    const adapter = fakeAdapter(threeOk);
    // $1.00 budget fee-from-budget split: worker 902_500, A 50_000, B 47_500.
    const proof = await buildP2pPaymentProof(adapter, {
      workerAddress: WORKER,
      treasuryAddress: TREASURY,
      amountMicro: 902_500,
      feeAmountMicro: 50_000,
      executorTreasuryAddress: EXECUTOR_TREASURY,
      executorFeeAmountMicro: 47_500,
    });

    expect(adapter.lastBatch).toEqual([
      { toAddress: WORKER, microAmount: 902_500n },
      { toAddress: TREASURY, microAmount: 50_000n },
      { toAddress: EXECUTOR_TREASURY, microAmount: 47_500n },
    ]);
    expect(proof.b_fee_to_address).toBe(EXECUTOR_TREASURY);
    expect(proof.b_fee_amount_micro).toBe(47_500);
    expect(proof.amount_micro).toBe(902_500);
    expect(proof.fee_amount_micro).toBe(50_000);
  });

  it("federated: rejects a half-specified executor leg", async () => {
    const adapter = fakeAdapter(bothOk);
    await expect(
      buildP2pPaymentProof(adapter, {
        workerAddress: WORKER,
        treasuryAddress: TREASURY,
        amountMicro: 902_500,
        feeAmountMicro: 50_000,
        executorTreasuryAddress: EXECUTOR_TREASURY,
        // executorFeeAmountMicro omitted
      }),
    ).rejects.toThrow(/BOTH executorTreasuryAddress and executorFeeAmountMicro/);
  });

  it("honors a network override (e.g. devnet)", async () => {
    const adapter = fakeAdapter(bothOk);
    const proof = await buildP2pPaymentProof(adapter, {
      workerAddress: WORKER,
      treasuryAddress: TREASURY,
      amountMicro: 1_000_000,
      feeAmountMicro: 52_632,
      network: SOLANA_DEVNET_CAIP2,
    });
    expect(proof.network).toBe(SOLANA_DEVNET_CAIP2);
  });

  it("throws when the worker leg fails to confirm", async () => {
    const adapter = fakeAdapter(() => [
      { ok: false, signature: null, slot: 0, reason: "insufficient funds" },
      { ok: false, signature: null, slot: 0, reason: "prior chunk failed" },
    ]);
    await expect(
      buildP2pPaymentProof(adapter, {
        workerAddress: WORKER,
        treasuryAddress: TREASURY,
        amountMicro: 1_000_000,
        feeAmountMicro: 52_632,
      }),
    ).rejects.toThrow(/broadcast failed/);
  });

  it("throws when only the fee leg fails (no half-paid proof)", async () => {
    const adapter = fakeAdapter(() => [
      { ok: true, signature: SIG, slot: 42, reason: null },
      { ok: false, signature: null, slot: 0, reason: "ata creation failed" },
    ]);
    await expect(
      buildP2pPaymentProof(adapter, {
        workerAddress: WORKER,
        treasuryAddress: TREASURY,
        amountMicro: 1_000_000,
        feeAmountMicro: 52_632,
      }),
    ).rejects.toThrow(/broadcast failed/);
  });

  it("throws when the legs did not settle under one signature (non-atomic)", async () => {
    const adapter = fakeAdapter(() => [
      { ok: true, signature: SIG, slot: 42, reason: null },
      { ok: true, signature: "9".repeat(88), slot: 43, reason: null },
    ]);
    await expect(
      buildP2pPaymentProof(adapter, {
        workerAddress: WORKER,
        treasuryAddress: TREASURY,
        amountMicro: 1_000_000,
        feeAmountMicro: 52_632,
      }),
    ).rejects.toThrow(/atomic/);
  });
});
