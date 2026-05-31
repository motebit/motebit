import { describe, it, expect } from "vitest";

import {
  FEDERATION_SETTLEMENT_ANCHOR_SUITE,
  computeFederationSettlementLeaf,
  verifyFederationSettlementAnchor,
  type FederationSettlementAnchorProofFields,
} from "../federation-settlement-anchor.js";
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

// A full signed FederationSettlementRecord (the bytes a peer holds), with x402
// fields present to prove optional keys are anchored verbatim.
const RECORD: Record<string, unknown> = {
  settlement_id: "fed-settle-1",
  task_id: "task-1",
  upstream_relay_id: "relay-up",
  downstream_relay_id: "relay-down",
  agent_id: "agent-1",
  gross_amount: 1_000_000,
  fee_amount: 50_000,
  net_amount: 950_000,
  fee_rate: 0.05,
  receipt_hash: "a".repeat(64),
  settled_at: 1_700_000_000_000,
  x402_tx_hash: "0xabc",
  x402_network: "eip155:8453",
  issuer_relay_id: "relay-up",
  suite: "motebit-jcs-ed25519-b64-v1",
  signature: "Zm9vYmFy",
};

/** A valid single-leaf v1 proof for `record`, signed by `kp`. */
async function makeProof(
  record: Record<string, unknown>,
  kp: KeyPair,
): Promise<FederationSettlementAnchorProofFields> {
  const leaf = await computeFederationSettlementLeaf(record);
  const batchPayload = {
    batch_id: "batch-1",
    merkle_root: leaf,
    leaf_count: 1,
    first_settled_at: 1,
    last_settled_at: 1,
    relay_id: "relay-up",
    suite: FEDERATION_SETTLEMENT_ANCHOR_SUITE,
  };
  const sig = await signBySuite(
    FEDERATION_SETTLEMENT_ANCHOR_SUITE,
    enc(canonicalJson(batchPayload)),
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
    relay_id: "relay-up",
    relay_public_key: bytesToHex(kp.publicKey),
    suite: FEDERATION_SETTLEMENT_ANCHOR_SUITE,
    batch_signature: bytesToHex(sig),
    anchor: null,
  };
}

describe("computeFederationSettlementLeaf", () => {
  it("is deterministic and a 64-hex SHA-256", async () => {
    const a = await computeFederationSettlementLeaf(RECORD);
    const b = await computeFederationSettlementLeaf({ ...RECORD });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any field changes (verbatim commitment)", async () => {
    const base = await computeFederationSettlementLeaf(RECORD);
    expect(await computeFederationSettlementLeaf({ ...RECORD, gross_amount: 1 })).not.toBe(base);
    const { x402_tx_hash: _drop, ...withoutX402 } = RECORD;
    void _drop;
    expect(await computeFederationSettlementLeaf(withoutX402)).not.toBe(base);
  });

  it("v1 (default) and v2 leaves differ — the RFC 6962 leaf tag is applied", async () => {
    const v1 = await computeFederationSettlementLeaf(RECORD);
    const v2 = await computeFederationSettlementLeaf(RECORD, "merkle-sha256-rfc6962-v2");
    expect(v1).not.toBe(v2);
  });
});

