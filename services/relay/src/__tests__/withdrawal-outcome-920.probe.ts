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
import { OperatorSolanaTransfer, type SolanaRpcAdapter } from "@motebit/wallet-solana";
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
const DEST = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UAAAA";

async function cell(
  name: string,
  sendUsdc: SolanaRpcAdapter["sendUsdc"],
  after?: (relay: SyncRelay, id: string) => Promise<void>,
): Promise<void> {
  const adapter: SolanaRpcAdapter = {
    ownAddress: "RelayTreasuryAddressBase58",
    getUsdcBalance: vi.fn().mockResolvedValue(10_000_000_000n),
    getUsdcBalanceOf: vi.fn().mockResolvedValue(10_000_000_000n),
    getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
    sendUsdc,
    sendUsdcBatch: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
    isReachable: vi.fn().mockResolvedValue(true),
  };
  const relay = await createTestRelay({
    enableDeviceAuth: false,
    operatorSolanaTransfer: new OperatorSolanaTransfer(adapter),
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

it("confirmed:false landed", async () => {
  await cell(
    "confirmed_false_landed",
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

it("confirmed:false landed, then operator fail replay", async () => {
  await cell(
    "confirmed_false_then_admin_fail",
    vi.fn().mockResolvedValue({ signature: SIG, slot: 7, confirmed: false }),
    async (relay, wid) => {
      const r = await relay.app.request(`/api/v1/admin/withdrawals/${wid}/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({ reason: "operator replay" }),
      });
      obs["confirmed_false_then_admin_fail_http"] = r.status;
    },
  );
});
