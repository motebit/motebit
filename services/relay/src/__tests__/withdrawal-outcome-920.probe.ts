/**
 * #920 differential probe — Path 0 withdrawal outcome. Run with
 * scripts/differential-vs-main.ts --probe <this> --pkg services/relay.
 *
 * One cell per send outcome (confirmed:true, confirmed:false landed,
 * confirmed:false slot 0, throw), plus a fail-retry cell. Each records the
 * withdrawal's status, whether it carries a relay signature, the balance
 * relative to the funded amount, and how many refund credits exist. Uses only
 * surfaces present on both trees: the /withdraw and admin /fail routes, the
 * injected OperatorSolanaTransfer, and the accounts shim reads.
 */
import { it, afterAll, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import {
  OperatorSolanaTransfer,
  Web3JsRpcAdapter,
  deriveSolanaAddress,
  type SolanaRpcAdapter,
} from "@motebit/wallet-solana";
import type { SyncRelay } from "../index.js";
import { creditAccount, getAccountBalance, getTransactions } from "../accounts.js";
import { AUTH_HEADER, createTestRelay, jsonAuthWithIdempotency } from "./test-helpers.js";

const obs: Record<string, unknown> = {};
afterAll(() => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
});

const FUNDED = 5_000_000;
const SIG =
  "5VfYdxYhWnD8X7K2YgHmBpDXJqJ1JmZj7rL2KkXg8sM3QfvN9P1bZw6cM5J8nT4rA7uW9eR6yU2dE1pV3hG4oS9k";
// An on-curve address: the real adapter derives its ATA and refuses an off-curve owner.
const DEST = deriveSolanaAddress(new Uint8Array(32).fill(9));

async function cell(
  name: string,
  sendUsdc: SolanaRpcAdapter["sendUsdc"] | { operator: OperatorSolanaTransfer },
  after?: (relay: SyncRelay, id: string) => Promise<void>,
): Promise<void> {
  const operator =
    typeof sendUsdc === "object" && "operator" in sendUsdc
      ? sendUsdc.operator
      : new OperatorSolanaTransfer(fakeAdapter(sendUsdc));
  await runCell(name, operator, after);
}

function fakeAdapter(sendUsdc: SolanaRpcAdapter["sendUsdc"]): SolanaRpcAdapter {
  return {
    // #949: a tree whose Path 0 requires a transfer that records its
    // broadcasts sees one; a tree that does not is unaffected.
    honorsBroadcastHooks: true,
    // The node's retained-history edge (#949 rounds 2–3): full history.
    getLocalLedgerFirstSlot: () => Promise.resolve(0),
    getSignatureOutcome: vi.fn().mockResolvedValue({ status: "pending" }),
    ownAddress: "RelayTreasuryAddressBase58",
    getUsdcBalance: vi.fn().mockResolvedValue(10_000_000_000n),
    getUsdcBalanceOf: vi.fn().mockResolvedValue(10_000_000_000n),
    getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
    sendUsdc,
    sendUsdcBatch: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
    isReachable: vi.fn().mockResolvedValue(true),
  };
}

async function runCell(
  name: string,
  operator: OperatorSolanaTransfer,
  after?: (relay: SyncRelay, id: string) => Promise<void>,
): Promise<void> {
  const relay = await createTestRelay({
    enableDeviceAuth: false,
    operatorSolanaTransfer: operator,
  });
  try {
    const id = "probe-user";
    const kp = await generateKeypair();
    await relay.app.request(`/api/v1/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: id,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["web_search"],
        public_key: bytesToHex(kp.publicKey),
      }),
    });
    creditAccount(relay.moteDb.db, id, FUNDED, "deposit", "probe-deposit", "self-deposit");
    const res = await relay.app.request(`/api/v1/agents/${id}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 1.5, destination: DEST }),
    });
    const body = (await res.json()) as { withdrawal: { withdrawal_id: string; status: string } };
    const wid = body.withdrawal.withdrawal_id;
    if (after) await after(relay, wid);
    const row = relay.moteDb.db
      .prepare(
        "SELECT status, relay_signature, failure_reason FROM relay_withdrawals WHERE withdrawal_id = ?",
      )
      .get(wid) as {
      status: string;
      relay_signature: string | null;
      failure_reason: string | null;
    };
    obs[name] = {
      http: res.status,
      response_status: body.withdrawal.status,
      row_status: row.status,
      signed: row.relay_signature !== null,
      failure_reason_names_tx: (row.failure_reason ?? "").includes(SIG),
      balance_minus_funded: (getAccountBalance(relay.moteDb.db, id)?.balance ?? 0) - FUNDED,
      refund_credits: getTransactions(relay.moteDb.db, id, 100).filter(
        (t) => t.reference_id === wid && t.amount > 0,
      ).length,
    };
  } finally {
    await relay.close();
  }
}

