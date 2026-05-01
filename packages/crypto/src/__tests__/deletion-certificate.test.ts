/**
 * Deletion certificate sign + verify tests.
 *
 * Coverage:
 *   - Each cert arm signs and verifies under the canonical signing rule.
 *   - Reason × signer × mode table admits the right combinations.
 *   - Tampering (any byte change) breaks verification.
 *   - Multi-signature certs accept commutative signing order.
 *   - Horizon arm verifies issuer + every witness against identical bytes.
 *   - Forbidden signer presence is rejected.
 *   - Mode-keyed reasons are gated when the verifier knows the mode.
 *   - Guardian binding cross-check rejects mismatched guardian keys.
 *   - Legacy unsigned cert path is covered by encryption package tests
 *     (this package only deals with the new signed union).
 */

import { describe, expect, it } from "vitest";

import type {
  DeletionCertificate,
  DeletionCertificateVerifyContext,
  HorizonSubject,
} from "@motebit/protocol";
import { asMotebitId, asNodeId } from "@motebit/protocol";

import { generateEd25519Keypair } from "../suite-dispatch.js";
import { bytesToHex } from "../signing.js";
import {
  signCertAsSubject,
  signCertAsOperator,
  signCertAsGuardian,
  signCertAsDelegate,
  signHorizonCertAsIssuer,
  signHorizonWitness,
  verifyDeletionCertificate,
  canonicalizeMultiSignatureCert,
} from "../deletion-certificate.js";

async function makeKeyPair() {
  const { publicKey, privateKey } = await generateEd25519Keypair();
  return { publicKey, privateKey };
}

function ctxOf(
  motebitKeys: Record<string, Uint8Array>,
  operatorKeys: Record<string, Uint8Array>,
  opts: Partial<DeletionCertificateVerifyContext> = {},
): DeletionCertificateVerifyContext {
  return {
    resolveMotebitPublicKey: async (id: string) => motebitKeys[id] ?? null,
    resolveOperatorPublicKey: async (id: string) => operatorKeys[id] ?? null,
    ...opts,
  };
}

const baseMutablePruning = (): Extract<DeletionCertificate, { kind: "mutable_pruning" }> => ({
  kind: "mutable_pruning",
  target_id: asNodeId("node-001"),
  sensitivity: "personal",
  reason: "user_request",
  deleted_at: 1730000000000,
});

