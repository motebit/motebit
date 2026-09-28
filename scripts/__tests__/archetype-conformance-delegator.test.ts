/**
 * The conformance probe's paid leg is made by a CONFORMING sovereign client.
 *
 * Regression cover for staging run 36474395502 (2026-09-28): the Auditor and
 * Clerk legs went red with
 *
 *   payment_not_admitted … unauthorized: This payment proof's transaction was
 *   not paid from the submitter's identity-derived wallet — only the payer may
 *   submit it
 *
 * The probe paid from the wallet `DELEGATOR_SEED_HEX` derives, but submitted
 * with the relay operator's MASTER token naming `DELEGATOR_MOTEBIT_ID` — an
 * identity whose key was not that seed's key. #955's law (a P2P proof is
 * admissible only from the submitter's identity-derived wallet) refused it,
 * correctly: the probe was non-conforming and had passed only because nothing
 * checked. Two devnet payments were spent on proofs the relay could never
 * admit.
 *
 * These tests drive the probe's REAL paid-leg function (`submitPaidDelegation`
 * → `resolveAndSubmitP2pDelegation`, the CLI's sovereign path) against the
 * REAL relay (in-process harness, #918's strict fake chain: a tx is paid by
 * exactly the address registered for it). The first reproduces the red with
 * the old shape; the second proves the fixed probe is admitted, as itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../../services/relay/src/index.js";
import {
  createTestRelay,
  createAgent,
  buildP2pPaymentProof,
  createFakePaymentChain,
  walletOf,
  JSON_AUTH,
  API_TOKEN,
  type FakePaymentChain,
} from "../../services/relay/src/__tests__/test-helpers.js";
import { resolveAndSubmitP2pDelegation } from "@motebit/runtime";
import {
  deriveProbeDelegator,
  declaredIdMismatch,
  parseSeedHex,
  probeTokenMinter,
} from "../lib/probe-delegator.js";
import {
  deriveSovereignMotebitId,
  generateKeypair,
  bytesToHex,
  verifySignedToken,
} from "../../packages/crypto/src/index.js";
import { submitPaidDelegation, type PaidLegRail } from "../archetype-conformance.js";

/** A fixed test seed — never a real wallet's. */
const SEED_HEX = "5eed".repeat(16);
const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

let relay: SyncRelay;
let chain: FakePaymentChain;
let relayUrl: string;

beforeEach(async () => {
  chain = createFakePaymentChain("absent");
  relay = await createTestRelay({ p2pPaymentChain: chain });
  // A distinct origin per test: the probe memoizes its bootstrap per relay.
  relayUrl = `http://relay-${crypto.randomUUID()}.test`;
  // The delegation client speaks global fetch; route it into the in-process
  // relay so the wire bytes are the real client's and the real relay's.
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.origin !== relayUrl) throw new Error(`unexpected fetch to ${url.origin}`);
    return relay.app.request(url.pathname + url.search, init);
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await relay.close();
});

/** A priced local worker advertising P2P, with an open socket. */
async function pricedWorker(): Promise<{ motebitId: string; dispatched: () => number }> {
  const kp = await generateKeypair();
  const worker = await createAgent(relay, bytesToHex(kp.publicKey));
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: worker.motebitId,
      endpoint_url: "http://127.0.0.1:18999/mcp",
      capabilities: ["audit_agent"],
      settlement_address: WORKER_SOLANA_ADDR,
      settlement_modes: "relay,p2p",
    }),
  });
  await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["audit_agent"],
      pricing: [{ capability: "audit_agent", unit_cost: 0.01, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "conformance-probe test worker",
      pay_to_address: WORKER_SOLANA_ADDR,
    }),
  });
  const ws = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  relay.connections.set(worker.motebitId, [
    { ws: ws as never, deviceId: worker.deviceId, capabilities: ["audit_agent"] },
  ]);
  return {
    motebitId: worker.motebitId,
    dispatched: () =>
      ws.send.mock.calls.filter(
        (c) => (JSON.parse(String(c[0])) as { type: string }).type === "task_request",
      ).length,
  };
}

/**
 * A rail that "pays" exactly the requested legs from `payerAddress`, landing
 * the tx on the fake chain as paid by that address — the seed's wallet, as
 * the real devnet rail does.
 */
function fakeRail(payerAddress: string): PaidLegRail & { paid: string[] } {
  const paid: string[] = [];
  return {
    address: payerAddress,
    paid,
    async buildP2pPayment(req) {
      const base = buildP2pPaymentProof(relay, {
        workerAddress: req.workerAddress,
        unitCostMicro: req.amountMicro,
      });
      const proof = {
        ...base,
        amount_micro: req.amountMicro,
        fee_to_address: req.treasuryAddress,
        fee_amount_micro: req.feeAmountMicro,
      };
      chain.pay(proof.tx_hash, payerAddress);
      paid.push(proof.tx_hash);
      return proof;
    },
  } as PaidLegRail & { paid: string[] };
}

function claimOf(txHash: string) {
  return relay.moteDb.db
    .prepare(
      "SELECT submitted_by, submitter_verified FROM relay_p2p_proof_claims WHERE tx_hash = ?",
    )
    .get(txHash) as { submitted_by: string; submitter_verified: number } | undefined;
}

