/**
 * No pay-to destination keeps pointing at a retired key.
 *
 * A worker's settlement address is, by default, its identity key's Solana
 * address. A recorded rotation used to move `agent_registry.public_key` and
 * leave `settlement_address` on the RETIRED key's address, so the P2P
 * submission gate (`proof.to_address === settlement_address`) kept demanding
 * — and delegators kept paying — the address of a key the worker's surfaces
 * had just erased.
 *
 * The rule: a destination that is derived-bound to the key being retired
 * (`isDerivedSettlementBinding(addr, old_key)`) moves to the new key's derived
 * address in the SAME transaction as the key itself. A custom address (the
 * agent's own choice of payout wallet) is not the key's and is left alone.
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

async function worker(
  settlementAddressOf: (a: KeyPair) => string,
): Promise<{ mid: string; a: KeyPair }> {
  const a = await generateKeypair();
  const { motebitId } = await createAgent(relay, hex(a));
  const address = settlementAddressOf(a);
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      settlement_address: address,
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
      description: "succession settlement-address worker",
      pay_to_address: address,
    }),
  });
  // The key the registry holds is the identity's current key.
  relay.moteDb.db
    .prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?")
    .run(hex(a), motebitId);
  expect(registry(motebitId).settlement_address).toBe(address);
  return { mid: motebitId, a };
}

const registry = (mid: string) =>
  relay.moteDb.db
    .prepare("SELECT public_key, settlement_address FROM agent_registry WHERE motebit_id = ?")
    .get(mid) as { public_key: string; settlement_address: string | null };
const listingPayTo = (mid: string) =>
  (
    relay.moteDb.db
      .prepare("SELECT pay_to_address FROM relay_service_listings WHERE motebit_id = ?")
      .get(mid) as { pay_to_address: string | null } | undefined
  )?.pay_to_address;

async function rotate(mid: string, a: KeyPair): Promise<KeyPair> {
  const b = await generateKeypair();
  const record = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
  applySuccession(relay.moteDb.db, mid, record, () => {});
  expect(registry(mid).public_key).toBe(hex(b));
  return b;
}

async function submitP2p(
  workerId: string,
  toAddress: string,
): Promise<{ status: number; code?: string }> {
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
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  return { status: res.status, ...(body.code !== undefined ? { code: body.code } : {}) };
}

describe("applied succession moves a derived-bound pay-to destination with the key", () => {
  it("a settlement_address derived from the OLD key now equals the NEW key's derived address", async () => {
    const { mid, a } = await worker((k) => deriveSolanaAddress(k.publicKey));
    const b = await rotate(mid, a);
    expect(registry(mid).settlement_address).toBe(deriveSolanaAddress(b.publicKey));
    expect(listingPayTo(mid)).toBe(deriveSolanaAddress(b.publicKey));
  });

  it("a custom (non-derived) settlement_address is left untouched", async () => {
    const { mid, a } = await worker(() => CUSTOM_ADDR);
    await rotate(mid, a);
    expect(registry(mid).settlement_address).toBe(CUSTOM_ADDR);
    expect(listingPayTo(mid)).toBe(CUSTOM_ADDR);
  });

  it("after the rotation, a P2P proof to the NEW derived address is accepted and to the OLD one refused", async () => {
    const { mid, a } = await worker((k) => deriveSolanaAddress(k.publicKey));
    const b = await rotate(mid, a);
    const toNew = await submitP2p(mid, deriveSolanaAddress(b.publicKey));
    expect(toNew.status).toBe(201);
    const toOld = await submitP2p(mid, deriveSolanaAddress(a.publicKey));
    expect(toOld).toMatchObject({ status: 400, code: "TASK_P2P_ADDRESS_MISMATCH" });
  });
});
