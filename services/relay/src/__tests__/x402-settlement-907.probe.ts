/**
 * Differential probe for #907 / #925: whose settlement does a submission's
 * x402 branch read, and is a same-key replay ever charged?
 *
 * Unlike the #901 stand-in, this runs the REAL `@x402/hono` 2.22 middleware,
 * `x402ResourceServer` and `ExactEvmScheme` (eip3009 — the "authorization"
 * flow, which settles AFTER the handler and only on a < 400 response). Only the
 * facilitator's network round-trip is replaced: `createX402FacilitatorClient`
 * returns an in-process facilitator that accepts every payment and counts each
 * `settle` (an onchain transfer, in production). The client side builds the
 * payment the real way: it reads the `PAYMENT-REQUIRED` header of a 402 and
 * echoes the accepted requirements back in a `PAYMENT-SIGNATURE` header.
 *
 *   pnpm tsx scripts/differential-vs-main.ts \
 *     --probe services/relay/src/__tests__/x402-settlement-907.probe.ts --pkg services/relay
 *
 * Cells (observations are statuses, counts and amounts in units of the gross
 * price — never ids):
 *   own      a zero-balance self-delegation pays via x402
 *   leftover a paid same-key replay of an admitted task (#925), then a
 *            DIFFERENT principal's account-funded submission (#907: does it
 *            receive a deposit credit for the replay's payment?)
 *   replay   the same key after admission, unpaid
 *   refusal  a paid request the handler refuses 400
 *   payto    where the relay-custody x402 payment is sent (worker or treasury)
 */
import { it, beforeAll, afterAll, vi } from "vitest";
import { writeFileSync } from "node:fs";
// eslint-disable-next-line no-restricted-imports -- probe needs direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { computeGrossAmount } from "@motebit/market";
import { PLATFORM_FEE_RATE } from "@motebit/protocol";
import type { SyncRelay } from "../index.js";
import { createAgent, createTestRelay, JSON_AUTH, seedBalance } from "./test-helpers.js";
import { toMicro } from "../accounts.js";

const fac = vi.hoisted(() => ({
  settled: [] as { payer: string; amount: string; payTo: string; tx: string }[],
  /** "timeout": the transfer lands, then the settle answer is lost. "used": the authorization is already used/cancelled. */
  mode: "ok" as "ok" | "timeout" | "used",
  /** Authorizations the payer CANCELLED onchain (`${from}:${nonce}`): the state bit is set, nothing moved. */
  cancelled: new Set<string>(),
  /** Authorizations burned in one batch tx: `${from}:${nonce}` → the Used log's index. */
  batched: new Map<string, number>(),
  /** The batch tx's Transfer logs. */
  batchTransfers: [] as {
    token: string;
    from: string;
    to: string;
    value: bigint;
    logIndex: number;
  }[],
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
      verify: (p: { payload: { from?: string } }) =>
        Promise.resolve({ isValid: true, payer: p.payload.from ?? "0xpayer" }),
      settle: (p: { payload: { from?: string } }, req: { amount: string; payTo: string }) => {
        let tx = "0x";
        for (let i = 0; i < 64; i++) tx += "0123456789abcdef"[Math.floor(Math.random() * 16)];
        fac.settled.push({
          payer: p.payload.from ?? "0xpayer",
          amount: req.amount,
          payTo: req.payTo,
          tx,
        });
        if (fac.mode === "used") {
          fac.settled.pop();
          return Promise.resolve({
            success: false,
            errorReason: "invalid_exact_evm_nonce_already_used",
            transaction: "",
            network: "eip155:84532",
            payer: p.payload.from ?? "0xpayer",
          });
        }
        if (fac.mode === "timeout") return Promise.reject(new Error("fetch failed after /settle"));
        return Promise.resolve({
          success: true,
          transaction: tx,
          network: "eip155:84532",
          payer: p.payload.from ?? "0xpayer",
        });
      },
    }),
}));

const UNIT_COST = 1.0;
const GROSS = toMicro(computeGrossAmount(UNIT_COST, PLATFORM_FEE_RATE));
const WORKER_PAY_TO = "0x00000000000000000000000000000000000000a1";

