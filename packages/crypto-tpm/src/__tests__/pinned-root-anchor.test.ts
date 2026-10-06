/**
 * Pinned-root anchor — the attacker-CA negative.
 *
 * The chain verifier's self-signed-terminal check alone would accept
 * ANY self-signed root. The only thing that makes "this is a TPM we
 * accept" true is the DER byte-equality between the chain's terminal
 * cert and one of the pinned vendor roots.
 *
 * These tests build a fully well-formed chain (attacker root → CA
 * intermediate → AK leaf, all valid signatures, cA=true, inside the
 * validity window) and smuggle the attacker's self-signed root into
 * the receipt's intermediates segment so `X509ChainBuilder` CAN reach
 * a self-signed terminal. The quote itself is correctly shaped and
 * AK-signed over a body that binds the expected identity. With a
 * different root pinned, the ONLY failing check is the pin.
 *
 * Positive control: the identical receipt verifies when the attacker's
 * root IS pinned — proving the chain is internally valid and the
 * rejection is attributable to the anchor, not to fixture garbage.
 */

import { describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";

import { verifyTpmQuote } from "../verify.js";
import { composeTpmsAttestForTest } from "../tpm-parse.js";
import {
  ATTESTED_AT,
  DEVICE_ID,
  FIXED_NOW,
  IDENT,
  MOTEBIT_ID,
  buildFakeVendorChain,
  canonicalTpmBody,
  sha256,
  subtle,
  toBase64Url,
} from "./test-helpers.js";

/**
 * Build a receipt whose chain terminates at an attacker-generated CA
 * root, with that root carried in the intermediates segment
 * (`intermediate,attackerRoot`, leaf-proximal-first).
 */
async function buildAttackerRootedReceipt(): Promise<{
  receipt: string;
  attackerRootPem: string;
}> {
  const attacker = await buildFakeVendorChain();
  const attackerRootDer = new Uint8Array(new x509.X509Certificate(attacker.rootPem).rawData);

  const body = canonicalTpmBody({
    attestedAt: ATTESTED_AT,
    deviceId: DEVICE_ID,
    identityPublicKeyHex: IDENT,
    motebitId: MOTEBIT_ID,
  });
  const extraData = await sha256(new TextEncoder().encode(body));
  const attestBytes = composeTpmsAttestForTest({
    qualifiedSigner: new Uint8Array([0x00, 0x0b]),
    extraData,
  });
  const signature = new Uint8Array(
    await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      attacker.leafKeyPair.privateKey,
      attestBytes as BufferSource,
    ),
  );

  const receipt = [
    toBase64Url(attestBytes),
    toBase64Url(signature),
    toBase64Url(attacker.leafDer),
    [toBase64Url(attacker.intermediateDer), toBase64Url(attackerRootDer)].join(","),
  ].join(".");

  return { receipt, attackerRootPem: attacker.rootPem };
}

const verifyOpts = {
  expectedIdentityPublicKeyHex: IDENT,
  expectedMotebitId: MOTEBIT_ID,
  expectedDeviceId: DEVICE_ID,
  expectedAttestedAt: ATTESTED_AT,
  now: FIXED_NOW,
};

describe("verifyTpmQuote — pinned-root anchor", () => {
  it("positive control: the attacker-rooted chain is internally valid when its own root is pinned", async () => {
    const { receipt, attackerRootPem } = await buildAttackerRootedReceipt();

    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      { ...verifyOpts, rootPems: [attackerRootPem] },
    );

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.cert_chain_valid).toBe(true);
  });

  it("rejects a well-formed chain terminating at an attacker CA root not in the injected pinned set", async () => {
    const { receipt } = await buildAttackerRootedReceipt();
    const legitimate = await buildFakeVendorChain();

    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      { ...verifyOpts, rootPems: [legitimate.rootPem] },
    );

    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
    // Every other leg holds — the pin is the only thing rejecting.
    expect(result.quote_shape_valid).toBe(true);
    expect(result.quote_signature_valid).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain(
      "chain terminal cert DER does not match any pinned TPM vendor root",
    );
  });

  it("rejects a well-formed attacker-rooted chain against the default pinned vendor roots", async () => {
    const { receipt } = await buildAttackerRootedReceipt();

    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      verifyOpts,
    );

    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("does not match any pinned"))).toBe(true);
  });
});