it("confirmed:true", async () => {
  await cell(
    "confirmed_true",
    vi.fn().mockResolvedValue({ signature: SIG, slot: 7, confirmed: true }),
  );
});

it("confirmed:false, earlierBroadcastsDead absent", async () => {
  await cell(
    "confirmed_false_field_absent",
    vi.fn().mockResolvedValue({ signature: SIG, slot: 7, confirmed: false }),
  );
});

it("confirmed:false slot 0", async () => {
  await cell(
    "confirmed_false_slot0",
    vi.fn().mockResolvedValue({ signature: SIG, slot: 0, confirmed: false }),
  );
});

it("send throws", async () => {
  await cell("send_throws", vi.fn().mockRejectedValue(new Error("was not confirmed in 30s")));
});

it("confirmed:false unresolved, then operator reconciles and fails", async () => {
  await cell(
    "unresolved_then_operator_fail",
    vi.fn().mockResolvedValue({ signature: SIG, slot: 7, confirmed: false }),
    async (relay, wid) => {
      const r = await relay.app.request(`/api/v1/admin/withdrawals/${wid}/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({ reason: "operator replay" }),
      });
      obs["unresolved_then_operator_fail_http"] = r.status;
    },
  );
});

it("confirmed:false + earlierBroadcastsDead:true (proven single broadcast)", async () => {
  await cell(
    "confirmed_false_earlier_dead",
    vi.fn().mockResolvedValue({
      signature: SIG,
      slot: 7,
      confirmed: false,
      earlierBroadcastsDead: true,
    }),
  );
});

it("confirmed:false + earlierBroadcastsDead:false", async () => {
  await cell(
    "confirmed_false_earlier_unproven",
    vi.fn().mockResolvedValue({
      signature: SIG,
      slot: 7,
      confirmed: false,
      earlierBroadcastsDead: false,
    }),
  );
});

/**
 * The #920 cold reviewer's cell, on the REAL Web3JsRpcAdapter with a stubbed
 * Connection: attempt 1 broadcasts sig1 and its confirmation loses the race to
 * "block height exceeded" (sig1 may have LANDED and paid); the adapter
 * re-signs, and attempt 2 (its create-ATA instruction now invalid) lands and
 * fails. The adapter reports sig2 with confirmed:false and no
 * earlierBroadcastsDead. Head must leave it pending and never refund.
 */
it("real adapter: blockhash-expiry retry, second broadcast lands and fails", async () => {
  const adapter = new Web3JsRpcAdapter({
    rpcUrl: "http://127.0.0.1:1",
    identitySeed: new Uint8Array(32).fill(7),
  });
  let sends = 0;
  let confirms = 0;
  const conn = {
    // The pre-blockhash slot read and the retention edge (#949 rounds 2–3).
    getSlot: vi.fn().mockResolvedValue(8_000),
    getMinimumLedgerSlot: vi.fn().mockResolvedValue(0),
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
      lastValidBlockHeight: 100,
    }),
    getAccountInfo: vi.fn().mockResolvedValue(null), // dest ATA missing: create-ATA ix
    sendRawTransaction: vi.fn().mockImplementation(() => {
      sends++;
      return Promise.resolve(sends === 1 ? "sig1" + SIG.slice(4) : SIG);
    }),
    confirmTransaction: vi.fn().mockImplementation(() => {
      confirms++;
      if (confirms === 1)
        return Promise.reject(new Error("Signature sig1 has expired: block height exceeded."));
      return Promise.resolve({
        context: { slot: 4242 },
        value: { err: { InstructionError: [0, { Custom: 0 }] } },
      });
    }),
  };
  (adapter as unknown as { connection: unknown }).connection = conn;
  (adapter as unknown as { getUsdcBalance: () => Promise<bigint> }).getUsdcBalance = () =>
    Promise.resolve(10_000_000_000n);
  await cell("real_adapter_expiry_retry", { operator: new OperatorSolanaTransfer(adapter) });
  obs["real_adapter_expiry_retry_broadcasts"] = sends;
});
