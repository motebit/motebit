/**
 * Suite-substitution probes (F-20) for deletion certificates.
 *
 * Multi-signature arms (`mutable_pruning` / `consolidation_flush`): each
 * `*_signature` block carries its own `suite`, and the canonical bytes strip
 * every signature block — so the per-signer `suite` is NOT signature-covered.
 * The verifier must pin it rather than dispatch on the unsigned value.
 *
 * Horizon arm: the top-level `suite` IS in the issuer's canonical bytes
 * (only `signature` is stripped) — rewriting it must break the issuer sig.
 */

import { describe, expect, it } from "vitest";
import type { DeletionCertificate, DeletionCertificateVerifyContext } from "@motebit/protocol";
import { SUITE_REGISTRY, asNodeId } from "@motebit/protocol";
import type { SuiteId } from "@motebit/protocol";

import { generateEd25519Keypair } from "../suite-dispatch.js";
import {
  DELETION_CERTIFICATE_SUITE,
  signCertAsSubject,
  signCertAsOperator,
  signHorizonCertAsIssuer,
  verifyDeletionCertificate,
} from "../deletion-certificate.js";

const SUBSTITUTES: string[] = [
  ...(Object.keys(SUITE_REGISTRY) as string[]).filter((s) => s !== DELETION_CERTIFICATE_SUITE),
  "attacker-chosen-suite-v9",
];

function ctxOf(
  motebitKeys: Record<string, Uint8Array>,
  operatorKeys: Record<string, Uint8Array>,
): DeletionCertificateVerifyContext {
  return {
    resolveMotebitPublicKey: async (id: string) => motebitKeys[id] ?? null,
    resolveOperatorPublicKey: async (id: string) => operatorKeys[id] ?? null,
  };
}

const base = (): Extract<DeletionCertificate, { kind: "mutable_pruning" }> => ({
  kind: "mutable_pruning",
  target_id: asNodeId("node-001"),
  sensitivity: "personal",
  reason: "user_request",
  deleted_at: 1730000000000,
});

describe("deletion certificate suite substitution without re-signing (F-20)", () => {
  it("control: untampered subject+operator cert verifies", async () => {
    const subject = await generateEd25519Keypair();
    const operator = await generateEd25519Keypair();
    let cert = await signCertAsSubject(base(), "m-subject", subject.privateKey);
    cert = await signCertAsOperator(cert, "op-A", operator.privateKey);
    const r = await verifyDeletionCertificate(
      cert,
      ctxOf({ "m-subject": subject.publicKey }, { "op-A": operator.publicKey }),
    );
    expect(r.valid).toBe(true);
  });

  for (const s of SUBSTITUTES) {
    it(`multi-sig subject_signature rejects suite=${s}`, async () => {
      const subject = await generateEd25519Keypair();
      const cert = await signCertAsSubject(base(), "m-subject", subject.privateKey);
      const tampered = {
        ...cert,
        subject_signature: { ...cert.subject_signature!, suite: s as SuiteId },
      };
      const r = await verifyDeletionCertificate(
        tampered as DeletionCertificate,
        ctxOf({ "m-subject": subject.publicKey }, {}),
      );
      expect(r.valid).toBe(false);
      expect(r.steps.subject_signature_valid).toBe(false);
    });

    it(`multi-sig operator_signature rejects suite=${s}`, async () => {
      const subject = await generateEd25519Keypair();
      const operator = await generateEd25519Keypair();
      let cert = await signCertAsSubject(base(), "m-subject", subject.privateKey);
      cert = await signCertAsOperator(cert, "op-A", operator.privateKey);
      const tampered = {
        ...cert,
        operator_signature: { ...cert.operator_signature!, suite: s as SuiteId },
      };
      const r = await verifyDeletionCertificate(
        tampered as DeletionCertificate,
        ctxOf({ "m-subject": subject.publicKey }, { "op-A": operator.publicKey }),
      );
      expect(r.valid).toBe(false);
      expect(r.steps.operator_signature_valid).toBe(false);
    });

    it(`horizon issuer (suite signature-bound) rejects suite=${s}`, async () => {
      const operator = await generateEd25519Keypair();
      const cert = await signHorizonCertAsIssuer(
        {
          kind: "append_only_horizon",
          subject: { kind: "operator", operator_id: "op-A" },
          store_id: "event-log",
          horizon_ts: 1700000000000,
          witnessed_by: [],
          issued_at: 1730000000000,
        },
        operator.privateKey,
      );
      const r = await verifyDeletionCertificate(
        { ...cert, suite: s as SuiteId },
        ctxOf({}, { "op-A": operator.publicKey }),
      );
      expect(r.valid).toBe(false);
    });
  }
});
