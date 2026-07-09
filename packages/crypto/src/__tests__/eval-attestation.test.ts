/**
 * EvalAttestation sign/verify unit tests — roundtrip, per-field tamper, and
 * every structured failure reason. The frozen cross-implementation vectors
 * live in eval-attestation-conformance.test.ts; this file exercises the
 * laws directly with fresh keys.
 */
import { describe, it, expect, beforeAll } from "vitest";

import {
  signEvalAttestation,
  verifyEvalAttestation,
  EVAL_ATTESTATION_SUITE,
  EVAL_KINDS_MIRROR,
  bytesToHex,
} from "../index.js";
import { getPublicKeyBySuite } from "../suite-dispatch.js";
import type { EvalAttestation, VerificationVerdict } from "@motebit/protocol";
import { ALL_EVAL_KINDS } from "@motebit/protocol";

const PRIV = new Uint8Array(32).fill(7);
let PUB_HEX = "";

function verdict(): VerificationVerdict {
  return {
    type: "receipt",
    integrity: "verified",
    identityBinding: "sovereign",
    authority: "unknown",
    revocation: { status: "unchecked" },
    temporalBasis: "clockless",
    evidenceBasis: [{ kind: "receipt", ref: "sha256:00" }],
  };
}

function body(): Omit<EvalAttestation, "signature" | "suite"> {
  return {
    attestation_id: "0197f000-0000-7000-8000-0000000000ff",
    eval_kind: "verification_audit",
    subject: { motebit_id: "motebit-subject" },
    issuer: { motebit_id: "motebit-issuer", public_key: PUB_HEX },
    issued_at: 1_751_932_800_000,
    as_of: { timestamp_ms: 1_751_932_799_000 },
    results: [{ check: "identity_binding", verdict: verdict() }],
  };
}

beforeAll(async () => {
  PUB_HEX = bytesToHex(await getPublicKeyBySuite(PRIV, EVAL_ATTESTATION_SUITE));
});

describe("signEvalAttestation", () => {
  it("produces a verifying attestation with the pinned suite", async () => {
    const signed = await signEvalAttestation(body(), PRIV);
    expect(signed.suite).toBe(EVAL_ATTESTATION_SUITE);
    expect(await verifyEvalAttestation(signed)).toEqual({ valid: true });
  });

  it("is deterministic for identical bodies (JCS + Ed25519)", async () => {
    const a = await signEvalAttestation(body(), PRIV);
    const b = await signEvalAttestation(body(), PRIV);
    expect(a.signature).toBe(b.signature);
  });
});

describe("verifyEvalAttestation — fail-closed reasons", () => {
  it("rejects a foreign suite before signature work", async () => {
    const signed = await signEvalAttestation(body(), PRIV);
    const tampered = {
      ...signed,
      suite: "motebit-jcs-ed25519-hex-v1",
    } as unknown as EvalAttestation;
    expect(await verifyEvalAttestation(tampered)).toEqual({
      valid: false,
      reason: "unsupported_suite",
    });
  });

  it("rejects an unknown eval_kind (closed-registry wire intake)", async () => {
    const signed = await signEvalAttestation(body(), PRIV);
    const tampered = { ...signed, eval_kind: "vibes_audit" } as unknown as EvalAttestation;
    expect(await verifyEvalAttestation(tampered)).toEqual({
      valid: false,
      reason: "unknown_eval_kind",
    });
  });

  it("rejects empty results", async () => {
    const signed = await signEvalAttestation(body(), PRIV);
    const tampered = { ...signed, results: [] } as EvalAttestation;
    expect(await verifyEvalAttestation(tampered)).toEqual({
      valid: false,
      reason: "empty_results",
    });
  });

  it("rejects a malformed issuer key", async () => {
    const signed = await signEvalAttestation(body(), PRIV);
    const tampered: EvalAttestation = {
      ...signed,
      issuer: { ...signed.issuer, public_key: "zz" },
    };
    expect(await verifyEvalAttestation(tampered)).toEqual({
      valid: false,
      reason: "malformed_public_key",
    });
  });

  it("rejects a malformed signature", async () => {
    const signed = await signEvalAttestation(body(), PRIV);
    expect(await verifyEvalAttestation({ ...signed, signature: "AAAA" })).toEqual({
      valid: false,
      reason: "malformed_signature",
    });
  });

  it("rejects any tampered signed field", async () => {
    const signed = await signEvalAttestation(body(), PRIV);
    const mutations: Array<Partial<EvalAttestation>> = [
      { issued_at: signed.issued_at + 1 },
      { subject: { motebit_id: "motebit-other" } },
      { as_of: { timestamp_ms: 1 } },
      {
        results: [{ check: "identity_binding", verdict: { ...verdict(), integrity: "invalid" } }],
      },
    ];
    for (const m of mutations) {
      const tampered = { ...signed, ...m } as EvalAttestation;
      expect(await verifyEvalAttestation(tampered)).toEqual({
        valid: false,
        reason: "signature_invalid",
      });
    }
  });

  it("accepts subject == issuer (self-issued floor)", async () => {
    const selfBody = { ...body(), subject: { motebit_id: "motebit-issuer" } };
    const signed = await signEvalAttestation(selfBody, PRIV);
    expect(await verifyEvalAttestation(signed)).toEqual({ valid: true });
  });

  it("carries expires_at without enforcing it", async () => {
    const signed = await signEvalAttestation({ ...body(), expires_at: 1 }, PRIV);
    expect(await verifyEvalAttestation(signed)).toEqual({ valid: true });
  });
});

describe("EVAL_KINDS_MIRROR", () => {
  it("mirrors the protocol registry exactly (locked by check-eval-kind-canonical)", () => {
    expect([...EVAL_KINDS_MIRROR]).toEqual([...ALL_EVAL_KINDS]);
    expect(Object.isFrozen(EVAL_KINDS_MIRROR)).toBe(true);
  });
});