/** The chain: this payer CANCELLED its authorization. */
const cancelledChain = {
  // round 2's port: the EIP-3009 state bit — true for a cancellation too.
  isAuthorizationUsed: (a: { authorizer: string; nonce: string }) =>
    Promise.resolve(fac.cancelled.has(`${a.authorizer.toLowerCase()}:${a.nonce.toLowerCase()}`)),
  // round 3's port: events.
  getConfirmedHead: () =>
    Promise.resolve({ number: 5_000, timestamp: Math.floor(Date.now() / 1000) }),
  getBlockTimestamp: (n: number) =>
    Promise.resolve(Math.floor(Date.now() / 1000) - (5_000 - n) * 2),
  getAuthorizationEvents: (a: { authorizer: string; nonce: string }) => {
    const k = `${a.authorizer.toLowerCase()}:${a.nonce.toLowerCase()}`;
    if (fac.cancelled.has(k)) {
      return Promise.resolve([
        { kind: "canceled", txHash: "0x" + "c".repeat(64), blockNumber: 4_990, logIndex: 1 },
      ]);
    }
    const i = fac.batched.get(k);
    if (i != null) {
      return Promise.resolve([
        { kind: "used", txHash: "0x" + "b".repeat(64), blockNumber: 4_991, logIndex: i },
      ]);
    }
    return Promise.resolve([]);
  },
  getTransfersInTransaction: (tx: string) =>
    Promise.resolve(tx === "0x" + "b".repeat(64) ? fac.batchTransfers : []),
};

let relay: SyncRelay;
const obs: Record<string, unknown> = {};

beforeAll(async () => {
  process.env["MOTEBIT_X402_RECONCILIATION_INTERVAL_MS"] = "40";
  relay = await createTestRelay({
    enableDeviceAuth: false,
    // Each tree reads the field it knows; the other is ignored.
    ...({ x402AuthorizationReader: cancelledChain, x402ChainReader: cancelledChain } as object),
  });
});
afterAll(async () => {
  await relay.close();
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
});

