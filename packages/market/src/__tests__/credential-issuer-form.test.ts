/**
 * The aggregators read the issuer a credential names in both W3C forms
 * (`issuer` string or `{ id }`), so the self-attestation filter and the issuer
 * trust lookup see the same DID the verifier bound to the proof's signer.
 * Reading only the string form let `{ id: <subject> }` pass the self-attestation
 * filter and be weighted by whatever `getIssuerTrust` returns for an object.
 */
import { describe, it, expect } from "vitest";
import {
  aggregateCredentialReputation,
  aggregateHardwareAttestation,
} from "../credential-weight.js";
import type { ReputationVC, TrustVC } from "../credential-weight.js";

const SUBJECT = "did:key:z6MkSubject";
const TRUSTED = "did:key:z6MkTrusted";

/** The DID a signer of this issuer would use: the issuer's own DID. */
function signerOf(issuer: unknown): string {
  if (typeof issuer === "string") return issuer;
  const id = (issuer as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : "did:key:z6MkUnresolvable";
}

function rep(issuer: unknown): ReputationVC {
  const now = Date.now();
  return {
    type: ["VerifiableCredential", "AgentReputationCredential"],
    issuer: issuer as string,
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
    proof: { verificationMethod: `${signerOf(issuer)}#key-1` },
  };
}

function trust(issuer: unknown): TrustVC {
  const now = Date.now();
  return {
    type: ["VerifiableCredential", "AgentTrustCredential"],
    issuer: issuer as string,
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
    proof: { verificationMethod: `${signerOf(issuer)}#key-1` },
  };
}

// Trusts every issuer it is asked about, including a non-string one: the
// aggregator must not reach it with anything but a DID string.
const trustsEverything = (_did: unknown) => 1;

describe("issuer form in credential aggregation", () => {
  it("filters a self-issued credential whose issuer is the object form {id: subject}", () => {
    expect(aggregateCredentialReputation([rep({ id: SUBJECT })], trustsEverything)).toBeNull();
    expect(aggregateHardwareAttestation([trust({ id: SUBJECT })], trustsEverything)).toBeNull();
  });

  it("gives no weight to a credential whose issuer names no DID", () => {
    for (const issuer of [{}, { id: 7 }, null, ""]) {
      expect(aggregateCredentialReputation([rep(issuer)], trustsEverything)).toBeNull();
      expect(aggregateHardwareAttestation([trust(issuer)], trustsEverything)).toBeNull();
    }
  });

  it("weights the object form {id: T} exactly as the string form T, by T's DID", () => {
    const seen: unknown[] = [];
    const byDid = (did: string) => {
      seen.push(did);
      return did === TRUSTED ? 1 : 0;
    };
    const asObject = aggregateCredentialReputation([rep({ id: TRUSTED })], byDid);
    const asString = aggregateCredentialReputation([rep(TRUSTED)], byDid);
    expect(asObject?.total_weight).toBeGreaterThan(0);
    expect(asObject?.total_weight).toBeCloseTo(asString!.total_weight, 6);
    expect(seen.every((d) => d === TRUSTED)).toBe(true);
  });
});
