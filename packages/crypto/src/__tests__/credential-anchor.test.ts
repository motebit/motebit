/**
 * Credential anchor tests — leaf computation and self-verification.
 */
import { describe, it, expect } from "vitest";
import {
  computeCredentialLeaf,
  verifyCredentialAnchor,
  verifyRevocationAnchor,
  issueReputationCredential,
  generateKeypair,
  canonicalJson,
  ed25519Sign,
  bytesToHex,
  sha256,
} from "../index.js";

// === Helpers ===

/** Minimal Merkle tree builder for test — matches encryption/merkle.ts algorithm. */
async function buildTestTree(leaves: string[]) {
  function fromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  }
  function toHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }

  const layers: string[][] = [leaves];
  let current = leaves;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        const combined = concat(fromHex(current[i]!), fromHex(current[i + 1]!));
        const h = await sha256(combined);
        next.push(toHex(h));
      } else {
        next.push(current[i]!);
      }
    }
    layers.push(next);
    current = next;
  }

  return { root: current[0]!, leaves, layers };
}

function getTestProof(
  tree: { root: string; leaves: string[]; layers: string[][] },
  leafIndex: number,
) {
  const siblings: string[] = [];
  const layerSizes: number[] = [];
  let idx = leafIndex;

  for (let layer = 0; layer < tree.layers.length - 1; layer++) {
    const level = tree.layers[layer]!;
    layerSizes.push(level.length);
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (siblingIdx >= 0 && siblingIdx < level.length) {
      siblings.push(level[siblingIdx]!);
    }
    idx = Math.floor(idx / 2);
  }

  return {
    leaf: tree.leaves[leafIndex]!,
    index: leafIndex,
    siblings,
    layerSizes,
  };
}

/** Create a signed batch payload, simulating what the relay does. The
 *  cryptosuite discriminator is stamped into the signed body so the
 *  verifier dispatches via `verifyBySuite` rather than assuming Ed25519. */
const CREDENTIAL_ANCHOR_SUITE = "motebit-jcs-ed25519-hex-v1" as const;
async function signBatchPayload(batchPayload: Record<string, unknown>, privateKey: Uint8Array) {
  const payloadWithSuite = { ...batchPayload, suite: CREDENTIAL_ANCHOR_SUITE };
  const payloadBytes = new TextEncoder().encode(canonicalJson(payloadWithSuite));
  const sig = await ed25519Sign(payloadBytes, privateKey);
  return bytesToHex(sig);
}

// === computeCredentialLeaf ===

describe("computeCredentialLeaf", () => {
  it("produces a 64-char hex SHA-256 hash", async () => {
    const keypair = await generateKeypair();
    const vc = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      keypair.privateKey,
      keypair.publicKey,
      "did:key:zSubjectTest",
    );

    const leaf = await computeCredentialLeaf(vc as unknown as Record<string, unknown>);
    expect(leaf).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same credential produces same hash", async () => {
    const keypair = await generateKeypair();
    const vc = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      keypair.privateKey,
      keypair.publicKey,
      "did:key:zSubjectTest",
    );

    const leaf1 = await computeCredentialLeaf(vc as unknown as Record<string, unknown>);
    const leaf2 = await computeCredentialLeaf(vc as unknown as Record<string, unknown>);
    expect(leaf1).toBe(leaf2);
  });

  it("different credentials produce different hashes", async () => {
    const keypair = await generateKeypair();
    const vc1 = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      keypair.privateKey,
      keypair.publicKey,
      "did:key:zSubject1",
    );
    const vc2 = await issueReputationCredential(
      {
        success_rate: 0.5,
        avg_latency_ms: 500,
        task_count: 5,
        trust_score: 0.3,
        availability: 0.7,
        measured_at: 2000,
      },
      keypair.privateKey,
      keypair.publicKey,
      "did:key:zSubject2",
    );

    const leaf1 = await computeCredentialLeaf(vc1 as unknown as Record<string, unknown>);
    const leaf2 = await computeCredentialLeaf(vc2 as unknown as Record<string, unknown>);
    expect(leaf1).not.toBe(leaf2);
  });

  it("includes proof in hash — removing proof changes the hash", async () => {
    const keypair = await generateKeypair();
    const vc = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      keypair.privateKey,
      keypair.publicKey,
      "did:key:zSubjectTest",
    );

    const withProof = await computeCredentialLeaf(vc as unknown as Record<string, unknown>);
    const { proof: _, ...withoutProof } = vc as Record<string, unknown>;
    const stripped = await computeCredentialLeaf(withoutProof);
    expect(withProof).not.toBe(stripped);
  });
});

