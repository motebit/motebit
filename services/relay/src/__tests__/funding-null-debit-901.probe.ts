/**
 * Differential probe for #901: is a task ever admitted as funded with no money
 * held? Four funding cells over the live submit route (the real `@x402/hono`
 * stack; only the facilitator's network round-trip is replaced — see
 * funding-null-debit-901.test.ts and, for the x402 hand-off itself,
 * x402-settlement-907.probe.ts):
 *
 *   A  x402, raw ≥ price > spendable (hold not covered by the balance), then
 *      the same key paid again
 *   B  x402, ordinary held earnings that net the 1.2× risk buffer
 *   C  relay-custody budget, the debit finds nothing (ledger fault injected),
 *      then the same key with the fault removed
 *   D  x402 gate bypass for a balance that is entirely escrow-held
 *
 *   pnpm tsx scripts/differential-vs-main.ts \
 *     --probe services/relay/src/__tests__/funding-null-debit-901.probe.ts --pkg services/relay
 *
 * Observations are statuses, counts and amounts in units of the gross price —
 * no ids — so every difference is a behaviour difference. `unfunded_holds` is
 * the count of allocation rows whose `amount_locked` exceeds what the ledger
 * actually debited for them: the defect, measured directly.
 */
import { it, beforeAll, afterAll, vi } from "vitest";
import { writeFileSync } from "node:fs";
// eslint-disable-next-line no-restricted-imports -- probe needs direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { computeGrossAmount } from "@motebit/market";
import { PLATFORM_FEE_RATE } from "@motebit/protocol";
import type { SyncRelay } from "../index.js";
import {
  createAgent,
  createTestRelay,
  JSON_AUTH,
  seedBalance,
  X402_TEST_CONFIG,
} from "./test-helpers.js";
import { creditAccount, toMicro } from "../accounts.js";

// The REAL @x402/hono stack (#907); only the facilitator's network round-trip
// is replaced, in-process (self-contained so the probe runs on both trees). A
// paid request carries a payment signed from the relay's own PAYMENT-REQUIRED
// challenge. `settled` counts onchain settlements; `quoted` records what each
// PAID request was verified against (atomic amount, destination).
const x402 = vi.hoisted(() => ({
  settled: 0,
  quoted: [] as { amount: string; payTo: string }[],
}));

vi.mock("../x402-facilitator.js", () => ({
  createX402FacilitatorClient: () =>
    Promise.resolve({
      getSupported: () =>
        Promise.resolve({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
          extensions: [],
          signers: {},
        }),
      verify: (_p: unknown, req: { amount: string; payTo: string }) => {
        x402.quoted.push({ amount: req.amount, payTo: req.payTo });
        return Promise.resolve({ isValid: true, payer: "0xpayer" });
      },
      settle: (_p: unknown, req: { network: string }) => {
        x402.settled += 1;
        let tx = "0x";
        for (let i = 0; i < 64; i++) tx += "0123456789abcdef"[Math.floor(Math.random() * 16)];
        return Promise.resolve({
          success: true,
          transaction: tx,
          network: req.network,
          payer: "0xpayer",
        });
      },
    }),
}));

const GROSS = toMicro(computeGrossAmount(1.0, PLATFORM_FEE_RATE));
let relay: SyncRelay;
const obs: Record<string, unknown> = {};

beforeAll(async () => {
  relay = await createTestRelay({ enableDeviceAuth: false });
}, 120_000);
afterAll(async () => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
  await relay.close();
}, 120_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe reads raw rows
const q = (sql: string, ...a: unknown[]) => relay.moteDb.db.prepare(sql).all(...a) as any[];
const inGross = (micro: number) => Math.round((micro / GROSS) * 1000) / 1000;

