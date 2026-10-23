/**
 * Issuer binding — a credential's `issuer` must be the party whose key signed it.
 *
 * Integrity (the proof verifies under the key `proof.verificationMethod` names)
 * is not authorization (that key speaks for `issuer`). A verifier that checks
 * only the first lets any key holder name any issuer. These tests pin the
 * binding at every verify door in this package:
 *
 *   - `verifyVerifiableCredential` (credentials.ts)
 *   - `verifyVerifiablePresentation` — the envelope's `holder` and every
 *     contained credential's `issuer`
 *   - `verify()` — the credential and presentation branches (index.ts)
 *
 * Rule: the DID part of `proof.verificationMethod` (before `#`) must equal the
 * issuer's DID (`issuer` as a string, or `issuer.id`). For `did:key` that is
 * exact equality, after which the key is derived from the DID. An issuer whose
 * DID method this verifier cannot resolve to the signing key fails closed.
 */
import { describe, it, expect } from "vitest";
import { generateKeypair, publicKeyToDidKey, verify } from "../index.js";
import {
  signVerifiableCredential,
  signVerifiablePresentation,
  verifyVerifiableCredential,
  verifyVerifiablePresentation,
  createPresentation,
  issueReputationCredential,
} from "../credentials.js";
import type { VerifiableCredential } from "../credentials.js";

async function parties() {
  const a = await generateKeypair(); // the named issuer (trusted)
  const b = await generateKeypair(); // the actual signer
  return { a, b, didA: publicKeyToDidKey(a.publicKey), didB: publicKeyToDidKey(b.publicKey) };
}

function unsigned(issuer: unknown, subjectId: string): Omit<VerifiableCredential, "proof"> {
  const now = Date.now();
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", "AgentReputationCredential"],
    issuer: issuer as string,
    credentialSubject: {
      id: subjectId,
      success_rate: 1,
      avg_latency_ms: 10,
      task_count: 50,
      trust_score: 1,
      availability: 1,
      sample_size: 50,
      measured_at: now,
    },
    validFrom: new Date(now - 1000).toISOString(),
    validUntil: new Date(now + 3_600_000).toISOString(),
  };
}

describe("credential issuer binding", () => {
  it("refuses a credential naming issuer A but signed by B (verifyVerifiableCredential)", async () => {
    const { b, didA, didB } = await parties();
    const forged = await signVerifiableCredential(unsigned(didA, didB), b.privateKey, b.publicKey);
    expect(forged.proof.verificationMethod.startsWith(didB)).toBe(true);
    expect(await verifyVerifiableCredential(forged)).toBe(false);
  });

  it("refuses the same forgery through verify()", async () => {
    const { b, didA, didB } = await parties();
    const forged = await signVerifiableCredential(unsigned(didA, didB), b.privateKey, b.publicKey);
    const r = await verify(forged);
    expect(r.type).toBe("credential");
    expect(r.valid).toBe(false);
  });

  it("refuses an object issuer {id: A} signed by B, and accepts {id: B} signed by B", async () => {
    const { b, didA, didB } = await parties();
    const forged = await signVerifiableCredential(
      unsigned({ id: didA }, didB),
      b.privateKey,
      b.publicKey,
    );
    expect(await verifyVerifiableCredential(forged)).toBe(false);
    expect((await verify(forged)).valid).toBe(false);

    const honest = await signVerifiableCredential(
      unsigned({ id: didB, name: "B" }, didA),
      b.privateKey,
      b.publicKey,
    );
    expect(await verifyVerifiableCredential(honest)).toBe(true);
    const r = await verify(honest);
    expect(r.valid).toBe(true);
    if (r.type === "credential") expect(r.issuer).toBe(didB);
  });

  it("fails closed on an issuer DID method the verifier cannot resolve", async () => {
    const { b, didA } = await parties();
    for (const issuer of ["did:web:issuer.example", "did:motebit:someone", "", { id: 7 }, null]) {
      const vc = await signVerifiableCredential(unsigned(issuer, didA), b.privateKey, b.publicKey);
      expect(await verifyVerifiableCredential(vc)).toBe(false);
      expect((await verify(vc)).valid).toBe(false);
    }
  });

  it("refuses a verificationMethod whose DID differs from the issuer even by suffix", async () => {
    const { b, didB } = await parties();
    for (const issuer of [`${didB}x`, `${didB}#key-1`, didB.toUpperCase(), ` ${didB}`]) {
      const vc = await signVerifiableCredential(unsigned(issuer, didB), b.privateKey, b.publicKey);
      expect(await verifyVerifiableCredential(vc)).toBe(false);
      expect((await verify(vc)).valid).toBe(false);
    }
  });

  it("still accepts first-party issuance (issuer derived from the signing key)", async () => {
    const { a, didB } = await parties();
    const vc = await issueReputationCredential(
      {
        success_rate: 1,
        avg_latency_ms: 1,
        task_count: 1,
        trust_score: 1,
        availability: 1,
        measured_at: Date.now(),
      },
      a.privateKey,
      a.publicKey,
      didB,
    );
    expect(await verifyVerifiableCredential(vc)).toBe(true);
    expect((await verify(vc)).valid).toBe(true);
  });
});

describe("presentation issuer and holder binding", () => {
  it("refuses a presentation containing a forged-issuer credential", async () => {
    const { b, didA, didB } = await parties();
    const forged = await signVerifiableCredential(unsigned(didA, didB), b.privateKey, b.publicKey);
    const vp = await createPresentation([forged], b.privateKey, b.publicKey);

    const r1 = await verifyVerifiablePresentation(vp);
    expect(r1.valid).toBe(false);

    const r2 = await verify(vp);
    expect(r2.type).toBe("presentation");
    expect(r2.valid).toBe(false);
    if (r2.type === "presentation") expect(r2.credentials?.[0]?.valid).toBe(false);
  });

  it("refuses a presentation whose holder is A but whose envelope is signed by B", async () => {
    const { a, b, didA, didB } = await parties();
    const honestVc = await signVerifiableCredential(
      unsigned(didA, didB),
      a.privateKey,
      a.publicKey,
    );
    const vp = await signVerifiablePresentation(
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["VerifiablePresentation"],
        holder: didA,
        verifiableCredential: [honestVc],
      },
      b.privateKey,
      b.publicKey,
    );
    expect((await verifyVerifiablePresentation(vp)).valid).toBe(false);
    expect((await verify(vp)).valid).toBe(false);
  });

  it("accepts an honest presentation (holder = signer, issuer = signer)", async () => {
    const { a, b, didA, didB } = await parties();
    const vc = await signVerifiableCredential(unsigned(didA, didB), a.privateKey, a.publicKey);
    const vp = await createPresentation([vc], b.privateKey, b.publicKey);
    expect((await verifyVerifiablePresentation(vp)).valid).toBe(true);
    expect((await verify(vp)).valid).toBe(true);
  });
});
