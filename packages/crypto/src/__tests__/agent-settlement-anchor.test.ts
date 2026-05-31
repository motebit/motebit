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
  hexToBytes,
  sha256,
  type KeyPair,
} from "../signing.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

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

  it("fails the Merkle step when the proof does not reconstruct to the claimed root", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(RECORD, kp);
    proof.merkle_root = "f".repeat(64); // leaf no longer reconstructs to this root
    const r = await verifyAgentSettlementAnchor(RECORD, proof);
    expect(r.valid).toBe(false);
    expect(r.steps.merkle_valid).toBe(false);
  });

  const ANCHOR = {
    chain: "eip155",
    network: "eip155:8453",
    tx_hash: "0xdeadbeef",
    anchored_at: 1_700_000_000_000,
  };

  it("runs the optional onchain step and passes when the chain verifier confirms the root", async () => {
    const kp = await generateKeypair();
    const proof = { ...(await makeProof(RECORD, kp)), anchor: ANCHOR };
    const r = await verifyAgentSettlementAnchor(RECORD, proof, async (a) => {
      // The verifier is handed the proof's anchor plus the expected root.
      expect(a.expected_root).toBe(proof.merkle_root);
      return true;
    });
    expect(r.valid).toBe(true);
    expect(r.steps.chain_verified).toBe(true);
  });

  it("fails when the chain verifier reports the root is not anchored", async () => {
    const kp = await generateKeypair();
    const proof = { ...(await makeProof(RECORD, kp)), anchor: ANCHOR };
    const r = await verifyAgentSettlementAnchor(RECORD, proof, async () => false);
    expect(r.valid).toBe(false);
    expect(r.steps.chain_verified).toBe(false);
    expect(r.errors.some((e) => /onchain anchor verification failed/i.test(e))).toBe(true);
  });

  it("fails closed when the chain verifier throws", async () => {
    const kp = await generateKeypair();
    const proof = { ...(await makeProof(RECORD, kp)), anchor: ANCHOR };
    const r = await verifyAgentSettlementAnchor(RECORD, proof, async () => {
      throw new Error("rpc unreachable");
    });
    expect(r.valid).toBe(false);
    expect(r.steps.chain_verified).toBe(false);
    expect(r.errors.some((e) => /onchain verification error/i.test(e))).toBe(true);
  });
});

// A second record so the v2 tree below has a real interior node (the node tag
// is only exercised when ≥2 leaves combine).
const SIBLING: Record<string, unknown> = { ...RECORD, settlement_id: "settle-2" };

/**
 * Build a valid 2-leaf RFC-6962-v2 proof for `record` (at index 0, sibling
 * `sibling`), signed by `kp`. The leaves are leaf-tagged (0x00) and the root is
 * the node-tagged combine `SHA-256(0x01 ‖ leafA ‖ leafB)` — so the proof
 * exercises BOTH domain tags through the high-level verifier, end to end. No v2
 * producer ships yet (PR2); this constructs the v2 proof by hand to prove the
 * dormant 2b plumbing threads the version correctly.
 */
async function makeV2Proof(
  record: Record<string, unknown>,
  sibling: Record<string, unknown>,
  kp: KeyPair,
): Promise<AgentSettlementAnchorProofFields> {
  const V2 = "merkle-sha256-rfc6962-v2" as const;
  const leafA = await computeAgentSettlementLeaf(record, V2);
  const leafB = await computeAgentSettlementLeaf(sibling, V2);
  const combined = new Uint8Array([0x01, ...hexToBytes(leafA), ...hexToBytes(leafB)]);
  const root = bytesToHex(await sha256(combined));
  const batchPayload = {
    batch_id: "batch-v2",
    merkle_root: root,
    leaf_count: 2,
    first_settled_at: 1,
    last_settled_at: 1,
    relay_id: "relay-1",
    suite: AGENT_SETTLEMENT_ANCHOR_SUITE,
  };
  const sig = await signBySuite(
    AGENT_SETTLEMENT_ANCHOR_SUITE,
    enc(canonicalJson(batchPayload)),
    kp.privateKey,
  );
  return {
    settlement_hash: leafA,
    batch_id: "batch-v2",
    merkle_root: root,
    leaf_count: 2,
    first_settled_at: 1,
    last_settled_at: 1,
    leaf_index: 0,
    siblings: [leafB],
    layer_sizes: [2],
    relay_id: "relay-1",
    relay_public_key: bytesToHex(kp.publicKey),
    suite: AGENT_SETTLEMENT_ANCHOR_SUITE,
    batch_signature: bytesToHex(sig),
    anchor: null,
    tree_hash_version: V2,
  };
}

describe("verifyAgentSettlementAnchor — tree-hash v2 (RFC 6962 §2.1)", () => {
  it("verifies a v2-tagged 2-leaf proof end to end (leaf + node tags threaded)", async () => {
    const kp = await generateKeypair();
    const proof = await makeV2Proof(RECORD, SIBLING, kp);
    const r = await verifyAgentSettlementAnchor(RECORD, proof);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.steps.hash_valid).toBe(true);
    expect(r.steps.merkle_valid).toBe(true);
    expect(r.steps.relay_signature_valid).toBe(true);
  });

  it("a v2 proof with tree_hash_version STRIPPED is rejected, not silent-downgraded", async () => {
    // Drop the field → verifier resolves absent ⇒ v1. The leaf recomputes
    // untagged (hash step fails) AND the v1 node-combine reconstructs a
    // different root (merkle step fails). Neither silently accepts the v2 root.
    const kp = await generateKeypair();
    const { tree_hash_version: _omit, ...stripped } = await makeV2Proof(RECORD, SIBLING, kp);
    void _omit;
    const r = await verifyAgentSettlementAnchor(RECORD, stripped);
    expect(r.valid).toBe(false);
    expect(r.steps.hash_valid).toBe(false);
    expect(r.steps.merkle_valid).toBe(false);
  });

  it("an unknown tree_hash_version is rejected fail-closed (every step false)", async () => {
    const kp = await generateKeypair();
    const proof = await makeV2Proof(RECORD, SIBLING, kp);
    const r = await verifyAgentSettlementAnchor(RECORD, {
      ...proof,
      tree_hash_version: "merkle-sha256-v3-unknown" as never,
    });
    expect(r.valid).toBe(false);
    expect(r.steps.hash_valid).toBe(false);
    expect(r.steps.merkle_valid).toBe(false);
    expect(r.steps.relay_signature_valid).toBe(false);
    expect(r.errors.some((e) => /unknown tree_hash_version/i.test(e))).toBe(true);
  });
});
