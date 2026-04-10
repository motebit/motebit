import { describe, it, expect } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { verify } from "../index";
import type {
  VerifiableCredential,
  VerifiablePresentation,
  DataIntegrityProof,
  CredentialVerifyResult,
  PresentationVerifyResult,
} from "../index";

if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value = value * 256n + BigInt(bytes[i]!);
  }
  let result = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    value = value / 58n;
    result = BASE58_ALPHABET[remainder]! + result;
  }
  return BASE58_ALPHABET[0]!.repeat(zeros) + result;
}

function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const entries: string[] = [];
  for (const key of sorted) {
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined) continue;
    entries.push(JSON.stringify(key) + ":" + canonicalJson(val));
  }
  return "{" + entries.join(",") + "}";
}

async function makeKeypair() {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, publicKeyHex: toHex(publicKey) };
}

function publicKeyToDidKey(pubKey: Uint8Array): string {
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(pubKey, 2);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

function buildVerificationMethod(publicKey: Uint8Array): string {
  const did = publicKeyToDidKey(publicKey);
  const fragment = did.slice("did:key:".length);
  return `${did}#${fragment}`;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

async function signDataIntegrity(
  document: Record<string, unknown>,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  proofPurpose: "assertionMethod" | "authentication",
): Promise<DataIntegrityProof> {
  const verificationMethod = buildVerificationMethod(publicKey);
  const created = new Date().toISOString();

  const proofOptions = {
    type: "DataIntegrityProof" as const,
    cryptosuite: "eddsa-jcs-2022" as const,
    created,
    verificationMethod,
    proofPurpose,
  };

  const encoder = new TextEncoder();
  const proofHash = await sha256(encoder.encode(canonicalJson(proofOptions)));
  const { proof: _proof, ...docWithoutProof } = document;
  const docHash = await sha256(encoder.encode(canonicalJson(docWithoutProof)));

  const combined = new Uint8Array(proofHash.length + docHash.length);
  combined.set(proofHash);
  combined.set(docHash, proofHash.length);

  const signature = await ed.signAsync(combined, privateKey);
  const proofValue = "z" + base58btcEncode(signature);

  return { ...proofOptions, proofValue };
}

async function makeSignedCredential(
  kp: Awaited<ReturnType<typeof makeKeypair>>,
  overrides?: Partial<VerifiableCredential>,
): Promise<VerifiableCredential> {
  const issuerDid = publicKeyToDidKey(kp.publicKey);
  const now = new Date();

  const unsignedVC: Omit<VerifiableCredential, "proof"> = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", "AgentReputationCredential"],
    issuer: issuerDid,
    credentialSubject: {
      id: issuerDid,
      success_rate: 0.95,
      task_count: 42,
    },
    validFrom: now.toISOString(),
    validUntil: new Date(now.getTime() + 3600000).toISOString(),
    ...overrides,
  };

  const proof = await signDataIntegrity(
    unsignedVC as unknown as Record<string, unknown>,
    kp.privateKey,
    kp.publicKey,
    "assertionMethod",
  );

  return { ...unsignedVC, proof };
}

// ---------------------------------------------------------------------------
// Verifiable Credential verification
// ---------------------------------------------------------------------------

describe("verify — verifiable credentials", () => {
  it("verifies a correctly signed credential", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(true);

    const r = result as CredentialVerifyResult;
    expect(r.credential).not.toBeNull();
    expect(r.issuer).toMatch(/^did:key:z/);
    expect(r.subject).toMatch(/^did:key:z/);
    expect(r.expired).toBe(false);
    expect(r.errors).toBeUndefined();
  });

  it("verifies credential passed as JSON string", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    const result = await verify(JSON.stringify(vc));
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(true);
  });

  it("fails on tampered credential", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    // Tamper: change subject data
    vc.credentialSubject.success_rate = 1.0;

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(false);
    expect(result.errors![0]!.message).toContain("proof verification failed");
  });

  it("fails on expired credential", async () => {
    const kp = await makeKeypair();
    const past = new Date(Date.now() - 7200000); // 2 hours ago
    const vc = await makeSignedCredential(kp, {
      validFrom: new Date(Date.now() - 7200000).toISOString(),
      validUntil: past.toISOString(),
    });

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(false);

    const r = result as CredentialVerifyResult;
    expect(r.expired).toBe(true);
  });

  it("tolerates clock skew within grace period (default 60s)", async () => {
    const kp = await makeKeypair();
    // Expired 30 seconds ago — within the 60s default grace period
    const vc = await makeSignedCredential(kp, {
      validFrom: new Date(Date.now() - 7200000).toISOString(),
      validUntil: new Date(Date.now() - 30000).toISOString(),
    });

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(true);

    const r = result as CredentialVerifyResult;
    expect(r.expired).toBe(false);
  });

  it("rejects expired credential beyond grace period", async () => {
    const kp = await makeKeypair();
    // Expired 2 minutes ago — beyond the 60s default grace period
    const vc = await makeSignedCredential(kp, {
      validFrom: new Date(Date.now() - 7200000).toISOString(),
      validUntil: new Date(Date.now() - 120000).toISOString(),
    });

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(false);

    const r = result as CredentialVerifyResult;
    expect(r.expired).toBe(true);
  });

  it("respects custom clockSkewSeconds option", async () => {
    const kp = await makeKeypair();
    // Expired 90 seconds ago — beyond default 60s but within custom 120s
    const vc = await makeSignedCredential(kp, {
      validFrom: new Date(Date.now() - 7200000).toISOString(),
      validUntil: new Date(Date.now() - 90000).toISOString(),
    });

    // Fails with default grace
    const r1 = await verify(vc);
    expect(r1.valid).toBe(false);

    // Passes with extended grace
    const r2 = await verify(vc, { clockSkewSeconds: 120 });
    expect(r2.valid).toBe(true);
  });

  it("respects expectedType option", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    const r1 = await verify(vc, { expectedType: "credential" });
    expect(r1.valid).toBe(true);

    const r2 = await verify(vc, { expectedType: "receipt" });
    expect(r2.valid).toBe(false);
    expect(r2.errors![0]!.message).toContain("Expected type");
  });
});

