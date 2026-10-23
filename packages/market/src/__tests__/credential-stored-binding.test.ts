/**
 * A credential read straight from storage counts toward routing only when the
 * proof's signer is its issuer (GHSA-7pgw-2976-r236). Rows stored before the
 * verifier enforced the binding never pass the verify door again, so the
 * aggregators apply it themselves on every read.
 */
import { describe, it, expect } from "vitest";
import {
  aggregateCredentialReputation,
  aggregateHardwareAttestation,
  boundIssuerDid,
} from "../credential-weight.js";
import type { ReputationVC, TrustVC } from "../credential-weight.js";

const SUBJECT = "did:key:z6MkSubject";
const TRUSTED = "did:key:z6MkTrusted";
const FORGER = "did:key:z6MkForger";
const trusted = (did: string) => (did === TRUSTED ? 0.9 : 0.1);

function rep(issuer: string, signer: string | undefined): ReputationVC {
  const now = Date.now();
  return {
    type: ["VerifiableCredential", "AgentReputationCredential"],
    issuer,
    credentialSubject: {
      id: SUBJECT,
      success_rate: 1,
      avg_latency_ms: 1,
      task_count: 50,
      trust_score: 1,
      availability: 1,
      sample_size: 50,
      measured_at: now,
    },
    validFrom: new Date(now).toISOString(),
    ...(signer !== undefined ? { proof: { verificationMethod: `${signer}#k` } } : {}),
  };
}

function trust(issuer: string, signer: string | undefined): TrustVC {
  const now = Date.now();
  return {
    type: ["VerifiableCredential", "AgentTrustCredential"],
    issuer,
    credentialSubject: {
      id: SUBJECT,
      trust_level: "trusted",
      interaction_count: 1,
      successful_tasks: 1,
      failed_tasks: 0,
      first_seen_at: now,
      last_seen_at: now,
      hardware_attestation: { platform: "secure_enclave" },
    },
    validFrom: new Date(now).toISOString(),
    ...(signer !== undefined ? { proof: { verificationMethod: `${signer}#k` } } : {}),
  };
}

describe("stored credentials count only when the signer is the issuer", () => {
  it("an honest credential (signer = issuer) carries weight", () => {
    expect(aggregateCredentialReputation([rep(TRUSTED, TRUSTED)], trusted)).not.toBeNull();
    expect(aggregateHardwareAttestation([trust(TRUSTED, TRUSTED)], trusted)).not.toBeNull();
  });

  it("a forged reputation credential (signed by another key) carries none", () => {
    expect(aggregateCredentialReputation([rep(TRUSTED, FORGER)], trusted)).toBeNull();
  });

  it("a forged hardware-attestation credential carries none", () => {
    expect(aggregateHardwareAttestation([trust(TRUSTED, FORGER)], trusted)).toBeNull();
  });

  it("a credential with no proof carries none", () => {
    expect(aggregateCredentialReputation([rep(TRUSTED, undefined)], trusted)).toBeNull();
  });

  it("boundIssuerDid reads the DID before '#', exactly", () => {
    expect(boundIssuerDid({ issuer: TRUSTED, proof: { verificationMethod: `${TRUSTED}#x` } })).toBe(
      TRUSTED,
    );
    expect(
      boundIssuerDid({ issuer: { id: TRUSTED }, proof: { verificationMethod: TRUSTED } }),
    ).toBe(TRUSTED);
    expect(
      boundIssuerDid({
        issuer: TRUSTED,
        proof: { verificationMethod: `${TRUSTED.toUpperCase()}#x` },
      }),
    ).toBeUndefined();
    expect(boundIssuerDid({ issuer: TRUSTED, proof: { verificationMethod: 42 } })).toBeUndefined();
  });
});