describe("verifyDeletionCertificate — mutable_pruning arm", () => {
  it("verifies a subject-signed user_request cert", async () => {
    const subject = await makeKeyPair();
    const cert = await signCertAsSubject(
      baseMutablePruning(),
      "motebit-subject",
      subject.privateKey,
    );
    const result = await verifyDeletionCertificate(
      cert,
      ctxOf({ "motebit-subject": subject.publicKey }, {}),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.steps.subject_signature_valid).toBe(true);
  });

  it("rejects an unsigned mutable_pruning cert (no signers present)", async () => {
    const cert = baseMutablePruning();
    const result = await verifyDeletionCertificate(cert, ctxOf({}, {}));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("requires subject_signature"))).toBe(true);
  });

  it("rejects a tampered cert (sensitivity mutated)", async () => {
    const subject = await makeKeyPair();
    const cert = await signCertAsSubject(
      baseMutablePruning(),
      "motebit-subject",
      subject.privateKey,
    );
    const tampered: typeof cert = { ...cert, sensitivity: "secret" };
    const result = await verifyDeletionCertificate(
      tampered,
      ctxOf({ "motebit-subject": subject.publicKey }, {}),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("subject_signature invalid"))).toBe(true);
  });

  it("verifies a co-signed retention_enforcement cert (operator required + subject optional)", async () => {
    const subject = await makeKeyPair();
    const operator = await makeKeyPair();
    let cert = baseMutablePruning();
    cert = { ...cert, reason: "retention_enforcement" };
    cert = await signCertAsSubject(cert, "motebit-subject", subject.privateKey);
    cert = await signCertAsOperator(cert, "operator-A", operator.privateKey);

    const result = await verifyDeletionCertificate(
      cert,
      ctxOf({ "motebit-subject": subject.publicKey }, { "operator-A": operator.publicKey }),
    );
    expect(result.valid).toBe(true);
    expect(result.steps.subject_signature_valid).toBe(true);
    expect(result.steps.operator_signature_valid).toBe(true);
  });

  it("commutative signing — operator-then-subject and subject-then-operator produce identical signatures", async () => {
    const subject = await makeKeyPair();
    const operator = await makeKeyPair();
    const seed = { ...baseMutablePruning(), reason: "retention_enforcement" as const };

    let a = await signCertAsSubject(seed, "m", subject.privateKey);
    a = await signCertAsOperator(a, "op", operator.privateKey);

    let b = await signCertAsOperator(seed, "op", operator.privateKey);
    b = await signCertAsSubject(b, "m", subject.privateKey);

    expect(a.subject_signature?.signature).toBe(b.subject_signature?.signature);
    expect(a.operator_signature?.signature).toBe(b.operator_signature?.signature);
  });

  it("rejects operator_request with subject_signature present (forbidden)", async () => {
    const subject = await makeKeyPair();
    const operator = await makeKeyPair();
    let cert = { ...baseMutablePruning(), reason: "operator_request" as const };
    cert = await signCertAsOperator(cert, "operator-A", operator.privateKey);
    cert = await signCertAsSubject(cert, "motebit-subject", subject.privateKey);

    const result = await verifyDeletionCertificate(
      cert,
      ctxOf({ "motebit-subject": subject.publicKey }, { "operator-A": operator.publicKey }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("forbids subject_signature"))).toBe(true);
  });

  it("verifies a guardian_request cert and rejects mismatched guardian binding", async () => {
    const guardian = await makeKeyPair();
    const cert = await signCertAsGuardian(
      { ...baseMutablePruning(), reason: "guardian_request" as const },
      guardian.publicKey,
      guardian.privateKey,
    );

    // Without binding-check: verifies on the embedded key.
    const okResult = await verifyDeletionCertificate(cert, ctxOf({}, {}));
    expect(okResult.valid).toBe(true);
    expect(okResult.steps.guardian_signature_valid).toBe(true);

    // With binding-check that returns false: rejected.
    const failResult = await verifyDeletionCertificate(
      cert,
      ctxOf({}, {}, { validateGuardianBinding: async () => false }),
    );
    expect(failResult.valid).toBe(false);
    expect(failResult.errors.some((e) => e.includes("not bound to subject"))).toBe(true);

    // With binding-check that returns true: accepted.
    const checkResult = await verifyDeletionCertificate(
      cert,
      ctxOf({}, {}, { validateGuardianBinding: async () => true }),
    );
    expect(checkResult.valid).toBe(true);
  });

  it("verifies a delegated_request cert", async () => {
    const delegate = await makeKeyPair();
    const cert = await signCertAsDelegate(
      { ...baseMutablePruning(), reason: "delegated_request" as const },
      "motebit-delegate",
      "delegation-receipt-001",
      delegate.privateKey,
    );
    const result = await verifyDeletionCertificate(
      cert,
      ctxOf({ "motebit-delegate": delegate.publicKey }, {}),
    );
    expect(result.valid).toBe(true);
    expect(result.steps.delegate_signature_valid).toBe(true);
  });

  it("self_enforcement is admitted in every deployment mode (subject's runtime drives policy)", async () => {
    const subject = await makeKeyPair();
    const cert = await signCertAsSubject(
      { ...baseMutablePruning(), reason: "self_enforcement" as const },
      "motebit-subject",
      subject.privateKey,
    );
    const motebitKeys = { "motebit-subject": subject.publicKey };

    for (const mode of ["sovereign", "mediated", "enterprise"] as const) {
      const result = await verifyDeletionCertificate(
        cert,
        ctxOf(motebitKeys, {}, { deploymentMode: mode }),
      );
      expect(result.valid, `self_enforcement should be admitted in mode=${mode}`).toBe(true);
    }
  });

  it("self_enforcement still rejects an operator_signature (forbidden for this reason)", async () => {
    const subject = await makeKeyPair();
    const operator = await makeKeyPair();
    let cert = { ...baseMutablePruning(), reason: "self_enforcement" as const };
    cert = await signCertAsSubject(cert, "motebit-subject", subject.privateKey);
    cert = await signCertAsOperator(cert, "operator-A", operator.privateKey);

    const result = await verifyDeletionCertificate(
      cert,
      ctxOf({ "motebit-subject": subject.publicKey }, { "operator-A": operator.publicKey }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("forbids operator_signature"))).toBe(true);
  });
});