async function agent(): Promise<string> {
  const kp = await generateKeypair();
  return (await createAgent(relay, bytesToHex(kp.publicKey))).motebitId;
}
async function worker(payTo: boolean): Promise<string> {
  const id = await agent();
  await relay.app.request(`/api/v1/agents/${id}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: 1.0, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "901 probe worker",
      ...(payTo ? { pay_to_address: "0x00000000000000000000000000000000000000a1" } : {}),
    }),
  });
  return id;
}
function hold(id: string, micro: number, credit: boolean): void {
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, amount_settled, status, settled_at)
       VALUES (?, ?, ?, ?, ?, 'completed', ?)`,
    )
    .run(crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), id, micro, Date.now());
  if (credit) creditAccount(relay.moteDb.db, id, micro, "settlement_credit", null, "probe");
}
/** The relay's own challenge for `body` (throwaway key), signed; or a header the gate never reads. */
async function paymentFor(w: string, body: Record<string, unknown>): Promise<string> {
  const res = await relay.app.request(`/agent/${w}/task`, {
    method: "POST",
    headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (header == null) return "not-challenged";
  const required = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    resource: unknown;
    accepts: unknown[];
  };
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: required.resource,
      accepted: required.accepts[0],
      payload: {
        from: "0xpayer",
        authorization: {
          from: "0x" + Buffer.from(String("0xpayer")).toString("hex").padEnd(40, "0").slice(0, 40),
          to: (required.accepts[0] as { payTo: string }).payTo,
          value: (required.accepts[0] as { amount: string }).amount,
          validAfter: String(Math.floor(Date.now() / 1000) - 600),
          validBefore: String(Math.floor(Date.now() / 1000) + 300),
          nonce:
            "0x" +
            [...crypto.getRandomValues(new Uint8Array(32))]
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
        },
        signature: "0x" + "11".repeat(65),
      },
    }),
  ).toString("base64");
}
const submit = async (w: string, key: string, body: Record<string, unknown>, pay = false) => {
  const payment = pay ? await paymentFor(w, body) : undefined;
  return relay.app.request(`/agent/${w}/task`, {
    method: "POST",
    headers: {
      ...JSON_AUTH,
      "Idempotency-Key": key,
      ...(payment != null ? { "PAYMENT-SIGNATURE": payment } : {}),
    },
    body: JSON.stringify(body),
  });
};

/** Ledger truth for every allocation booked against this worker. */
function ledger(w: string, prompt: string) {
  const allocs = q(
    "SELECT task_id, amount_locked FROM relay_allocations WHERE motebit_id = ?",
    w,
  ) as { task_id: string; amount_locked: number }[];
  let unfunded = 0;
  let debitedTotal = 0;
  let lockedTotal = 0;
  for (const a of allocs) {
    const debited = -(
      q(
        "SELECT COALESCE(SUM(amount), 0) AS t FROM relay_transactions WHERE type = 'allocation_hold' AND reference_id = ?",
        `x402-${a.task_id}`,
      )[0] as { t: number }
    ).t;
    debitedTotal += debited;
    lockedTotal += a.amount_locked;
    if (a.amount_locked > debited) unfunded += 1;
  }
  return {
    tasks: q("SELECT task_id FROM relay_task_queue WHERE prompt = ?", prompt).length,
    allocation_rows: allocs.length,
    locked_gross: inGross(lockedTotal),
    debited_gross: inGross(debitedTotal),
    unfunded_holds: unfunded,
  };
}
const claimHeld = (key: string, w: string) =>
  q("SELECT 1 FROM relay_idempotency_keys WHERE idempotency_key = ? AND motebit_id = ?", key, w)
    .length > 0;

it("A: x402, raw ≥ price > spendable; then the same key paid again", async () => {
  const w = await worker(true);
  const d = await agent();
  hold(d, GROSS / 2, false);
  const prompt = "901-A";
  const key = crypto.randomUUID();
  const r1 = await submit(w, key, { prompt, submitted_by: d }, true);
  obs["A1_status"] = r1.status;
  const a1 = (await r1.json()) as { error?: string; payment_credited?: unknown };
  obs["A1_refusal_names_credit"] = a1.payment_credited != null;
  obs["A1_refusal_invites_repay"] = /pay via x402/.test(a1.error ?? "");
  obs["A1_ledger"] = ledger(w, prompt);
  obs["A1_key_held"] = claimHeld(key, w);
  const r2 = await submit(w, key, { prompt, submitted_by: d }, true);
  obs["A2_status"] = r2.status;
  obs["A2_ledger"] = ledger(w, prompt);
});

