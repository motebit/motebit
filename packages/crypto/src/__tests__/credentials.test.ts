import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  publicKeyToDidKey,
  base58btcEncode,
  base58btcDecode,
  didKeyToPublicKey,
} from "../index.js";
import {
  signVerifiableCredential,
  verifyVerifiableCredential,
  verifyVerifiablePresentation,
  issueGradientCredential,
  issueReputationCredential,
  issueTrustCredential,
  createPresentation,
} from "../credentials";
import type { VerifiableCredential } from "../credentials";

// ---------------------------------------------------------------------------
// base58btcDecode round-trip
// ---------------------------------------------------------------------------

describe("base58btcDecode", () => {
  it("round-trips with base58btcEncode", () => {
    const original = new Uint8Array([0, 0, 1, 2, 3, 255, 128, 64]);
    const encoded = base58btcEncode(original);
    const decoded = base58btcDecode(encoded);
    expect(decoded).toEqual(original);
  });

  it("handles empty input", () => {
    const encoded = base58btcEncode(new Uint8Array(0));
    const decoded = base58btcDecode(encoded);
    expect(decoded).toEqual(new Uint8Array(0));
  });

  it("throws on invalid characters", () => {
    expect(() => base58btcDecode("0OIl")).toThrow("Invalid base58 character");
  });
});

// ---------------------------------------------------------------------------
// didKeyToPublicKey round-trip
// ---------------------------------------------------------------------------

describe("didKeyToPublicKey", () => {
  it("round-trips with publicKeyToDidKey", async () => {
    const { publicKey } = await generateKeypair();
    const did = publicKeyToDidKey(publicKey);
    const recovered = didKeyToPublicKey(did);
    expect(recovered).toEqual(publicKey);
  });

  it("rejects invalid did:key format", () => {
    expect(() => didKeyToPublicKey("not-a-did")).toThrow("Invalid did:key URI");
  });
});

// ---------------------------------------------------------------------------
// VC sign/verify round-trip
// ---------------------------------------------------------------------------

