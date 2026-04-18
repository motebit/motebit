/**
 * Runtime-parse tests for the credential-anchor pair — Batch + Proof.
 * The two artifacts that make credential anchoring externally
 * verifiable without trusting any relay.
 */
import { describe, expect, it } from "vitest";

import { CredentialAnchorBatchSchema, CredentialAnchorProofSchema } from "../credential-anchor.js";

const SUITE = "motebit-jcs-ed25519-hex-v1";
const SIG = "deadbeef".repeat(8); // 64-byte hex sig
const RELAY_ID = "019cd9d4-3275-7b24-8265-relay0000001";
const MERKLE_ROOT = "a".repeat(64);

const ANCHOR = {
  chain: "solana",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  tx_hash: "5j7s7p...txhash",
  anchored_at: 1_713_456_005_000,
};

// ---------------------------------------------------------------------------
// CredentialAnchorBatch
// ---------------------------------------------------------------------------

describe("CredentialAnchorBatchSchema", () => {
  const SAMPLE: Record<string, unknown> = {
    batch_id: "01HTV8X9QZ-batch-1",
    relay_id: RELAY_ID,
    merkle_root: MERKLE_ROOT,
    leaf_count: 128,
    first_issued_at: 1_713_400_000_000,
    last_issued_at: 1_713_456_000_000,
    suite: SUITE,
    signature: SIG,
    anchor: ANCHOR,
  };

  it("parses a batch with onchain anchor", () => {
    const b = CredentialAnchorBatchSchema.parse(SAMPLE);
    expect(b.merkle_root).toBe(MERKLE_ROOT);
    expect(b.leaf_count).toBe(128);
    expect(b.anchor?.chain).toBe("solana");
  });

  it("parses a signed-but-unanchored batch (anchor: null)", () => {
    const b = CredentialAnchorBatchSchema.parse({ ...SAMPLE, anchor: null });
    expect(b.anchor).toBeNull();
  });

  it("rejects the wrong cryptosuite (must be hex-v1, not b64-v1)", () => {
    expect(() =>
      CredentialAnchorBatchSchema.parse({ ...SAMPLE, suite: "motebit-jcs-ed25519-b64-v1" }),
    ).toThrow();
  });

  it("rejects negative leaf_count", () => {
    expect(() => CredentialAnchorBatchSchema.parse({ ...SAMPLE, leaf_count: -1 })).toThrow();
  });

  it("rejects non-integer leaf_count", () => {
    expect(() => CredentialAnchorBatchSchema.parse({ ...SAMPLE, leaf_count: 1.5 })).toThrow();
  });

  it("accepts an empty batch (leaf_count: 0) — relays may anchor a checkpoint with no credentials", () => {
    const b = CredentialAnchorBatchSchema.parse({ ...SAMPLE, leaf_count: 0 });
    expect(b.leaf_count).toBe(0);
  });

  it("rejects a malformed nested anchor (missing tx_hash)", () => {
    const badAnchor = { chain: "solana", network: "solana:x", anchored_at: 0 };
    expect(() => CredentialAnchorBatchSchema.parse({ ...SAMPLE, anchor: badAnchor })).toThrow();
  });

  it("rejects extra top-level keys (strict mode)", () => {
    expect(() => CredentialAnchorBatchSchema.parse({ ...SAMPLE, sneak: "no" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CredentialAnchorProof
// ---------------------------------------------------------------------------

describe("CredentialAnchorProofSchema", () => {
  const SAMPLE: Record<string, unknown> = {
    credential_id: "cred-1",
    credential_hash: "b".repeat(64),
    batch_id: "01HTV8X9QZ-batch-1",
    merkle_root: MERKLE_ROOT,
    leaf_count: 128,
    first_issued_at: 1_713_400_000_000,
    last_issued_at: 1_713_456_000_000,
    leaf_index: 42,
    siblings: ["c".repeat(64), "d".repeat(64), "e".repeat(64)],
    layer_sizes: [128, 64, 32, 16, 8, 4, 2, 1],
    relay_id: RELAY_ID,
    relay_public_key: "f".repeat(64),
    suite: SUITE,
    batch_signature: SIG,
    anchor: ANCHOR,
  };

  it("parses a proof with onchain anchor", () => {
    const p = CredentialAnchorProofSchema.parse(SAMPLE);
    expect(p.leaf_index).toBe(42);
    expect(p.siblings).toHaveLength(3);
    expect(p.layer_sizes[0]).toBe(128);
  });

  it("parses a proof for an unanchored batch (anchor: null)", () => {
    const p = CredentialAnchorProofSchema.parse({ ...SAMPLE, anchor: null });
    expect(p.anchor).toBeNull();
  });

  it("accepts an empty siblings array (single-leaf batch — root === leaf)", () => {
    const p = CredentialAnchorProofSchema.parse({
      ...SAMPLE,
      siblings: [],
      layer_sizes: [1],
      leaf_count: 1,
      leaf_index: 0,
    });
    expect(p.siblings).toEqual([]);
  });

  it("rejects negative leaf_index", () => {
    expect(() => CredentialAnchorProofSchema.parse({ ...SAMPLE, leaf_index: -1 })).toThrow();
  });

  it("rejects non-integer leaf_index", () => {
    expect(() => CredentialAnchorProofSchema.parse({ ...SAMPLE, leaf_index: 1.5 })).toThrow();
  });

  it("rejects empty strings inside siblings", () => {
    expect(() => CredentialAnchorProofSchema.parse({ ...SAMPLE, siblings: ["", "x"] })).toThrow();
  });

  it("rejects negative layer_sizes entries", () => {
    expect(() =>
      CredentialAnchorProofSchema.parse({ ...SAMPLE, layer_sizes: [128, -1, 32] }),
    ).toThrow();
  });

  it("rejects extra top-level keys (strict mode)", () => {
    expect(() => CredentialAnchorProofSchema.parse({ ...SAMPLE, sneak: "no" })).toThrow();
  });

  it("rejects the wrong cryptosuite", () => {
    expect(() =>
      CredentialAnchorProofSchema.parse({ ...SAMPLE, suite: "motebit-jcs-ed25519-b64-v1" }),
    ).toThrow();
  });
});
