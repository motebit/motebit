/**
 * Credential anchor leaf computation tests.
 */
import { describe, it, expect } from "vitest";
import { computeCredentialLeaf } from "../credential-anchor.js";
import { issueReputationCredential, generateKeypair } from "../index.js";

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
        sample_size: 10,
        timestamp: 1000,
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
        sample_size: 10,
        timestamp: 1000,
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
        sample_size: 10,
        timestamp: 1000,
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
        sample_size: 5,
        timestamp: 2000,
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
        sample_size: 10,
        timestamp: 1000,
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
