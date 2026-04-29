import { describe, it, expect, beforeEach } from "vitest";
import { hexPublicKeyToDidKey, generateKeypair, bytesToHex } from "@motebit/encryption";
import { AgentTrustLevel, asMotebitId } from "@motebit/sdk";
import type { CredentialStoreAdapter, StoredCredential, AgentTrustRecord } from "@motebit/sdk";
import { readLatestHardwareAttestationClaim } from "../hardware-attestation-projection.js";

class InMemoryCredentialStore implements CredentialStoreAdapter {
  rows: StoredCredential[] = [];
  save(credential: StoredCredential): void {
    this.rows.unshift(credential);
  }
  listBySubject(subjectMotebitId: string, limit = 100): StoredCredential[] {
    return this.rows.filter((r) => r.subject_motebit_id === subjectMotebitId).slice(0, limit);
  }
  list(motebitId: string, type?: string, limit = 100): StoredCredential[] {
    let m = this.rows.filter(
      (r) => r.subject_motebit_id.includes(motebitId) || r.issuer_did.includes(motebitId),
    );
    if (type) m = m.filter((r) => r.credential_type === type);
    return m.slice(0, limit);
  }
}

function trustVcJson(opts: {
  subjectDid: string;
  platform: string;
  key_exported?: boolean;
  issued_at?: number;
}): string {
  return JSON.stringify({
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", "AgentTrustCredential"],
    issuer: "did:key:z-issuer-test",
    validFrom: new Date(opts.issued_at ?? Date.now()).toISOString(),
    credentialSubject: {
      id: opts.subjectDid,
      trust_level: "verified",
      interaction_count: 1,
      successful_tasks: 1,
      failed_tasks: 0,
      first_seen_at: 0,
      last_seen_at: 0,
      hardware_attestation: { platform: opts.platform, key_exported: opts.key_exported },
    },
    proof: {},
  });
}

function makeRecord(opts: { remote_motebit_id: string; public_key?: string }): AgentTrustRecord {
  return {
    motebit_id: asMotebitId("self"),
    remote_motebit_id: asMotebitId(opts.remote_motebit_id),
    trust_level: AgentTrustLevel.Verified,
    public_key: opts.public_key,
    first_seen_at: 0,
    last_seen_at: 0,
    interaction_count: 1,
  };
}

