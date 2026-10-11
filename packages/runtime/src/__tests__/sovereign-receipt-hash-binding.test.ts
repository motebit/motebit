/**
 * A sovereign payment receipt produced by the REAL runtime path
 * (payer `requestSovereignReceipt` → hub → payee
 * `handleSovereignReceiptRequest` → `signSovereignPaymentReceipt`) verifies
 * under strict hash binding: `result_hash` = hex(SHA-256(result)) of the
 * receipt's own `result` text, and the service's result hash the payer
 * supplied rides in `service_result_hash` (spec/settlement-v1.md §7).
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateKeypair, verifyReceipt } from "@motebit/encryption";

import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  InMemoryAgentTrustStore,
  InMemoryReceiptExchangeHub,
} from "../index.js";

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

async function makeRuntime(id: string, hub: InMemoryReceiptExchangeHub): Promise<MotebitRuntime> {
  const kp = await generateKeypair();
  const storage = createInMemoryStorage();
  return new MotebitRuntime(
    {
      motebitId: id,
      tickRateHz: 0,
      signingKeys: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      sovereignReceiptExchange: hub.adapterFor(id),
    },
    {
      storage: { ...storage, agentTrustStore: new InMemoryAgentTrustStore() },
      renderer: new NullRenderer(),
    },
  );
}

describe("sovereign payment receipt — runtime path binds result_hash", () => {
  let hub: InMemoryReceiptExchangeHub;
  beforeEach(() => {
    hub = new InMemoryReceiptExchangeHub();
  });
  afterEach(() => {
    hub.disconnect("alice");
    hub.disconnect("bob");
  });

  it("the payee-signed receipt verifies strict and carries service_result_hash", async () => {
    const alice = await makeRuntime("alice", hub);
    const bob = await makeRuntime("bob", hub);
    const serviceResult = "the research answer bob delivered to alice";
    const now = Date.now();
    const receipt = await alice.requestSovereignReceipt("bob", {
      payee_motebit_id: "bob",
      rail: "solana",
      tx_hash: "5JxYzPaymentFromAliceToBob",
      amount_micro: 5_000n,
      asset: "USDC",
      payee_address: bob.getSolanaAddress()!,
      service_description: "research query",
      prompt_hash: sha256Hex("alice's research question"),
      result_hash: sha256Hex(serviceResult),
      tools_used: ["web_search"],
      submitted_at: now - 2_000,
      completed_at: now,
    });

    expect(receipt.result_hash).toBe(sha256Hex(receipt.result));
    expect(receipt.service_result_hash).toBe(sha256Hex(serviceResult));
    const strict = await verifyReceipt(receipt, { strictHashBinding: true });
    expect(strict.errors).toBeUndefined();
    expect(strict.valid).toBe(true);
  });

  it("the payee declines to sign when the supplied result_hash is not a SHA-256 hex digest", async () => {
    const alice = await makeRuntime("alice", hub);
    const bob = await makeRuntime("bob", hub);
    await expect(
      alice.requestSovereignReceipt("bob", {
        payee_motebit_id: "bob",
        rail: "solana",
        tx_hash: "5JxYz",
        amount_micro: 5_000n,
        asset: "USDC",
        payee_address: bob.getSolanaAddress()!,
        service_description: "research query",
        prompt_hash: sha256Hex("q"),
        result_hash: "sha256:not-a-digest",
        tools_used: [],
        submitted_at: 1,
        completed_at: 2,
      }),
    ).rejects.toThrow(/service_result_hash|result_hash/);
  });
});