describe("Verifiable Credentials", () => {
  it("signs and verifies a credential", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const issuerDid = publicKeyToDidKey(publicKey);

    const unsignedVC = {
      "@context": ["https://www.w3.org/ns/credentials/v2"] as [
        "https://www.w3.org/ns/credentials/v2",
      ],
      type: ["VerifiableCredential", "TestCredential"],
      issuer: issuerDid,
      credentialSubject: { id: issuerDid, score: 0.85 },
      validFrom: new Date().toISOString(),
    };

    const vc = await signVerifiableCredential(unsignedVC, privateKey, publicKey);
    expect(vc.proof.type).toBe("DataIntegrityProof");
    expect(vc.proof.cryptosuite).toBe("eddsa-jcs-2022");
    expect(vc.proof.proofValue.startsWith("z")).toBe(true);

    const valid = await verifyVerifiableCredential(vc);
    expect(valid).toBe(true);
  });

  it("detects tampering after signing", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const issuerDid = publicKeyToDidKey(publicKey);

    const unsignedVC = {
      "@context": ["https://www.w3.org/ns/credentials/v2"] as [
        "https://www.w3.org/ns/credentials/v2",
      ],
      type: ["VerifiableCredential", "TestCredential"],
      issuer: issuerDid,
      credentialSubject: { id: issuerDid, score: 0.85 },
      validFrom: new Date().toISOString(),
    };

    const vc = await signVerifiableCredential(unsignedVC, privateKey, publicKey);

    // Tamper with the credential subject
    const tampered = {
      ...vc,
      credentialSubject: { ...vc.credentialSubject, score: 0.99 },
    };

    const valid = await verifyVerifiableCredential(tampered as VerifiableCredential);
    expect(valid).toBe(false);
  });

  it("rejects expired credentials", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const issuerDid = publicKeyToDidKey(publicKey);

    const unsignedVC = {
      "@context": ["https://www.w3.org/ns/credentials/v2"] as [
        "https://www.w3.org/ns/credentials/v2",
      ],
      type: ["VerifiableCredential", "TestCredential"],
      issuer: issuerDid,
      credentialSubject: { id: issuerDid, score: 0.85 },
      validFrom: new Date(Date.now() - 7200_000).toISOString(),
      validUntil: new Date(Date.now() - 3600_000).toISOString(), // expired 1h ago
    };

    const vc = await signVerifiableCredential(unsignedVC, privateKey, publicKey);
    const valid = await verifyVerifiableCredential(vc);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VP sign/verify round-trip
// ---------------------------------------------------------------------------

describe("Verifiable Presentations", () => {
  it("signs and verifies a presentation with 2 VCs", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const issuerDid = publicKeyToDidKey(publicKey);

    const vc1 = await signVerifiableCredential(
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["VerifiableCredential", "TestA"],
        issuer: issuerDid,
        credentialSubject: { id: issuerDid, a: 1 },
        validFrom: new Date().toISOString(),
      },
      privateKey,
      publicKey,
    );

    const vc2 = await signVerifiableCredential(
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["VerifiableCredential", "TestB"],
        issuer: issuerDid,
        credentialSubject: { id: issuerDid, b: 2 },
        validFrom: new Date().toISOString(),
      },
      privateKey,
      publicKey,
    );

    const vp = await createPresentation([vc1, vc2], privateKey, publicKey);
    expect(vp.type).toEqual(["VerifiablePresentation"]);
    expect(vp.verifiableCredential.length).toBe(2);

    const result = await verifyVerifiablePresentation(vp);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("detects tampered inner VC within valid VP envelope", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const issuerDid = publicKeyToDidKey(publicKey);

    const vc = await signVerifiableCredential(
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["VerifiableCredential", "TestA"],
        issuer: issuerDid,
        credentialSubject: { id: issuerDid, a: 1 },
        validFrom: new Date().toISOString(),
      },
      privateKey,
      publicKey,
    );

    // Create VP, then tamper with the inner VC
    const vp = await createPresentation([vc], privateKey, publicKey);

    // Tamper with inner VC subject
    (vp.verifiableCredential[0]!.credentialSubject as Record<string, unknown>).a = 999;

    const result = await verifyVerifiablePresentation(vp);
    // VP envelope proof will fail because inner VC was tampered (it's part of the signed document)
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Convenience issuance functions
// ---------------------------------------------------------------------------

describe("issueGradientCredential", () => {
  it("creates a valid self-issued gradient credential", async () => {
    const { publicKey, privateKey } = await generateKeypair();

    const snapshot = {
      gradient: 0.65,
      knowledge_density: 0.7,
      knowledge_quality: 0.6,
      graph_connectivity: 0.4,
      temporal_stability: 0.55,
      retrieval_quality: 0.8,
      interaction_efficiency: 0.75,
      tool_efficiency: 0.9,
      curiosity_pressure: 0.5,
      timestamp: Date.now(),
    };

    const vc = await issueGradientCredential(snapshot, privateKey, publicKey);
    expect(vc.type).toContain("AgentGradientCredential");
    expect(vc.credentialSubject.gradient).toBe(0.65);
    expect(vc.issuer).toBe(vc.credentialSubject.id); // self-issued

    const valid = await verifyVerifiableCredential(vc);
    expect(valid).toBe(true);
  });
});

describe("issueReputationCredential", () => {
  it("creates a valid reputation credential", async () => {
    const relayKeys = await generateKeypair();
    const agentKeys = await generateKeypair();
    const agentDid = publicKeyToDidKey(agentKeys.publicKey);

    const snapshot = {
      success_rate: 0.95,
      avg_latency_ms: 1200,
      task_count: 42,
      trust_score: 0.8,
      availability: 0.99,
      measured_at: Date.now(),
    };

    const vc = await issueReputationCredential(
      snapshot,
      relayKeys.privateKey,
      relayKeys.publicKey,
      agentDid,
    );
    expect(vc.type).toContain("AgentReputationCredential");
    expect(vc.issuer).toBe(publicKeyToDidKey(relayKeys.publicKey)); // relay is issuer
    expect(vc.credentialSubject.id).toBe(agentDid); // agent is subject
    expect(vc.credentialSubject.success_rate).toBe(0.95);

    const valid = await verifyVerifiableCredential(vc);
    expect(valid).toBe(true);
  });
});

describe("issueTrustCredential", () => {
  it("creates a valid trust attestation from agent A about agent B", async () => {
    const agentA = await generateKeypair();
    const agentB = await generateKeypair();
    const agentBDid = publicKeyToDidKey(agentB.publicKey);

    const trustRecord = {
      trust_level: "verified",
      interaction_count: 15,
      successful_tasks: 14,
      failed_tasks: 1,
      first_seen_at: Date.now() - 86400_000,
      last_seen_at: Date.now(),
    };

    const vc = await issueTrustCredential(
      trustRecord,
      agentA.privateKey,
      agentA.publicKey,
      agentBDid,
    );
    expect(vc.type).toContain("AgentTrustCredential");
    expect(vc.issuer).toBe(publicKeyToDidKey(agentA.publicKey));
    expect(vc.credentialSubject.id).toBe(agentBDid);
    expect(vc.credentialSubject.trust_level).toBe("verified");

    const valid = await verifyVerifiableCredential(vc);
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyDataIntegrity error paths (credentials.ts lines 126-128, 136-137, 161-163)
// ---------------------------------------------------------------------------

describe("verifyVerifiableCredential error paths", () => {
  it("rejects a credential with invalid proof type", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const issuerDid = publicKeyToDidKey(publicKey);

    const vc = await signVerifiableCredential(
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["VerifiableCredential", "TestCredential"],
        issuer: issuerDid,
        credentialSubject: { id: issuerDid, score: 0.85 },
        validFrom: new Date().toISOString(),
      },
      privateKey,
      publicKey,
    );

    const tampered = {
      ...vc,
      proof: { ...vc.proof, type: "InvalidProofType" as "DataIntegrityProof" },
    };
    const valid = await verifyVerifiableCredential(tampered as VerifiableCredential);
    expect(valid).toBe(false);
  });

  it("rejects a credential with invalid cryptosuite", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const issuerDid = publicKeyToDidKey(publicKey);

    const vc = await signVerifiableCredential(
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["VerifiableCredential", "TestCredential"],
        issuer: issuerDid,
        credentialSubject: { id: issuerDid, score: 0.85 },
        validFrom: new Date().toISOString(),
      },
      privateKey,
      publicKey,
    );

    const tampered = {
      ...vc,
      proof: { ...vc.proof, cryptosuite: "invalid-suite" as "eddsa-jcs-2022" },
    };
    const valid = await verifyVerifiableCredential(tampered as VerifiableCredential);
    expect(valid).toBe(false);
  });

  it("rejects a credential with invalid DID in verificationMethod", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const issuerDid = publicKeyToDidKey(publicKey);

    const vc = await signVerifiableCredential(
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["VerifiableCredential", "TestCredential"],
        issuer: issuerDid,
        credentialSubject: { id: issuerDid, score: 0.85 },
        validFrom: new Date().toISOString(),
      },
      privateKey,
      publicKey,
    );

    const tampered = {
      ...vc,
      proof: { ...vc.proof, verificationMethod: "not-a-did:key#fragment" },
    };
    const valid = await verifyVerifiableCredential(tampered as VerifiableCredential);
    expect(valid).toBe(false);
  });

  it("rejects a credential with invalid base58btc proofValue", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const issuerDid = publicKeyToDidKey(publicKey);

    const vc = await signVerifiableCredential(
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["VerifiableCredential", "TestCredential"],
        issuer: issuerDid,
        credentialSubject: { id: issuerDid, score: 0.85 },
        validFrom: new Date().toISOString(),
      },
      privateKey,
      publicKey,
    );

    // "z0OIl" — '0', 'O', 'I', 'l' are not valid base58 characters
    const tampered = {
      ...vc,
      proof: { ...vc.proof, proofValue: "z0OIl" },
    };
    const valid = await verifyVerifiableCredential(tampered as VerifiableCredential);
    expect(valid).toBe(false);
  });

  it("rejects a credential whose proofValue does not start with 'z'", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const issuerDid = publicKeyToDidKey(publicKey);

    const vc = await signVerifiableCredential(
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["VerifiableCredential", "TestCredential"],
        issuer: issuerDid,
        credentialSubject: { id: issuerDid, score: 0.85 },
        validFrom: new Date().toISOString(),
      },
      privateKey,
      publicKey,
    );

    // Remove the "z" prefix from proofValue
    const tampered = {
      ...vc,
      proof: { ...vc.proof, proofValue: "noZprefix" },
    };
    const valid = await verifyVerifiableCredential(tampered as VerifiableCredential);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// statusEndpoint branch in issuance functions (lines 285, 331, 376)