describe("verifyDeletionCertificate — append_only_horizon arm", () => {
  const subject: HorizonSubject = { kind: "operator", operator_id: "op-A" };

  it("verifies issuer-only horizon (no witnesses)", async () => {
    const operator = await makeKeyPair();
    const cert = await signHorizonCertAsIssuer(
      {
        kind: "append_only_horizon",
        subject,
        store_id: "event-log",
        horizon_ts: 1700000000000,
        witnessed_by: [],
        issued_at: 1730000000000,
      },
      operator.privateKey,
    );
    const result = await verifyDeletionCertificate(cert, ctxOf({}, { "op-A": operator.publicKey }));
    expect(result.valid).toBe(true);
    expect(result.steps.horizon_issuer_signature_valid).toBe(true);
    expect(result.steps.horizon_witnesses_valid_count).toBe(0);
  });

  it("verifies issuer + every witness — witnesses co-sign asynchronously", async () => {
    const operator = await makeKeyPair();
    const w1 = await makeKeyPair();
    const w2 = await makeKeyPair();

    // Witnesses sign the body MINUS witnessed_by, so they don't need to
    // know each other's signatures. The signing payload is independent
    // of which other witnesses end up in the array.
    const witnessSigningBase = {
      kind: "append_only_horizon" as const,
      subject,
      store_id: "event-log",
      horizon_ts: 1700000000000,
      witnessed_by: [],
      issued_at: 1730000000000,
      suite: "motebit-jcs-ed25519-b64-v1" as const,
      signature: "",
    };
    const w1Sig = await signHorizonWitness(witnessSigningBase, "motebit-w1", w1.privateKey);
    const w2Sig = await signHorizonWitness(witnessSigningBase, "motebit-w2", w2.privateKey);

    // Issuer signs the FULL body including the assembled witness array.
    const cert = await signHorizonCertAsIssuer(
      {
        kind: "append_only_horizon",
        subject,
        store_id: "event-log",
        horizon_ts: 1700000000000,
        witnessed_by: [w1Sig, w2Sig],
        issued_at: 1730000000000,
      },
      operator.privateKey,
    );

    const result = await verifyDeletionCertificate(
      cert,
      ctxOf(
        { "motebit-w1": w1.publicKey, "motebit-w2": w2.publicKey },
        { "op-A": operator.publicKey },
      ),
    );
    expect(result.valid).toBe(true);
    expect(result.steps.horizon_issuer_signature_valid).toBe(true);
    expect(result.steps.horizon_witnesses_valid_count).toBe(2);
    expect(result.steps.horizon_witnesses_present_count).toBe(2);
  });

  it("issuer signature catches a substituted witness — body the issuer signed no longer matches", async () => {
    const operator = await makeKeyPair();
    const real = await makeKeyPair();
    const attacker = await makeKeyPair();
    const witnessBase = {
      kind: "append_only_horizon" as const,
      subject,
      store_id: "event-log",
      horizon_ts: 1700000000000,
      witnessed_by: [],
      issued_at: 1730000000000,
      suite: "motebit-jcs-ed25519-b64-v1" as const,
      signature: "",
    };
    const realSig = await signHorizonWitness(witnessBase, "motebit-real", real.privateKey);
    const attackerSig = await signHorizonWitness(
      witnessBase,
      "motebit-attacker",
      attacker.privateKey,
    );

    // Issuer signs cert with `realSig` only.
    const cert = await signHorizonCertAsIssuer(
      {
        kind: "append_only_horizon",
        subject,
        store_id: "event-log",
        horizon_ts: 1700000000000,
        witnessed_by: [realSig],
        issued_at: 1730000000000,
      },
      operator.privateKey,
    );

    // Attacker substitutes their witness signature into the array.
    const tampered = { ...cert, witnessed_by: [attackerSig] };

    const result = await verifyDeletionCertificate(
      tampered,
      ctxOf(
        {
          "motebit-real": real.publicKey,
          "motebit-attacker": attacker.publicKey,
        },
        { "op-A": operator.publicKey },
      ),
    );
    // The attacker's witness signature itself verifies (they signed a
    // valid stripped body), but the issuer's signature was over the
    // original body containing realSig — substitution invalidates issuer.
    expect(result.valid).toBe(false);
    expect(result.steps.horizon_issuer_signature_valid).toBe(false);
  });

  it("rejects horizon cert when issuer key cannot be resolved", async () => {
    const operator = await makeKeyPair();
    const cert = await signHorizonCertAsIssuer(
      {
        kind: "append_only_horizon",
        subject,
        store_id: "event-log",
        horizon_ts: 1700000000000,
        witnessed_by: [],
        issued_at: 1730000000000,
      },
      operator.privateKey,
    );
    const result = await verifyDeletionCertificate(cert, ctxOf({}, {}));
    expect(result.valid).toBe(false);
    expect(result.steps.horizon_issuer_signature_valid).toBe(false);
  });

  it("rejects horizon cert with a forged witness", async () => {
    const operator = await makeKeyPair();
    const witness = await makeKeyPair();
    const attacker = await makeKeyPair();
    const cert = await signHorizonCertAsIssuer(
      {
        kind: "append_only_horizon",
        subject,
        store_id: "event-log",
        horizon_ts: 1700000000000,
        witnessed_by: [
          {
            motebit_id: asMotebitId("motebit-witness"),
            // Forged: signed by attacker, claimed as the witness.
            signature: "AAAA",
          },
        ],
        issued_at: 1730000000000,
      },
      operator.privateKey,
    );
    void attacker;
    const result = await verifyDeletionCertificate(
      cert,
      ctxOf({ "motebit-witness": witness.publicKey }, { "op-A": operator.publicKey }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("witness motebit-witness"))).toBe(true);
  });
});

describe("canonicalizeMultiSignatureCert", () => {
  it("strips every signature block — same bytes regardless of which signers are present", async () => {
    const subject = await makeKeyPair();
    const operator = await makeKeyPair();
    const seed = { ...baseMutablePruning(), reason: "retention_enforcement" as const };

    const a = canonicalizeMultiSignatureCert(seed);
    const b = canonicalizeMultiSignatureCert(
      await signCertAsSubject(seed, "m", subject.privateKey),
    );
    const c = canonicalizeMultiSignatureCert(
      await signCertAsOperator(seed, "op", operator.privateKey),
    );
    const d = canonicalizeMultiSignatureCert(
      await signCertAsOperator(
        await signCertAsSubject(seed, "m", subject.privateKey),
        "op",
        operator.privateKey,
      ),
    );

    expect(bytesToHex(a)).toBe(bytesToHex(b));
    expect(bytesToHex(a)).toBe(bytesToHex(c));
    expect(bytesToHex(a)).toBe(bytesToHex(d));
  });
});