// === verifyCredentialAnchor ===

describe("verifyCredentialAnchor", () => {
  it("verifies a valid single-credential anchor proof (steps 1-3)", async () => {
    // Issue a credential
    const issuerKeypair = await generateKeypair();
    const vc = await issueReputationCredential(
      {
        success_rate: 0.95,
        avg_latency_ms: 100,
        task_count: 50,
        trust_score: 0.9,
        availability: 0.99,
        measured_at: 1000,
      },
      issuerKeypair.privateKey,
      issuerKeypair.publicKey,
      "did:key:zAgent1",
    );

    // Simulate relay: compute leaf, build tree, sign batch
    const relayKeypair = await generateKeypair();
    const leaf = await computeCredentialLeaf(vc as unknown as Record<string, unknown>);
    const tree = await buildTestTree([leaf]);
    const merkleProof = getTestProof(tree, 0);

    const batchId = "test-batch-001";
    const batchPayload = {
      batch_id: batchId,
      merkle_root: tree.root,
      leaf_count: 1,
      first_issued_at: 1000,
      last_issued_at: 1000,
      relay_id: "relay-test",
    };
    const batchSignature = await signBatchPayload(batchPayload, relayKeypair.privateKey);

    // Verify
    const result = await verifyCredentialAnchor(vc as unknown as Record<string, unknown>, {
      credential_hash: leaf,
      batch_id: batchId,
      merkle_root: tree.root,
      leaf_count: 1,
      first_issued_at: 1000,
      last_issued_at: 1000,
      leaf_index: 0,
      siblings: merkleProof.siblings,
      layer_sizes: merkleProof.layerSizes,
      relay_id: "relay-test",
      relay_public_key: bytesToHex(relayKeypair.publicKey),
      suite: CREDENTIAL_ANCHOR_SUITE,
      batch_signature: batchSignature,
      anchor: null,
    });

    expect(result.valid).toBe(true);
    expect(result.steps.hash_valid).toBe(true);
    expect(result.steps.merkle_valid).toBe(true);
    expect(result.steps.relay_signature_valid).toBe(true);
    expect(result.steps.chain_verified).toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  it("verifies a multi-credential batch", async () => {
    const issuerKeypair = await generateKeypair();
    const relayKeypair = await generateKeypair();

    // Issue 3 credentials
    const vcs = await Promise.all(
      [1, 2, 3].map((i) =>
        issueReputationCredential(
          {
            success_rate: 0.8 + i * 0.05,
            avg_latency_ms: 100 * i,
            task_count: 10 * i,
            trust_score: 0.7 + i * 0.05,
            availability: 0.9,
            measured_at: 1000 * i,
          },
          issuerKeypair.privateKey,
          issuerKeypair.publicKey,
          `did:key:zAgent${i}`,
        ),
      ),
    );

    // Build tree from all 3
    const leaves = await Promise.all(
      vcs.map((vc) => computeCredentialLeaf(vc as unknown as Record<string, unknown>)),
    );
    const tree = await buildTestTree(leaves);

    const batchPayload = {
      batch_id: "batch-multi",
      merkle_root: tree.root,
      leaf_count: 3,
      first_issued_at: 1000,
      last_issued_at: 3000,
      relay_id: "relay-multi",
    };
    const batchSignature = await signBatchPayload(batchPayload, relayKeypair.privateKey);

    // Verify each credential in the batch
    for (let i = 0; i < vcs.length; i++) {
      const proof = getTestProof(tree, i);
      const result = await verifyCredentialAnchor(vcs[i] as unknown as Record<string, unknown>, {
        credential_hash: leaves[i]!,
        batch_id: "batch-multi",
        merkle_root: tree.root,
        leaf_count: 3,
        first_issued_at: 1000,
        last_issued_at: 3000,
        leaf_index: i,
        siblings: proof.siblings,
        layer_sizes: proof.layerSizes,
        relay_id: "relay-multi",
        relay_public_key: bytesToHex(relayKeypair.publicKey),
        suite: CREDENTIAL_ANCHOR_SUITE,
        batch_signature: batchSignature,
        anchor: null,
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });

  it("fails on tampered credential (step 1)", async () => {
    const issuerKeypair = await generateKeypair();
    const relayKeypair = await generateKeypair();

    const vc = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      issuerKeypair.privateKey,
      issuerKeypair.publicKey,
      "did:key:zAgent1",
    );

    const leaf = await computeCredentialLeaf(vc as unknown as Record<string, unknown>);
    const tree = await buildTestTree([leaf]);
    const proof = getTestProof(tree, 0);

    const batchPayload = {
      batch_id: "batch-tamper",
      merkle_root: tree.root,
      leaf_count: 1,
      first_issued_at: 1000,
      last_issued_at: 1000,
      relay_id: "relay-test",
    };
    const batchSignature = await signBatchPayload(batchPayload, relayKeypair.privateKey);

    // Tamper with the credential
    const tampered = { ...(vc as Record<string, unknown>), extra_field: "injected" };

    const result = await verifyCredentialAnchor(tampered, {
      credential_hash: leaf,
      batch_id: "batch-tamper",
      merkle_root: tree.root,
      leaf_count: 1,
      first_issued_at: 1000,
      last_issued_at: 1000,
      leaf_index: 0,
      siblings: proof.siblings,
      layer_sizes: proof.layerSizes,
      relay_id: "relay-test",
      relay_public_key: bytesToHex(relayKeypair.publicKey),
      suite: CREDENTIAL_ANCHOR_SUITE,
      batch_signature: batchSignature,
      anchor: null,
    });

    expect(result.valid).toBe(false);
    expect(result.steps.hash_valid).toBe(false);
    expect(result.errors[0]).toMatch(/Hash mismatch/);
  });

  it("fails on wrong relay key (step 3)", async () => {
    const issuerKeypair = await generateKeypair();
    const relayKeypair = await generateKeypair();
    const wrongKeypair = await generateKeypair();

    const vc = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      issuerKeypair.privateKey,
      issuerKeypair.publicKey,
      "did:key:zAgent1",
    );

    const leaf = await computeCredentialLeaf(vc as unknown as Record<string, unknown>);
    const tree = await buildTestTree([leaf]);
    const proof = getTestProof(tree, 0);

    const batchPayload = {
      batch_id: "batch-wrong-key",
      merkle_root: tree.root,
      leaf_count: 1,
      first_issued_at: 1000,
      last_issued_at: 1000,
      relay_id: "relay-test",
    };
    const batchSignature = await signBatchPayload(batchPayload, relayKeypair.privateKey);

    // Use wrong relay public key for verification
    const result = await verifyCredentialAnchor(vc as unknown as Record<string, unknown>, {
      credential_hash: leaf,
      batch_id: "batch-wrong-key",
      merkle_root: tree.root,
      leaf_count: 1,
      first_issued_at: 1000,
      last_issued_at: 1000,
      leaf_index: 0,
      siblings: proof.siblings,
      layer_sizes: proof.layerSizes,
      relay_id: "relay-test",
      relay_public_key: bytesToHex(wrongKeypair.publicKey),
      suite: CREDENTIAL_ANCHOR_SUITE,
      batch_signature: batchSignature,
      anchor: null,
    });

    expect(result.valid).toBe(false);
    expect(result.steps.hash_valid).toBe(true);
    expect(result.steps.merkle_valid).toBe(true);
    expect(result.steps.relay_signature_valid).toBe(false);
  });

  it("calls chain verifier when anchor is present (step 4)", async () => {
    const issuerKeypair = await generateKeypair();
    const relayKeypair = await generateKeypair();

    const vc = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      issuerKeypair.privateKey,
      issuerKeypair.publicKey,
      "did:key:zAgent1",
    );

    const leaf = await computeCredentialLeaf(vc as unknown as Record<string, unknown>);
    const tree = await buildTestTree([leaf]);
    const proof = getTestProof(tree, 0);

    const batchPayload = {
      batch_id: "batch-chain",
      merkle_root: tree.root,
      leaf_count: 1,
      first_issued_at: 1000,
      last_issued_at: 1000,
      relay_id: "relay-test",
    };
    const batchSignature = await signBatchPayload(batchPayload, relayKeypair.privateKey);

    // Chain verifier that checks the root matches
    let verifierCalled = false;
    const chainVerifier = async (anchor: { expected_root: string }) => {
      verifierCalled = true;
      return anchor.expected_root === tree.root;
    };

    const result = await verifyCredentialAnchor(
      vc as unknown as Record<string, unknown>,
      {
        credential_hash: leaf,
        batch_id: "batch-chain",
        merkle_root: tree.root,
        leaf_count: 1,
        first_issued_at: 1000,
        last_issued_at: 1000,
        leaf_index: 0,
        siblings: proof.siblings,
        layer_sizes: proof.layerSizes,
        relay_id: "relay-test",
        relay_public_key: bytesToHex(relayKeypair.publicKey),
        suite: CREDENTIAL_ANCHOR_SUITE,
        batch_signature: batchSignature,
        anchor: {
          chain: "solana",
          network: "solana:devnet",
          tx_hash: "fakeTxHash123",
          anchored_at: 2000,
        },
      },
      chainVerifier,
    );

    expect(verifierCalled).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.steps.chain_verified).toBe(true);
  });

  it("skips chain verification when no verifier provided", async () => {
    const issuerKeypair = await generateKeypair();
    const relayKeypair = await generateKeypair();

    const vc = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      issuerKeypair.privateKey,
      issuerKeypair.publicKey,
      "did:key:zAgent1",
    );

    const leaf = await computeCredentialLeaf(vc as unknown as Record<string, unknown>);
    const tree = await buildTestTree([leaf]);
    const proof = getTestProof(tree, 0);

    const batchPayload = {
      batch_id: "batch-no-verifier",
      merkle_root: tree.root,
      leaf_count: 1,
      first_issued_at: 1000,
      last_issued_at: 1000,
      relay_id: "relay-test",
    };
    const batchSignature = await signBatchPayload(batchPayload, relayKeypair.privateKey);

    // Anchor present but no verifier — should still pass (step 4 = null)
    const result = await verifyCredentialAnchor(vc as unknown as Record<string, unknown>, {
      credential_hash: leaf,
      batch_id: "batch-no-verifier",
      merkle_root: tree.root,
      leaf_count: 1,
      first_issued_at: 1000,
      last_issued_at: 1000,
      leaf_index: 0,
      siblings: proof.siblings,
      layer_sizes: proof.layerSizes,
      relay_id: "relay-test",
      relay_public_key: bytesToHex(relayKeypair.publicKey),
      suite: CREDENTIAL_ANCHOR_SUITE,
      batch_signature: batchSignature,
      anchor: {
        chain: "solana",
        network: "solana:devnet",
        tx_hash: "fakeTx",
        anchored_at: 2000,
      },
    });

    expect(result.valid).toBe(true);
    expect(result.steps.chain_verified).toBeNull();
  });
});