describe("readLatestHardwareAttestationClaim", () => {
  let store: InMemoryCredentialStore;

  beforeEach(() => {
    store = new InMemoryCredentialStore();
  });

  it("returns null when no credential is stored for the subject", () => {
    const record = makeRecord({ remote_motebit_id: "m-unknown" });
    expect(readLatestHardwareAttestationClaim(store, record)).toBeNull();
  });

  it("projects the most-recent credential keyed by hexPublicKeyToDidKey(public_key)", async () => {
    const kp = await generateKeypair();
    const publicHex = bytesToHex(kp.publicKey);
    const subjectDid = hexPublicKeyToDidKey(publicHex);

    store.save({
      credential_id: "cred-1",
      subject_motebit_id: subjectDid,
      issuer_did: "did:key:z-issuer-test",
      credential_type: "AgentTrustCredential",
      credential_json: trustVcJson({ subjectDid, platform: "secure_enclave", issued_at: 1000 }),
      issued_at: 1000,
    });

    const record = makeRecord({ remote_motebit_id: "m-peer", public_key: publicHex });
    const proj = readLatestHardwareAttestationClaim(store, record);
    expect(proj).toEqual({ platform: "secure_enclave", key_exported: undefined, score: 1 });
  });

  it("falls back to did:motebit:<id> when public_key is absent", () => {
    const subjectDid = "did:motebit:m-fallback";
    store.save({
      credential_id: "cred-fb",
      subject_motebit_id: subjectDid,
      issuer_did: "did:key:z-issuer-test",
      credential_type: "AgentTrustCredential",
      credential_json: trustVcJson({ subjectDid, platform: "tpm" }),
      issued_at: 1000,
    });

    const record = makeRecord({ remote_motebit_id: "m-fallback" });
    const proj = readLatestHardwareAttestationClaim(store, record);
    expect(proj?.platform).toBe("tpm");
    expect(proj?.score).toBe(1);
  });

  it("picks the most recent credential when multiple are stored under the same subject", async () => {
    const kp = await generateKeypair();
    const publicHex = bytesToHex(kp.publicKey);
    const subjectDid = hexPublicKeyToDidKey(publicHex);

    store.save({
      credential_id: "cred-old",
      subject_motebit_id: subjectDid,
      issuer_did: "did:key:z-issuer-test",
      credential_type: "AgentTrustCredential",
      credential_json: trustVcJson({ subjectDid, platform: "software", issued_at: 500 }),
      issued_at: 500,
    });
    store.save({
      credential_id: "cred-new",
      subject_motebit_id: subjectDid,
      issuer_did: "did:key:z-issuer-test",
      credential_type: "AgentTrustCredential",
      credential_json: trustVcJson({ subjectDid, platform: "secure_enclave", issued_at: 1500 }),
      issued_at: 1500,
    });

    const record = makeRecord({ remote_motebit_id: "m-newer", public_key: publicHex });
    const proj = readLatestHardwareAttestationClaim(store, record);
    expect(proj?.platform).toBe("secure_enclave");
    expect(proj?.score).toBe(1);
  });

  it("ignores reputation credentials — only AgentTrustCredentials contribute", async () => {
    const kp = await generateKeypair();
    const publicHex = bytesToHex(kp.publicKey);
    const subjectDid = hexPublicKeyToDidKey(publicHex);

    store.save({
      credential_id: "cred-rep",
      subject_motebit_id: subjectDid,
      issuer_did: "did:key:z-issuer-test",
      credential_type: "AgentReputationCredential",
      credential_json: JSON.stringify({
        type: ["VerifiableCredential", "AgentReputationCredential"],
        credentialSubject: { id: subjectDid, hardware_attestation: { platform: "secure_enclave" } },
      }),
      issued_at: 1000,
    });

    const record = makeRecord({ remote_motebit_id: "m-rep", public_key: publicHex });
    expect(readLatestHardwareAttestationClaim(store, record)).toBeNull();
  });

  it("returns null when the stored credential has no hardware_attestation field", () => {
    const subjectDid = "did:motebit:m-nohw";
    store.save({
      credential_id: "cred-nohw",
      subject_motebit_id: subjectDid,
      issuer_did: "did:key:z-issuer-test",
      credential_type: "AgentTrustCredential",
      credential_json: JSON.stringify({
        type: ["VerifiableCredential", "AgentTrustCredential"],
        credentialSubject: { id: subjectDid, trust_level: "verified" },
      }),
      issued_at: 1000,
    });

    const record = makeRecord({ remote_motebit_id: "m-nohw" });
    expect(readLatestHardwareAttestationClaim(store, record)).toBeNull();
  });

  it("skips malformed credential_json without throwing — falls through to next candidate", () => {
    const subjectDid = "did:motebit:m-mixed";
    store.save({
      credential_id: "cred-bad",
      subject_motebit_id: subjectDid,
      issuer_did: "did:key:z-issuer-test",
      credential_type: "AgentTrustCredential",
      credential_json: "not-valid-json{",
      issued_at: 2000,
    });
    store.save({
      credential_id: "cred-good",
      subject_motebit_id: subjectDid,
      issuer_did: "did:key:z-issuer-test",
      credential_type: "AgentTrustCredential",
      credential_json: trustVcJson({ subjectDid, platform: "webauthn", issued_at: 1000 }),
      issued_at: 1000,
    });

    const record = makeRecord({ remote_motebit_id: "m-mixed" });
    const proj = readLatestHardwareAttestationClaim(store, record);
    expect(proj?.platform).toBe("webauthn");
    expect(proj?.score).toBe(1);
  });

  it("scores software-platform claims at 0.1 (truthful no-hardware sentinel)", () => {
    const subjectDid = "did:motebit:m-soft";
    store.save({
      credential_id: "cred-soft",
      subject_motebit_id: subjectDid,
      issuer_did: "did:key:z-issuer-test",
      credential_type: "AgentTrustCredential",
      credential_json: trustVcJson({ subjectDid, platform: "software" }),
      issued_at: 1000,
    });
    const record = makeRecord({ remote_motebit_id: "m-soft" });
    const proj = readLatestHardwareAttestationClaim(store, record);
    expect(proj?.platform).toBe("software");
    expect(proj?.score).toBeCloseTo(0.1);
  });

  it("scores key_exported hardware at 0.5 (binding broken once exported)", () => {
    const subjectDid = "did:motebit:m-export";
    store.save({
      credential_id: "cred-export",
      subject_motebit_id: subjectDid,
      issuer_did: "did:key:z-issuer-test",
      credential_type: "AgentTrustCredential",
      credential_json: trustVcJson({ subjectDid, platform: "secure_enclave", key_exported: true }),
      issued_at: 1000,
    });
    const record = makeRecord({ remote_motebit_id: "m-export" });
    const proj = readLatestHardwareAttestationClaim(store, record);
    expect(proj?.score).toBe(0.5);
  });
});