describe("verifyFederationSettlementAnchor", () => {
  it("verifies a valid single-leaf v1 proof (absent tree_hash_version ⇒ v1)", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(RECORD, kp);
    expect(proof.tree_hash_version).toBeUndefined();
    const r = await verifyFederationSettlementAnchor(RECORD, proof);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.steps.hash_valid).toBe(true);
    expect(r.steps.merkle_valid).toBe(true);
    expect(r.steps.relay_signature_valid).toBe(true);
  });

  it("rejects a record tampered after signing (hash step fails)", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(RECORD, kp);
    const r = await verifyFederationSettlementAnchor({ ...RECORD, net_amount: 999 }, proof);
    expect(r.valid).toBe(false);
    expect(r.steps.hash_valid).toBe(false);
  });

  it("rejects a batch signed by a different key (relay signature fails)", async () => {
    const kp = await generateKeypair();
    const other = await generateKeypair();
    const proof = await makeProof(RECORD, kp);
    proof.relay_public_key = bytesToHex(other.publicKey);
    const r = await verifyFederationSettlementAnchor(RECORD, proof);
    expect(r.valid).toBe(false);
    expect(r.steps.relay_signature_valid).toBe(false);
  });

  it("rejects an unknown suite fail-closed", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(RECORD, kp);
    const r = await verifyFederationSettlementAnchor(RECORD, {
      ...proof,
      suite: "bogus-suite" as never,
    });
    expect(r.valid).toBe(false);
    expect(r.steps.relay_signature_valid).toBe(false);
  });

  it("runs the optional onchain step and passes when the chain verifier confirms", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(RECORD, kp);
    proof.anchor = {
      chain: "eip155",
      network: "eip155:8453",
      tx_hash: "0xdeadbeef",
      anchored_at: 1,
    };
    const r = await verifyFederationSettlementAnchor(RECORD, proof, async (a) => {
      expect(a.expected_root).toBe(proof.merkle_root);
      return true;
    });
    expect(r.valid).toBe(true);
    expect(r.steps.chain_verified).toBe(true);
  });
});

// === Tree-hash v2 (RFC 6962 §2.1) — ≥2-leaf, exercises BOTH domain tags ===

const SIBLING: Record<string, unknown> = { ...RECORD, settlement_id: "fed-settle-2" };

/** A valid 2-leaf v2 proof for `record` at index 0 with `sibling` at index 1. */
async function makeV2Proof(
  record: Record<string, unknown>,
  sibling: Record<string, unknown>,
  kp: KeyPair,
): Promise<FederationSettlementAnchorProofFields> {
  const V2 = "merkle-sha256-rfc6962-v2" as const;
  const leafA = await computeFederationSettlementLeaf(record, V2);
  const leafB = await computeFederationSettlementLeaf(sibling, V2);
  const combined = new Uint8Array([0x01, ...hexToBytes(leafA), ...hexToBytes(leafB)]);
  const root = bytesToHex(await sha256(combined));
  const batchPayload = {
    batch_id: "batch-v2",
    merkle_root: root,
    leaf_count: 2,
    first_settled_at: 1,
    last_settled_at: 1,
    relay_id: "relay-up",
    suite: FEDERATION_SETTLEMENT_ANCHOR_SUITE,
  };
  const sig = await signBySuite(
    FEDERATION_SETTLEMENT_ANCHOR_SUITE,
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
    relay_id: "relay-up",
    relay_public_key: bytesToHex(kp.publicKey),
    suite: FEDERATION_SETTLEMENT_ANCHOR_SUITE,
    batch_signature: bytesToHex(sig),
    anchor: null,
    tree_hash_version: V2,
  };
}

describe("verifyFederationSettlementAnchor — tree-hash v2 (RFC 6962 §2.1)", () => {
  it("verifies a v2-tagged 2-leaf proof end to end (leaf + node tags threaded)", async () => {
    const kp = await generateKeypair();
    const proof = await makeV2Proof(RECORD, SIBLING, kp);
    const r = await verifyFederationSettlementAnchor(RECORD, proof);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.steps.hash_valid).toBe(true);
    expect(r.steps.merkle_valid).toBe(true);
    expect(r.steps.relay_signature_valid).toBe(true);
  });

  it("a v2 proof with tree_hash_version STRIPPED is rejected, not silent-downgraded", async () => {
    const kp = await generateKeypair();
    const { tree_hash_version: _omit, ...stripped } = await makeV2Proof(RECORD, SIBLING, kp);
    void _omit;
    const r = await verifyFederationSettlementAnchor(RECORD, stripped);
    expect(r.valid).toBe(false);
    expect(r.steps.hash_valid).toBe(false);
    expect(r.steps.merkle_valid).toBe(false);
  });

  it("an unknown tree_hash_version is rejected fail-closed (every step false)", async () => {
    const kp = await generateKeypair();
    const proof = await makeV2Proof(RECORD, SIBLING, kp);
    const r = await verifyFederationSettlementAnchor(RECORD, {
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