// === verifyRevocationAnchor ===

describe("verifyRevocationAnchor", () => {
  it("verifies a valid revocation anchor (steps 1-2)", async () => {
    const relayKeypair = await generateKeypair();
    const revokedKeyHex = bytesToHex(relayKeypair.publicKey); // use relay key as test revoked key
    const timestamp = Date.now();
    const payload = `revocation:agent_revoked:mid-test-agent:${timestamp}`;
    const sig = await ed25519Sign(new TextEncoder().encode(payload), relayKeypair.privateKey);

    const result = await verifyRevocationAnchor(
      {
        revoked_public_key: revokedKeyHex,
        suite: "motebit-concat-ed25519-hex-v1",
        timestamp,
        signature: bytesToHex(sig),
        relay_public_key: bytesToHex(relayKeypair.publicKey),
        anchor: null,
      },
      payload,
    );

    expect(result.valid).toBe(true);
    expect(result.steps.memo_valid).toBe(true);
    expect(result.steps.relay_signature_valid).toBe(true);
    expect(result.steps.chain_verified).toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  it("fails on wrong relay key", async () => {
    const relayKeypair = await generateKeypair();
    const wrongKeypair = await generateKeypair();
    const revokedKeyHex = bytesToHex(relayKeypair.publicKey);
    const timestamp = Date.now();
    const payload = `revocation:key_rotated:mid-test-agent:${timestamp}`;
    const sig = await ed25519Sign(new TextEncoder().encode(payload), relayKeypair.privateKey);

    const result = await verifyRevocationAnchor(
      {
        revoked_public_key: revokedKeyHex,
        suite: "motebit-concat-ed25519-hex-v1",
        timestamp,
        signature: bytesToHex(sig),
        relay_public_key: bytesToHex(wrongKeypair.publicKey),
        anchor: null,
      },
      payload,
    );

    expect(result.valid).toBe(false);
    expect(result.steps.relay_signature_valid).toBe(false);
    expect(result.errors[0]).toMatch(/signature verification failed/);
  });

  it("fails on invalid public key format", async () => {
    const relayKeypair = await generateKeypair();
    const timestamp = Date.now();
    const payload = `revocation:agent_revoked:mid-test:${timestamp}`;
    const sig = await ed25519Sign(new TextEncoder().encode(payload), relayKeypair.privateKey);

    const result = await verifyRevocationAnchor(
      {
        revoked_public_key: "short",
        suite: "motebit-concat-ed25519-hex-v1",
        timestamp,
        signature: bytesToHex(sig),
        relay_public_key: bytesToHex(relayKeypair.publicKey),
        anchor: null,
      },
      payload,
    );

    expect(result.valid).toBe(false);
    expect(result.steps.memo_valid).toBe(false);
  });

  it("fails on zero timestamp", async () => {
    const relayKeypair = await generateKeypair();
    const revokedKeyHex = bytesToHex(relayKeypair.publicKey);
    const payload = `revocation:agent_revoked:mid-test:0`;
    const sig = await ed25519Sign(new TextEncoder().encode(payload), relayKeypair.privateKey);

    const result = await verifyRevocationAnchor(
      {
        revoked_public_key: revokedKeyHex,
        suite: "motebit-concat-ed25519-hex-v1",
        timestamp: 0,
        signature: bytesToHex(sig),
        relay_public_key: bytesToHex(relayKeypair.publicKey),
        anchor: null,
      },
      payload,
    );

    expect(result.valid).toBe(false);
    expect(result.steps.memo_valid).toBe(false);
  });

  it("calls chain verifier when anchor is present", async () => {
    const relayKeypair = await generateKeypair();
    const revokedKeyHex = bytesToHex(relayKeypair.publicKey);
    const timestamp = Date.now();
    const payload = `revocation:agent_revoked:mid-test:${timestamp}`;
    const sig = await ed25519Sign(new TextEncoder().encode(payload), relayKeypair.privateKey);

    let verifierCalled = false;
    const expectedMemo = `motebit:revocation:v1:${revokedKeyHex}:${timestamp}`;

    const result = await verifyRevocationAnchor(
      {
        revoked_public_key: revokedKeyHex,
        suite: "motebit-concat-ed25519-hex-v1",
        timestamp,
        signature: bytesToHex(sig),
        relay_public_key: bytesToHex(relayKeypair.publicKey),
        anchor: {
          chain: "solana",
          network: "solana:devnet",
          tx_hash: "fakeTxHash",
        },
      },
      payload,
      async (anchor) => {
        verifierCalled = true;
        expect(anchor.expected_memo).toBe(expectedMemo);
        return true;
      },
    );

    expect(verifierCalled).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.steps.chain_verified).toBe(true);
  });

  it("skips chain verification when no verifier provided", async () => {
    const relayKeypair = await generateKeypair();
    const revokedKeyHex = bytesToHex(relayKeypair.publicKey);
    const timestamp = Date.now();
    const payload = `revocation:agent_revoked:mid-test:${timestamp}`;
    const sig = await ed25519Sign(new TextEncoder().encode(payload), relayKeypair.privateKey);

    const result = await verifyRevocationAnchor(
      {
        revoked_public_key: revokedKeyHex,
        suite: "motebit-concat-ed25519-hex-v1",
        timestamp,
        signature: bytesToHex(sig),
        relay_public_key: bytesToHex(relayKeypair.publicKey),
        anchor: {
          chain: "solana",
          network: "solana:devnet",
          tx_hash: "fakeTx",
        },
      },
      payload,
    );

    expect(result.valid).toBe(true);
    expect(result.steps.chain_verified).toBeNull();
  });

  it("reports chain verifier failure", async () => {
    const relayKeypair = await generateKeypair();
    const revokedKeyHex = bytesToHex(relayKeypair.publicKey);
    const timestamp = Date.now();
    const payload = `revocation:agent_revoked:mid-test:${timestamp}`;
    const sig = await ed25519Sign(new TextEncoder().encode(payload), relayKeypair.privateKey);

    const result = await verifyRevocationAnchor(
      {
        revoked_public_key: revokedKeyHex,
        suite: "motebit-concat-ed25519-hex-v1",
        timestamp,
        signature: bytesToHex(sig),
        relay_public_key: bytesToHex(relayKeypair.publicKey),
        anchor: {
          chain: "solana",
          network: "solana:devnet",
          tx_hash: "fakeTx",
        },
      },
      payload,
      async () => false,
    );

    expect(result.valid).toBe(false);
    expect(result.steps.chain_verified).toBe(false);
    expect(result.errors[0]).toMatch(/Onchain revocation anchor verification failed/);
  });
});