// ---------------------------------------------------------------------------

describe("issueGradientCredential with statusEndpoint", () => {
  it("includes credentialStatus when statusEndpoint is provided", async () => {
    const { publicKey, privateKey } = await generateKeypair();

    const snapshot = {
      gradient: 0.65,
      knowledge_density: 0.7,
      knowledge_quality: 0.6,
      graph_connectivity: 0.4,
      temporal_stability: 0.55,
      retrieval_quality: 0.8,
      interaction_efficiency: 0.75,
      tool_efficiency: 0.9,
      curiosity_pressure: 0.5,
      timestamp: Date.now(),
    };

    const vc = await issueGradientCredential(
      snapshot,
      privateKey,
      publicKey,
      undefined,
      undefined,
      "https://example.com/status/1",
    );
    expect(vc.credentialStatus).toEqual({
      id: "https://example.com/status/1",
      type: "RevocationList2024",
    });

    const valid = await verifyVerifiableCredential(vc);
    expect(valid).toBe(true);
  });
});

describe("issueReputationCredential with statusEndpoint", () => {
  it("includes credentialStatus when statusEndpoint is provided", async () => {
    const relayKeys = await generateKeypair();
    const agentKeys = await generateKeypair();
    const agentDid = publicKeyToDidKey(agentKeys.publicKey);

    const snapshot = {
      success_rate: 0.95,
      avg_latency_ms: 1200,
      task_count: 42,
      trust_score: 0.8,
      availability: 0.99,
      measured_at: Date.now(),
    };

    const vc = await issueReputationCredential(
      snapshot,
      relayKeys.privateKey,
      relayKeys.publicKey,
      agentDid,
      undefined,
      "https://example.com/status/2",
    );
    expect(vc.credentialStatus).toEqual({
      id: "https://example.com/status/2",
      type: "RevocationList2024",
    });

    const valid = await verifyVerifiableCredential(vc);
    expect(valid).toBe(true);
  });
});