// ---------------------------------------------------------------------------
// Verifiable Presentation verification
// ---------------------------------------------------------------------------

describe("verify — verifiable presentations", () => {
  it("verifies a correctly signed presentation with one credential", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    const holderDid = publicKeyToDidKey(kp.publicKey);
    const unsignedVP: Omit<VerifiablePresentation, "proof"> = {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiablePresentation"],
      holder: holderDid,
      verifiableCredential: [vc],
    };

    const proof = await signDataIntegrity(
      unsignedVP as unknown as Record<string, unknown>,
      kp.privateKey,
      kp.publicKey,
      "authentication",
    );
    const vp: VerifiablePresentation = { ...unsignedVP, proof };

    const result = await verify(vp);
    expect(result.type).toBe("presentation");
    expect(result.valid).toBe(true);

    const r = result as PresentationVerifyResult;
    expect(r.holder).toBe(holderDid);
    expect(r.credentials).toHaveLength(1);
    expect(r.credentials![0]!.valid).toBe(true);
    expect(r.errors).toBeUndefined();
  });

  it("fails when VP envelope is tampered", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    const holderDid = publicKeyToDidKey(kp.publicKey);
    const unsignedVP: Omit<VerifiablePresentation, "proof"> = {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiablePresentation"],
      holder: holderDid,
      verifiableCredential: [vc],
    };

    const proof = await signDataIntegrity(
      unsignedVP as unknown as Record<string, unknown>,
      kp.privateKey,
      kp.publicKey,
      "authentication",
    );
    const vp: VerifiablePresentation = { ...unsignedVP, proof };

    // Tamper: change holder
    vp.holder = "did:key:zTAMPERED";

    const result = await verify(vp);
    expect(result.type).toBe("presentation");
    expect(result.valid).toBe(false);
    expect(result.errors![0]!.message).toContain("Presentation proof");
  });

  it("fails when a contained credential is invalid", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    // Tamper the credential before wrapping in VP
    vc.credentialSubject.success_rate = 0.5;

    const holderDid = publicKeyToDidKey(kp.publicKey);
    const unsignedVP: Omit<VerifiablePresentation, "proof"> = {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiablePresentation"],
      holder: holderDid,
      verifiableCredential: [vc],
    };

    const proof = await signDataIntegrity(
      unsignedVP as unknown as Record<string, unknown>,
      kp.privateKey,
      kp.publicKey,
      "authentication",
    );
    const vp: VerifiablePresentation = { ...unsignedVP, proof };

    const result = await verify(vp);
    expect(result.type).toBe("presentation");
    expect(result.valid).toBe(false);

    const r = result as PresentationVerifyResult;
    expect(r.credentials![0]!.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyDataIntegrity edge cases (exercised via verify())
// ---------------------------------------------------------------------------

describe("verify — data integrity proof edge cases", () => {
  it("fails when proof type is not DataIntegrityProof", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    // Replace the proof type with something wrong
    (vc.proof as Record<string, unknown>).type = "WrongProofType";

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(false);

    const r = result as CredentialVerifyResult;
    expect(r.errors![0]!.message).toContain("proof verification failed");
  });

  it("fails when proof cryptosuite is not eddsa-jcs-2022", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    // Replace the cryptosuite with something wrong
    (vc.proof as Record<string, unknown>).cryptosuite = "wrong-suite";

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(false);

    const r = result as CredentialVerifyResult;
    expect(r.errors![0]!.message).toContain("proof verification failed");
  });

  it("fails when verificationMethod has an invalid did:key", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    // Replace the verificationMethod with an invalid DID
    vc.proof.verificationMethod = "not-a-did:key:z123#z123";

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(false);

    const r = result as CredentialVerifyResult;
    expect(r.errors![0]!.message).toContain("proof verification failed");
  });

  it("fails when verificationMethod has a did:key with wrong multicodec prefix", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    // Build a did:key with wrong prefix bytes (0x00, 0x00 instead of 0xed, 0x01)
    const wrongPrefix = new Uint8Array(34);
    wrongPrefix[0] = 0x00;
    wrongPrefix[1] = 0x00;
    wrongPrefix.set(kp.publicKey, 2);
    const wrongDid = `did:key:z${base58btcEncode(wrongPrefix)}`;
    vc.proof.verificationMethod = `${wrongDid}#${wrongDid.slice("did:key:".length)}`;

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(false);
  });

  it("fails when proofValue is missing the 'z' multibase prefix", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    // Remove the "z" prefix from proofValue
    vc.proof.proofValue = vc.proof.proofValue.slice(1);

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(false);

    const r = result as CredentialVerifyResult;
    expect(r.errors![0]!.message).toContain("proof verification failed");
  });

  it("fails when proofValue has invalid base58btc content after 'z'", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    // Set proofValue to "z" followed by invalid base58 characters
    vc.proof.proofValue = "z!!!invalid-base58!!!";

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(false);
  });

  it("verifies the full data integrity proof path on a valid credential", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(true);

    const r = result as CredentialVerifyResult;
    expect(r.issuer).toMatch(/^did:key:z/);
    expect(r.subject).toMatch(/^did:key:z/);
    expect(r.errors).toBeUndefined();
  });

  it("fails when did:key decodes to wrong number of bytes (not 34)", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    // Build a did:key that decodes to only 10 bytes (not 34)
    const shortBytes = new Uint8Array(10);
    const wrongDid = `did:key:z${base58btcEncode(shortBytes)}`;
    vc.proof.verificationMethod = `${wrongDid}#${wrongDid.slice("did:key:".length)}`;

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(false);
  });

  it("verifies presentation passed as JSON string", async () => {
    const kp = await makeKeypair();
    const vc = await makeSignedCredential(kp);

    const holderDid = publicKeyToDidKey(kp.publicKey);
    const unsignedVP: Omit<VerifiablePresentation, "proof"> = {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiablePresentation"],
      holder: holderDid,
      verifiableCredential: [vc],
    };

    const proof = await signDataIntegrity(
      unsignedVP as unknown as Record<string, unknown>,
      kp.privateKey,
      kp.publicKey,
      "authentication",
    );
    const vp: VerifiablePresentation = { ...unsignedVP, proof };

    const result = await verify(JSON.stringify(vp));
    expect(result.type).toBe("presentation");
    expect(result.valid).toBe(true);

    const r = result as PresentationVerifyResult;
    expect(r.holder).toBe(holderDid);
    expect(r.credentials).toHaveLength(1);
  });
});