it("B: x402, held earnings net the risk buffer", async () => {
  const w = await worker(true);
  const d = await agent();
  hold(d, GROSS / 2, true);
  const r = await submit(w, crypto.randomUUID(), { prompt: "901-B", submitted_by: d }, true);
  obs["B_status"] = r.status;
  obs["B_ledger"] = ledger(w, "901-B");
});

it("C: relay-custody budget, the debit takes nothing; then the fault removed, same key", async () => {
  const w = await worker(false);
  seedBalance(relay, w, 5);
  const key = crypto.randomUUID();
  relay.moteDb.db.exec(
    `CREATE TRIGGER zz901_probe_ignore BEFORE UPDATE ON relay_accounts
     WHEN NEW.balance < OLD.balance BEGIN SELECT RAISE(IGNORE); END;`,
  );
  const r1 = await submit(w, key, { prompt: "901-C" });
  obs["C1_status"] = r1.status;
  obs["C1_ledger"] = ledger(w, "901-C");
  obs["C1_key_held"] = claimHeld(key, w);
  relay.moteDb.db.exec("DROP TRIGGER zz901_probe_ignore");
  const r2 = await submit(w, key, { prompt: "901-C" });
  obs["C2_status"] = r2.status;
  obs["C2_ledger"] = ledger(w, "901-C");
});

it("D: a balance that is entirely escrow-held, unpaid and then paid via x402", async () => {
  const w = await worker(true);
  const d = await agent();
  hold(d, 2 * GROSS, true);
  const r1 = await submit(w, crypto.randomUUID(), { prompt: "901-D", submitted_by: d });
  obs["D1_status"] = r1.status;
  obs["D1_body_error"] = ((await r1.json()) as { error?: string; code?: string }).code ?? "x402";
  const r2 = await submit(w, crypto.randomUUID(), { prompt: "901-D", submitted_by: d }, true);
  obs["D2_status"] = r2.status;
  obs["D2_ledger"] = ledger(w, "901-D");
});

// ── Round 2: the gate and the handler price a submission the same way ──────