describe("issueTrustCredential with optional fields omitted", () => {
  it("defaults successful_tasks and failed_tasks to 0 when omitted", async () => {
    const agentA = await generateKeypair();
    const agentB = await generateKeypair();
    const agentBDid = publicKeyToDidKey(agentB.publicKey);

    const trustRecord = {
      trust_level: "known",
      interaction_count: 5,
      // successful_tasks and failed_tasks intentionally omitted
      first_seen_at: Date.now() - 86400_000,
      last_seen_at: Date.now(),
    };

    const vc = await issueTrustCredential(
      trustRecord,
      agentA.privateKey,
      agentA.publicKey,
      agentBDid,
    );
    expect(vc.credentialSubject.successful_tasks).toBe(0);
    expect(vc.credentialSubject.failed_tasks).toBe(0);

    const valid = await verifyVerifiableCredential(vc);
    expect(valid).toBe(true);
  });
});

describe("issueTrustCredential with statusEndpoint", () => {
  it("includes credentialStatus when statusEndpoint is provided", async () => {
    const agentA = await generateKeypair();
    const agentB = await generateKeypair();
    const agentBDid = publicKeyToDidKey(agentB.publicKey);

    const trustRecord = {
      trust_level: "verified",
      interaction_count: 15,
      successful_tasks: 14,
      failed_tasks: 1,
      first_seen_at: Date.now() - 86400_000,
      last_seen_at: Date.now(),
    };

    const vc = await issueTrustCredential(
      trustRecord,
      agentA.privateKey,
      agentA.publicKey,
      agentBDid,
      undefined,
      "https://example.com/status/3",
    );
    expect(vc.credentialStatus).toEqual({
      id: "https://example.com/status/3",
      type: "RevocationList2024",
    });

    const valid = await verifyVerifiableCredential(vc);
    expect(valid).toBe(true);
  });
});