const quietLogger = { warn: () => {} };

describe("probe delegator identity — one seed, every role", () => {
  it("derives the sovereign id from the seed's genesis key, deterministically", async () => {
    const a = await deriveProbeDelegator(SEED_HEX);
    const b = await deriveProbeDelegator(`0x${SEED_HEX.toUpperCase()}`);
    expect(a.motebitId).toBe(b.motebitId);
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
    expect(a.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(a.motebitId).toBe(await deriveSovereignMotebitId(a.publicKeyHex));
    expect(a.deviceId).toBe(`${a.motebitId}-conformance-probe`);
  });

  it("refuses a malformed seed without echoing it", () => {
    const secretish = "ab".repeat(20);
    expect(() => parseSeedHex(secretish)).toThrow(/64 hex chars/);
    try {
      parseSeedHex(secretish);
    } catch (err) {
      expect(String(err)).not.toContain(secretish);
    }
  });

  it("mints audience-bound tokens that verify under the identity key", async () => {
    const d = await deriveProbeDelegator(SEED_HEX);
    const token = await probeTokenMinter(d)("task:submit");
    const claims = await verifySignedToken(token, d.publicKey);
    expect(claims).toMatchObject({ mid: d.motebitId, did: d.deviceId, aud: "task:submit" });
  });

  it("reports a declared DELEGATOR_MOTEBIT_ID that is not the seed's identity", async () => {
    const d = await deriveProbeDelegator(SEED_HEX);
    expect(declaredIdMismatch(undefined, d)).toBeNull();
    expect(declaredIdMismatch(d.motebitId, d)).toBeNull();
    expect(declaredIdMismatch("019d0000-0000-7000-8000-000000000000", d)).toMatch(
      /remove the DELEGATOR_MOTEBIT_ID setting/,
    );
  });
});

describe("the probe's paid leg against the real relay (#955 payer rule)", () => {
  it("REPRODUCES the 2026-09-28 red: master token naming another identity, paid from the seed's wallet ⇒ refused as not the payer", async () => {
    const d = await deriveProbeDelegator(SEED_HEX);
    const worker = await pricedWorker();
    // The old probe's shape: an operator-asserted identity whose key is NOT the seed's.
    const other = await generateKeypair();
    const declared = await createAgent(relay, bytesToHex(other.publicKey));
    const rail = fakeRail(walletOf(d.publicKeyHex));

    const result = await resolveAndSubmitP2pDelegation({
      motebitId: declared.motebitId,
      syncUrl: relayUrl,
      authToken: async () => API_TOKEN,
      prompt: "old-shape probe",
      capability: "audit_agent",
      targetWorkerId: worker.motebitId,
      relayPublicKeyHex: relay.relayIdentity.publicKeyHex,
      buildP2pPayment: (req) => rail.buildP2pPayment(req),
      acknowledgeNoHistoryRisk: true,
      timeoutMs: 3000,
      logger: quietLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("payment_not_admitted");
    expect(result.error.message).toMatch(/submitter's identity-derived wallet/);
    expect(rail.paid, "the money moved anyway — why the probe must conform").toHaveLength(1);
    expect(claimOf(rail.paid[0]!)).toBeUndefined();
    expect(worker.dispatched()).toBe(0);
  });

  it("the fixed probe is admitted AS ITSELF: bootstrapped sovereign id, signed token, proof bound to the verified submitter, one dispatch", async () => {
    const d = await deriveProbeDelegator(SEED_HEX);
    const worker = await pricedWorker();
    const rail = fakeRail(walletOf(d.publicKeyHex));

    const result = await submitPaidDelegation({
      relayUrl,
      seedHex: SEED_HEX,
      rail,
      relayPublicKeyHex: relay.relayIdentity.publicKeyHex,
      workerId: worker.motebitId,
      capability: "audit_agent",
      prompt: "conforming probe",
      // Admission is what is under test; the worker never answers, so the
      // client's wait ends in a timeout AFTER the relay admitted the task.
      timeoutMs: 1500,
      logger: quietLogger,
    });

    if (!result.ok) {
      expect(result.error.code, result.error.message).not.toBe("payment_not_admitted");
    }
    expect(rail.paid).toHaveLength(1);
    expect(
      claimOf(rail.paid[0]!),
      "bound to the seed's sovereign id, PROVEN by its signed token",
    ).toEqual({ submitted_by: d.motebitId, submitter_verified: 1 });
    expect(worker.dispatched()).toBe(1);
  }, 30_000);

  it("refuses to pay at all when the rail is not the identity's wallet", async () => {
    const worker = await pricedWorker();
    const rail = fakeRail(WORKER_SOLANA_ADDR); // any address the seed does not derive

    await expect(
      submitPaidDelegation({
        relayUrl,
        seedHex: SEED_HEX,
        rail,
        relayPublicKeyHex: relay.relayIdentity.publicKeyHex,
        workerId: worker.motebitId,
        capability: "audit_agent",
        prompt: "wrong wallet",
        timeoutMs: 1500,
        logger: quietLogger,
      }),
    ).rejects.toThrow(/identity-derived wallet/);
    expect(rail.paid, "nothing broadcast").toHaveLength(0);
  });
});