async function listing(id: string, prices: Record<string, number>, payTo: string): Promise<void> {
  const caps = Object.keys(prices);
  await relay.app.request(`/api/v1/agents/${id}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: caps,
      pricing: caps.map((cap) => ({
        capability: cap,
        unit_cost: prices[cap],
        currency: "USD",
        per: "task",
      })),
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "901 r2 probe",
      pay_to_address: payTo,
    }),
  });
}
const PAY_T = "0x00000000000000000000000000000000000000b2";
const PAY_W = "0x00000000000000000000000000000000000000c3";
const payee = (a: string) =>
  a === PAY_T
    ? "target"
    : a === PAY_W
      ? "path"
      : a === X402_TEST_CONFIG.payToAddress
        ? "treasury"
        : "other";
const quotedGross = () =>
  x402.quoted.map((q) => ({ gross: inGross(Number(q.amount)), payee: payee(q.payTo) }));

it("R: reviewer's cell, real ordering — pinned self-delegation the account can fund, W's listing sums above T's capability", async () => {
  x402.settled = 0;
  x402.quoted = [];
  const t = await agent();
  await listing(t, { web_search: 1.0 }, PAY_T);
  const w = await agent();
  await listing(w, { web_search: 1.0, read_url: 1.0 }, PAY_W);
  hold(w, Math.round(1.1 * GROSS), true);
  creditAccount(relay.moteDb.db, w, Math.round(1.1 * GROSS), "deposit", null, "probe");
  const body = {
    prompt: "901-R",
    submitted_by: w,
    target_agent: t,
    required_capabilities: ["web_search"],
  };
  const r1 = await submit(w, crypto.randomUUID(), body);
  obs["R1_unpaid_status"] = r1.status;
  // A client told to pay does so (same body, a signed payment).
  const r2 = r1.status === 402 ? await submit(w, crypto.randomUUID(), body, true) : null;
  obs["R2_paid_status"] = r2?.status ?? "not-needed";
  obs["R_onchain_settlements"] = x402.settled;
  const debit = -(
    q(
      "SELECT COALESCE(SUM(amount), 0) AS t FROM relay_transactions WHERE motebit_id = ? AND type = 'allocation_hold'",
      w,
    )[0] as { t: number }
  ).t;
  obs["R_account_debited_gross"] = inGross(debit);
  obs["R_charged_twice"] = x402.settled > 0 && debit > 0;
});

it("U: x402 charge vs the handler's price — pinned capability ($1) above the path agent's listing ($0.50)", async () => {
  x402.settled = 0;
  x402.quoted = [];
  const t = await agent();
  await listing(t, { web_search: 1.0 }, PAY_T);
  const w = await agent();
  await listing(w, { web_search: 0.5 }, PAY_W);
  const body = {
    prompt: "901-U",
    submitted_by: w,
    target_agent: t,
    required_capabilities: ["web_search"],
  };
  const r = await submit(w, crypto.randomUUID(), body, true);
  obs["U_status"] = r.status;
  obs["U_quoted"] = quotedGross();
  const credited = (
    q(
      "SELECT COALESCE(SUM(amount), 0) AS t FROM relay_transactions WHERE motebit_id = ? AND type = 'deposit' AND reference_id LIKE 'x402-%'",
      w,
    )[0] as { t: number }
  ).t;
  obs["U_credited_gross"] = inGross(credited);
});

// ── Round 3: a target_agent that routes nothing must not price the task ─────

const queuedForW = (w: string) =>
  (q("SELECT COUNT(*) AS n FROM relay_task_queue WHERE worker_id = ?", w)[0] as { n: number }).n;

async function tCell(
  name: string,
  opts: { submittedBy: boolean; payTo: boolean; pay: boolean; target: "bogus" | "cheap" },
) {
  x402.settled = 0;
  x402.quoted = [];
  const w = await agent();
  await relay.app.request(`/api/v1/agents/${w}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: 1.0, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "901 r3 probe",
      ...(opts.payTo ? { pay_to_address: PAY_W } : {}),
    }),
  });
  let target = "no-such-agent";
  if (opts.target === "cheap") {
    target = await agent();
    await listing(target, { web_search: 0.01 }, PAY_T);
  }
  const d = await agent(); // broke
  const r = await submit(
    w,
    crypto.randomUUID(),
    {
      prompt: `901-${name}`,
      ...(opts.submittedBy ? { submitted_by: d } : {}),
      target_agent: target,
      required_capabilities: ["web_search"],
    },
    opts.pay,
  );
  obs[`${name}_status`] = r.status;
  obs[`${name}_tasks_for_W`] = queuedForW(w);
  obs[`${name}_quoted`] = quotedGross();
  obs[`${name}_onchain_settlements`] = x402.settled;
}

it("T1: unlisted target_agent on a $1 worker (payTo), broke delegator, no proof", async () => {
  await tCell("T1", { submittedBy: true, payTo: true, pay: false, target: "bogus" });
});
it("T1b: the same without submitted_by", async () => {
  await tCell("T1b", { submittedBy: false, payTo: true, pay: false, target: "bogus" });
});
it("T1c: the same on a $1 worker with no payTo", async () => {
  await tCell("T1c", { submittedBy: true, payTo: false, pay: false, target: "bogus" });
});
it("T2: a cheap target_agent on a $1 worker, paid via x402", async () => {
  await tCell("T2", { submittedBy: true, payTo: true, pay: true, target: "cheap" });
});
it('E: submitted_by "" and a null body', async () => {
  const w = await worker(true);
  const r1 = await submit(w, crypto.randomUUID(), { prompt: "901-E", submitted_by: "" });
  obs["E_empty_submitter_status"] = r1.status;
  const r2 = await relay.app.request(`/agent/${w}/task`, {
    method: "POST",
    headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
    body: "null",
  });
  obs["E_null_body_status"] = r2.status;
});