async function pricedSelf(): Promise<string> {
  const kp = await generateKeypair();
  const id = (await createAgent(relay, bytesToHex(kp.publicKey))).motebitId;
  await relay.app.request(`/api/v1/agents/${id}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: UNIT_COST, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "907 probe",
      pay_to_address: WORKER_PAY_TO,
    }),
  });
  return id;
}

const post = (agent: string, key: string, body: unknown, payment?: string) =>
  relay.app.request(`/agent/${agent}/task`, {
    method: "POST",
    headers: {
      ...JSON_AUTH,
      "Idempotency-Key": key,
      ...(payment != null ? { "PAYMENT-SIGNATURE": payment } : {}),
    },
    body: JSON.stringify(body),
  });

/** The real client step: read PAYMENT-REQUIRED from a 402, sign (echo) it. */
async function paymentFor(agent: string, body: unknown, payer: string): Promise<string | null> {
  const res = await post(agent, crypto.randomUUID(), body);
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (header == null) return null;
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
        from: payer,
        authorization: {
          from: "0x" + Buffer.from(String(payer)).toString("hex").padEnd(40, "0").slice(0, 40),
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

function x402Deposits(id: string): number {
  return (
    relay.moteDb.db
      .prepare(
        "SELECT COALESCE(SUM(amount), 0) AS s FROM relay_transactions WHERE motebit_id = ? AND type = 'deposit' AND reference_id LIKE 'x402-%'",
      )
      .get(id) as { s: number }
  ).s;
}
function tasks(prompt: string): number {
  return (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_task_queue WHERE prompt = ?")
      .get(prompt) as { n: number }
  ).n;
}
const units = (micro: number) => Math.round((micro / GROSS) * 1000) / 1000;

it("own: a zero-balance self-delegation pays via x402", async () => {
  const w = await pricedSelf();
  const prompt = `907 own ${crypto.randomUUID()}`;
  const body = { prompt, submitted_by: w };
  const before = fac.settled.length;
  const pay = await paymentFor(w, body, "0xpayer-own");
  const res = await post(w, crypto.randomUUID(), body, pay ?? undefined);
  obs["own.challenge_has_requirements"] = pay != null;
  obs["own.status"] = res.status;
  obs["own.settled"] = fac.settled.length - before;
  obs["own.credited_units"] = units(x402Deposits(w));
  obs["own.tasks"] = tasks(prompt);
});

it("payto: where the relay-custody x402 payment is sent", async () => {
  const w = await pricedSelf();
  const header = (
    await post(w, crypto.randomUUID(), { prompt: "907 payto", submitted_by: w })
  ).headers.get("PAYMENT-REQUIRED");
  const req = header
    ? (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
        accepts: { payTo: string; amount: string }[];
      })
    : null;
  const payTo = req?.accepts[0]?.payTo;
  obs["payto.destination"] =
    payTo == null ? "none" : payTo === WORKER_PAY_TO ? "worker" : "relay-treasury";
  obs["payto.amount_units"] = req ? units(Number(req.accepts[0]!.amount)) : null;
});

it("leftover: a paid same-key replay (#925), then a different principal's funded submission (#907)", async () => {
  // A: self-delegation funded from its account; the hold leaves spendable 0.
  const a = await pricedSelf();
  seedBalance(relay, a, (1.2 * GROSS) / 1_000_000);
  const promptA = `907 leftover A ${crypto.randomUUID()}`;
  const bodyA = { prompt: promptA, submitted_by: a };
  const keyA = crypto.randomUUID();
  const first = await post(a, keyA, bodyA);
  obs["leftover.a_first_status"] = first.status;
  const pay = await paymentFor(a, bodyA, "0xpayer-A");
  const before = fac.settled.length;
  const replay = await post(a, keyA, bodyA, pay ?? undefined);
  obs["leftover.a_paid_replay_status"] = replay.status;
  obs["leftover.a_paid_replay_settled"] = fac.settled.length - before;
  obs["leftover.a_tasks"] = tasks(promptA);
  obs["leftover.a_credited_units"] = units(x402Deposits(a));

  // B: a different principal, account-funded (no payment of its own).
  const b = await pricedSelf();
  seedBalance(relay, b, (2 * GROSS) / 1_000_000);
  const promptB = `907 leftover B ${crypto.randomUUID()}`;
  const resB = await post(b, crypto.randomUUID(), { prompt: promptB, submitted_by: b });
  obs["leftover.b_status"] = resB.status;
  obs["leftover.b_credited_from_a_payment_units"] = units(x402Deposits(b));
  const row = relay.moteDb.db
    .prepare("SELECT task_json FROM relay_task_queue WHERE prompt = ?")
    .get(promptB) as { task_json: string } | undefined;
  obs["leftover.b_task_carries_foreign_tx"] =
    row != null && fac.settled.some((s) => row.task_json.includes(s.tx));
});

it("replay: the same key after admission, unpaid", async () => {
  const w = await pricedSelf();
  seedBalance(relay, w, (1.2 * GROSS) / 1_000_000);
  const body = { prompt: `907 replay ${crypto.randomUUID()}`, submitted_by: w };
  const key = crypto.randomUUID();
  const first = await post(w, key, body);
  const again = await post(w, key, body);
  obs["replay.first_status"] = first.status;
  obs["replay.unpaid_status"] = again.status;
  obs["replay.same_task"] =
    first.status === 201 && again.status === 201
      ? ((await first.json()) as { task_id: string }).task_id ===
        ((await again.json()) as { task_id: string }).task_id
      : false;
});

it("refusal: a paid request the handler refuses 400", async () => {
  const w = await pricedSelf();
  const body = { prompt: `907 refusal ${crypto.randomUUID()}`, submitted_by: w };
  const pay = await paymentFor(w, body, "0xpayer-refusal");
  const before = fac.settled.length;
  const res = await post(
    w,
    crypto.randomUUID(),
    { ...body, invocation_origin: "bogus" },
    pay ?? undefined,
  );
  obs["refusal.status"] = res.status;
  obs["refusal.settled"] = fac.settled.length - before;
  obs["refusal.credited_units"] = units(x402Deposits(w));
});

it("concurrent: two principals pay at once — is each credited its own payment?", async () => {
  const p = await pricedSelf();
  const q = await pricedSelf();
  const bodyP = { prompt: `907 conc P ${crypto.randomUUID()}`, submitted_by: p };
  const bodyQ = { prompt: `907 conc Q ${crypto.randomUUID()}`, submitted_by: q };
  const payP = await paymentFor(p, bodyP, "0xpayer-P");
  const payQ = await paymentFor(q, bodyQ, "0xpayer-Q");
  const [rp, rq] = await Promise.all([
    post(p, crypto.randomUUID(), bodyP, payP ?? undefined),
    post(q, crypto.randomUUID(), bodyQ, payQ ?? undefined),
  ]);
  const ownTx = (prompt: string, payer: string): boolean => {
    const row = relay.moteDb.db
      .prepare("SELECT task_json FROM relay_task_queue WHERE prompt = ?")
      .get(prompt) as { task_json: string } | undefined;
    const tx = fac.settled.find((s) => s.payer === payer)?.tx;
    return row != null && tx != null && row.task_json.includes(tx);
  };
  obs["concurrent.statuses"] = [rp.status, rq.status];
  obs["concurrent.credited_units"] = [units(x402Deposits(p)), units(x402Deposits(q))];
  obs["concurrent.each_task_carries_own_tx"] = [
    ownTx(bodyP.prompt, "0xpayer-P"),
    ownTx(bodyQ.prompt, "0xpayer-Q"),
  ];
});

it("unknown: the transfer lands, the settle answer is lost; the client retries (same key, new payment) as the refusal told it", async () => {
  const w = await pricedSelf();
  const prompt = `907 unknown ${crypto.randomUUID()}`;
  const body = { prompt, submitted_by: w };
  const key = crypto.randomUUID();
  const pay = await paymentFor(w, body, "0xpayer-unknown");
  const before = fac.settled.length;
  fac.mode = "timeout";
  const res = await post(w, key, body, pay ?? undefined);
  fac.mode = "ok";
  const text = await res.text();
  obs["unknown.status"] = res.status;
  obs["unknown.says_not_charged_or_pay_again"] =
    /nothing was credited|Retry with a fresh payment|nothing was charged/.test(text);
  obs["unknown.says_do_not_pay_again"] = /Do NOT pay again/.test(text);
  const pay2 = await paymentFor(w, body, "0xpayer-unknown-2");
  const retry = await post(w, key, body, pay2 ?? undefined);
  obs["unknown.retry_status"] = retry.status;
  obs["unknown.onchain_charges"] = fac.settled.length - before;
  obs["unknown.credited_units"] = units(x402Deposits(w));
});

it("replay: the same signed payload on a new key", async () => {
  const w = await pricedSelf();
  const body = { prompt: `907 replay-new-key ${crypto.randomUUID()}`, submitted_by: w };
  const pay = await paymentFor(w, body, "0xpayer-replay");
  const before = fac.settled.length;
  const first = await post(w, crypto.randomUUID(), body, pay ?? undefined);
  const second = await post(
    w,
    crypto.randomUUID(),
    { ...body, prompt: `${body.prompt} again` },
    pay ?? undefined,
  );
  obs["replay_new_key.statuses"] = [first.status, second.status];
  obs["replay_new_key.onchain_charges"] = fac.settled.length - before;
  obs["replay_new_key.credited_units"] = units(x402Deposits(w));
});

it("cancel: the payer cancels its authorization between verify and settle; the reconciler runs", async () => {
  const w = await pricedSelf();
  const body = { prompt: `907 cancel ${crypto.randomUUID()}`, submitted_by: w };
  const pay = await paymentFor(w, body, "0xpayer-cancel");
  const auth = (
    JSON.parse(Buffer.from(pay!, "base64").toString("utf8")) as {
      payload: { authorization: { from: string; nonce: string } };
    }
  ).payload.authorization;
  fac.cancelled.add(`${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`);
  const before = fac.settled.length;
  fac.mode = "used";
  const res = await post(w, crypto.randomUUID(), body, pay ?? undefined);
  fac.mode = "ok";
  obs["cancel.status"] = res.status;
  await new Promise((r) => setTimeout(r, 400)); // several reconciliation ticks
  obs["cancel.onchain_transfers"] = fac.settled.length - before;
  obs["cancel.credited_units"] = units(x402Deposits(w));
});

it("batch: N pending nonces burned to self for 1 in one tx, plus ONE Transfer of the gross to the treasury", async () => {
  const w = await pricedSelf();
  const auths: { from: string; nonce: string; to: string; asset: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const body = { prompt: `907 batch ${i} ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xpayer-batch");
    const p = JSON.parse(Buffer.from(pay!, "base64").toString("utf8")) as {
      accepted: { asset: string };
      payload: { authorization: { from: string; nonce: string; to: string } };
    };
    auths.push({ ...p.payload.authorization, asset: p.accepted.asset });
    fac.mode = "used"; // the settle finds the nonce burned: nonce_already_used (unknown)
    await post(w, crypto.randomUUID(), body, pay ?? undefined);
    fac.mode = "ok";
  }
  // The batch tx: each Used log paired with a self-transfer of 1, then one gross transfer.
  let li = 10;
  for (const a of auths) {
    const from = a.from.toLowerCase();
    fac.batched.set(`${from}:${a.nonce.toLowerCase()}`, li);
    fac.batchTransfers.push({
      token: a.asset.toLowerCase(),
      from,
      to: from,
      value: 1n,
      logIndex: li + 1,
    });
    li += 2;
  }
  fac.batchTransfers.push({
    token: auths[0]!.asset.toLowerCase(),
    from: auths[0]!.from.toLowerCase(),
    to: auths[0]!.to.toLowerCase(),
    value: BigInt(GROSS),
    logIndex: li,
  });
  await new Promise((r) => setTimeout(r, 500)); // reconciliation ticks
  obs["batch.received_units"] = 1;
  obs["batch.credited_units"] = units(x402Deposits(w));
});
