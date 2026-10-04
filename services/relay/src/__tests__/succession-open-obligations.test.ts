/**
 * A rotation never silently strands an obligation the relay holds to the
 * retired key's address.
 *
 * Moving a derived `settlement_address` with the key (succession-settlement-
 * address.test.ts) covers FUTURE payments. Obligations already admitted were
 * not covered: a `pending` / `processing` (or freeze-held) withdrawal whose
 * destination is the old derived address keeps that destination and can
 * later pay out to the retired key (admin `/complete`, a payout held during
 * a freeze), and a P2P task admitted before the rotation keeps its admitted
 * `worker_address`, which `paysWorker` still accepts.
 *
 * The relay NEVER rewrites either destination (that would be the relay
 * creating destination authority — docs/doctrine/settlement-authority-
 * binding.md). Instead it REPORTS them: an authenticated read the client
 * preflight calls before rotating, and the same list returned (and logged)
 * by `applySuccession`, so no door records a rotation over them silently.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { applySuccession } from "../succession-apply.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex, signKeySuccession } from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import { deriveSolanaAddress } from "@motebit/wallet-solana";
import {
  createTestRelay,
  createAgent,
  buildP2pPaymentProof,
  JSON_AUTH,
  AUTH_HEADER,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";

const CUSTOM_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay;
beforeEach(async () => {
  relay = await createTestRelay({ enableDeviceAuth: false });
});
afterEach(async () => {
  await relay.close();
});

/** A P2P-capable worker whose settlement address is its key's derived address. */
async function worker(): Promise<{ mid: string; a: KeyPair; oldAddress: string }> {
  const a = await generateKeypair();
  const { motebitId } = await createAgent(relay, hex(a));
  const oldAddress = deriveSolanaAddress(a.publicKey);
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      settlement_address: oldAddress,
      settlement_modes: "relay,p2p",
    }),
  });
  await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: 1.0, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "open-obligations worker",
      pay_to_address: oldAddress,
    }),
  });
  relay.moteDb.db
    .prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?")
    .run(hex(a), motebitId);
  return { mid: motebitId, a, oldAddress };
}

function withdrawal(
  mid: string,
  id: string,
  status: string,
  destination: string,
  amount = 5_000_000,
) {
  relay.moteDb.db
    .prepare(
      "INSERT INTO relay_withdrawals (withdrawal_id, motebit_id, amount, currency, destination, status, requested_at) VALUES (?, ?, ?, 'USD', ?, ?, ?)",
    )
    .run(id, mid, amount, destination, status, Date.now());
}

const withdrawalDestination = (id: string) =>
  (
    relay.moteDb.db
      .prepare("SELECT destination FROM relay_withdrawals WHERE withdrawal_id = ?")
      .get(id) as { destination: string }
  ).destination;

/** Admit a P2P task paying `toAddress` (before any rotation). Returns its task id. */
async function admitP2p(workerId: string, toAddress: string): Promise<string> {
  const delegatorKp = await generateKeypair();
  const delegator = await createAgent(relay, hex(delegatorKp));
  const res = await relay.app.request(`/agent/${workerId}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({
      prompt: "do work",
      submitted_by: delegator.motebitId,
      target_agent: workerId,
      required_capabilities: ["web_search"],
      delegator_acknowledges_no_history_risk: true,
      payment_proof: buildP2pPaymentProof(relay, {
        workerAddress: toAddress,
        unitCostMicro: 1_000_000,
      }),
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { task_id: string };
  return body.task_id;
}

const admittedWorkerAddress = (taskId: string) =>
  (
    relay.moteDb.db
      .prepare(
        "SELECT json_extract(task_json, '$.p2p_admission.worker_address') AS a FROM relay_task_queue WHERE task_id = ?",
      )
      .get(taskId) as { a: string | null }
  ).a;

async function readObligations(mid: string, from: string) {
  const res = await relay.app.request(`/api/v1/agents/${mid}/rotation-obligations?from=${from}`, {
    headers: AUTH_HEADER,
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as {
      address?: string;
      obligations?: Record<string, unknown>[];
    } | null,
  };
}

async function rotate(mid: string, a: KeyPair) {
  const b = await generateKeypair();
  const record = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
  const result = applySuccession(relay.moteDb.db, mid, record, () => {});
  return { b, result: result as typeof result & { open_obligations?: Record<string, unknown>[] } };
}

const CASES: {
  name: string;
  seed: (w: { mid: string; oldAddress: string }) => Promise<{ id: string; kind: string }>;
  stillPaysOld: (id: string) => string | null;
}[] = [
  {
    name: "(a) a PENDING withdrawal to the old derived address",
    seed: async ({ mid, oldAddress }) => {
      withdrawal(mid, "wd-pending", "pending", oldAddress);
      return { id: "wd-pending", kind: "withdrawal" };
    },
    stillPaysOld: withdrawalDestination,
  },
  {
    name: "(b) a PROCESSING (or freeze-held) withdrawal to the old derived address",
    seed: async ({ mid, oldAddress }) => {
      withdrawal(mid, "wd-processing", "processing", oldAddress);
      return { id: "wd-processing", kind: "withdrawal" };
    },
    stillPaysOld: withdrawalDestination,
  },
  {
    name: "(c) an admitted, not-yet-verified P2P task paying the old derived address",
    seed: async ({ mid, oldAddress }) => ({
      id: await admitP2p(mid, oldAddress),
      kind: "p2p_task",
    }),
    stillPaysOld: admittedWorkerAddress,
  },
];

describe("open relay obligations to the retired key's address", () => {
  for (const c of CASES) {
    it(`${c.name}: reported by the authenticated read the preflight calls`, async () => {
      const w = await worker();
      const seeded = await c.seed(w);
      const { status, body } = await readObligations(w.mid, hex(w.a));
      expect(status).toBe(200);
      expect(body?.address).toBe(w.oldAddress);
      const ids = (body?.obligations ?? []).map((o) => o["withdrawal_id"] ?? o["task_id"]);
      expect(ids).toEqual([seeded.id]);
      expect(body?.obligations?.[0]?.["kind"]).toBe(seeded.kind);
    });

    it(`${c.name}: applySuccession returns it and NEVER rewrites the destination`, async () => {
      const w = await worker();
      const seeded = await c.seed(w);
      const { b, result } = await rotate(w.mid, w.a);
      expect(result.applied).toBe(true);
      const ids = (result.open_obligations ?? []).map((o) => o["withdrawal_id"] ?? o["task_id"]);
      expect(ids).toEqual([seeded.id]);
      // The relay does not create destination authority: the obligation
      // still names the address its owner chose, never the new key's.
      expect(c.stillPaysOld(seeded.id)).toBe(w.oldAddress);
      expect(c.stillPaysOld(seeded.id)).not.toBe(deriveSolanaAddress(b.publicKey));
    });
  }

  it("settled or other-destination obligations are not reported; an empty identity reads empty", async () => {
    const w = await worker();
    withdrawal(w.mid, "wd-done", "completed", w.oldAddress);
    withdrawal(w.mid, "wd-failed", "failed", w.oldAddress);
    withdrawal(w.mid, "wd-custom", "pending", CUSTOM_ADDR);
    const { status, body } = await readObligations(w.mid, hex(w.a));
    expect(status).toBe(200);
    expect(body?.obligations).toEqual([]);
    const { result } = await rotate(w.mid, w.a);
    expect(result.open_obligations).toEqual([]);
  });

  it("refuses a `from` that is not a 32-byte hex key", async () => {
    const w = await worker();
    const { status } = await readObligations(w.mid, "not-a-key");
    expect(status).toBe(400);
  });
});
