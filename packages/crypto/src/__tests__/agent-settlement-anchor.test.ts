import { describe, it, expect } from "vitest";

import {
  AGENT_SETTLEMENT_ANCHOR_SUITE,
  computeAgentSettlementLeaf,
  verifyAgentSettlementAnchor,
  type AgentSettlementAnchorProofFields,
} from "../agent-settlement-anchor.js";
import {
  generateKeypair,
  signBySuite,
  canonicalJson,
  bytesToHex,
  type KeyPair,
} from "../signing.js";

// A full signed SettlementRecord (the bytes a worker holds), with x402 fields
// present to prove optional keys are anchored verbatim.
const RECORD: Record<string, unknown> = {
  settlement_id: "settle-1",
  allocation_id: "alloc-1",
  motebit_id: "payee-1",
  receipt_hash: "a".repeat(64),
  ledger_hash: null,
  amount_settled: 950_000,
  platform_fee: 50_000,
  platform_fee_rate: 0.05,
  settlement_mode: "p2p",
  x402_tx_hash: "0xabc",
  x402_network: "eip155:8453",
  status: "completed",
  settled_at: 1_700_000_000_000,
  issuer_relay_id: "relay-1",
  suite: "motebit-jcs-ed25519-b64-v1",
  signature: "Zm9vYmFy",
};

/**
 * Build a valid single-leaf anchor proof for `record`, signed by `kp`. A
 * one-leaf Merkle tree has root == leaf and an empty sibling path — the
 * minimal shape that exercises every verifier step (hash, merkle, batch sig)
 * without standing up the relay producer.
 */
async function makeProof(
  record: Record<string, unknown>,
  kp: KeyPair,
): Promise<AgentSettlementAnchorProofFields> {
  const leaf = await computeAgentSettlementLeaf(record);
  const batchPayload = {
    batch_id: "batch-1",
    merkle_root: leaf,
    leaf_count: 1,
    first_settled_at: 1,
    last_settled_at: 1,
    relay_id: "relay-1",
    suite: AGENT_SETTLEMENT_ANCHOR_SUITE,
  };
  const sig = await signBySuite(
    AGENT_SETTLEMENT_ANCHOR_SUITE,
    new TextEncoder().encode(canonicalJson(batchPayload)),
    kp.privateKey,
  );
  return {
    settlement_hash: leaf,
    batch_id: "batch-1",
    merkle_root: leaf,
    leaf_count: 1,
    first_settled_at: 1,
    last_settled_at: 1,
    leaf_index: 0,
    siblings: [],
    layer_sizes: [1],
    relay_id: "relay-1",
    relay_public_key: bytesToHex(kp.publicKey),
    suite: AGENT_SETTLEMENT_ANCHOR_SUITE,
    batch_signature: bytesToHex(sig),
    anchor: null,
  };
}

describe("computeAgentSettlementLeaf", () => {
  it("is deterministic and a 64-hex SHA-256", async () => {
    const a = await computeAgentSettlementLeaf(RECORD);
    const b = await computeAgentSettlementLeaf({ ...RECORD });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any field changes (verbatim commitment)", async () => {
    const base = await computeAgentSettlementLeaf(RECORD);
    expect(await computeAgentSettlementLeaf({ ...RECORD, amount_settled: 1 })).not.toBe(base);
    // Optional fields are part of the commitment — dropping x402 changes the leaf.
    const { x402_tx_hash, ...withoutX402 } = RECORD;
    void x402_tx_hash;
    expect(await computeAgentSettlementLeaf(withoutX402)).not.toBe(base);
  });
});

describe("verifyAgentSettlementAnchor", () => {
  it("verifies a valid single-leaf proof with all steps passing", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(RECORD, kp);
    const r = await verifyAgentSettlementAnchor(RECORD, proof);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.steps.hash_valid).toBe(true);
    expect(r.steps.merkle_valid).toBe(true);
    expect(r.steps.relay_signature_valid).toBe(true);
    expect(r.steps.chain_verified).toBeNull();
  });

  it("rejects a record tampered after signing (hash step fails)", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(RECORD, kp);
    const r = await verifyAgentSettlementAnchor({ ...RECORD, amount_settled: 999_999_999 }, proof);
    expect(r.valid).toBe(false);
    expect(r.steps.hash_valid).toBe(false);
  });

  it("rejects a batch signed by a different key (relay signature fails)", async () => {
    const kp = await generateKeypair();
    const impostor = await generateKeypair();
    const proof = await makeProof(RECORD, kp);
    proof.relay_public_key = bytesToHex(impostor.publicKey);
    const r = await verifyAgentSettlementAnchor(RECORD, proof);
    expect(r.valid).toBe(false);
    expect(r.steps.relay_signature_valid).toBe(false);
  });

  it("rejects an unknown suite fail-closed", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(RECORD, kp);
    const r = await verifyAgentSettlementAnchor(RECORD, {
      ...proof,
      suite: "bogus-suite" as never,
    });
    expect(r.valid).toBe(false);
    expect(r.steps.relay_signature_valid).toBe(false);
  });
});
