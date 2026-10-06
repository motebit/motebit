/**
 * Pinned-root anchor — the chain's terminal self-signed cert MUST
 * byte-equal one of the pinned roots.
 *
 * The existing "doesn't terminate at any pinned root" test omits the
 * attacker's root from the receipt, so the chain builder stops at the
 * intermediate and the "not self-signed" check rejects it first — the
 * DER pin comparison itself is never the deciding check. Here the
 * attacker ships a complete, internally valid chain: a freshly minted
 * self-signed CA root, a CA intermediate issued under it, and a leaf
 * carrying a well-formed AOSP Key Attestation extension whose challenge
 * is bound to the expected identity. The attacker root travels in the
 * receipt's intermediates segment so the chain terminates at a
 * self-signed cert. Every check (signatures, validity, CA constraints,
 * extension constraints, identity binding) passes — the ONLY thing that
 * rejects it is the pinned-root DER comparison.
 */

import { describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";

import { VERIFIED_BOOT_STATE_VERIFIED } from "../asn1.js";
import {
  GOOGLE_ANDROID_KEYSTORE_ROOT_ECDSA_PEM,
  GOOGLE_ANDROID_KEYSTORE_ROOT_RSA_PEM,
} from "../google-roots.js";
import { verifyAndroidKeystoreAttestation } from "../verify.js";
import { composeKeyDescriptionForTest } from "./compose-key-description-for-test.js";
import {
  APP_ID_BYTES,
  ATTESTED_AT,
  DEVICE_ID,
  FIXED_CLOCK,
  IDENT,
  MOTEBIT_ID,
  VERIFIED_BOOT_KEY,
  buildChainWithKeyDescription,
  buildFakeRoot,
  canonicalAndroidKeystoreBody,
  sha256,
  toBase64Url,
} from "./test-helpers.js";

const PIN_MISMATCH_REASON =
  "chain terminal cert DER does not match any pinned Google Hardware Attestation root";

/**
 * Attacker-built receipt: `leaf.intermediate,attackerRoot`. The chain is
 * well-formed end-to-end and terminates at the attacker's self-signed CA.
 */
async function buildAttackerRootedReceipt(): Promise<{ receipt: string; attackerRootPem: string }> {
  const body = canonicalAndroidKeystoreBody({
    attestedAt: ATTESTED_AT,
    deviceId: DEVICE_ID,
    identityPublicKeyHex: IDENT,
    motebitId: MOTEBIT_ID,
  });
  const challenge = await sha256(new TextEncoder().encode(body));
  const keyDescriptionDer = composeKeyDescriptionForTest({
    attestationChallenge: challenge,
    rootOfTrust: {
      verifiedBootKey: VERIFIED_BOOT_KEY,
      deviceLocked: true,
      verifiedBootState: VERIFIED_BOOT_STATE_VERIFIED,
    },
    attestationApplicationId: APP_ID_BYTES,
  });
  const { rootPem: attackerRootPem, rootKeys } = await buildFakeRoot();
  const chain = await buildChainWithKeyDescription({
    rootPem: attackerRootPem,
    rootKeys,
    keyDescriptionDer,
  });
  const attackerRoot = new x509.X509Certificate(attackerRootPem);
  const leafB64 = toBase64Url(new Uint8Array(chain.leaf.rawData));
  const intB64 = toBase64Url(new Uint8Array(chain.intermediate.rawData));
  const rootB64 = toBase64Url(new Uint8Array(attackerRoot.rawData));
  return { receipt: `${leafB64}.${intB64},${rootB64}`, attackerRootPem };
}

const BASE_OPTS = {
  expectedAttestationApplicationId: APP_ID_BYTES,
  expectedIdentityPublicKeyHex: IDENT,
  expectedMotebitId: MOTEBIT_ID,
  expectedDeviceId: DEVICE_ID,
  expectedAttestedAt: ATTESTED_AT,
  now: FIXED_CLOCK,
} as const;

describe("verifyAndroidKeystoreAttestation — pinned-root anchor", () => {
  it("control: the attacker chain is internally valid (verifies when its own root is pinned)", async () => {
    const { receipt, attackerRootPem } = await buildAttackerRootedReceipt();
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: receipt },
      { ...BASE_OPTS, rootPems: [attackerRootPem] },
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a valid chain terminating at an attacker CA root not in the Google pinned set", async () => {
    const { receipt } = await buildAttackerRootedReceipt();
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: receipt },
      {
        ...BASE_OPTS,
        rootPems: [GOOGLE_ANDROID_KEYSTORE_ROOT_RSA_PEM, GOOGLE_ANDROID_KEYSTORE_ROOT_ECDSA_PEM],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
    // Only the anchor failed — the extension + identity binding passed.
    expect(result.attestation_extension_valid).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(result.errors.map((e) => e.message)).toEqual([
      expect.stringContaining(PIN_MISMATCH_REASON),
    ]);
  });

  it("rejects an attacker CA root even when a pinned root shares its subject DN", async () => {
    const { receipt } = await buildAttackerRootedReceipt();
    // A distinct legitimate root with the identical subject name — the
    // anchor is the DER bytes, never the DN.
    const { rootPem: pinnedLookalikePem } = await buildFakeRoot();
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: receipt },
      { ...BASE_OPTS, rootPems: [pinnedLookalikePem] },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
    expect(result.errors.map((e) => e.message)).toEqual([
      expect.stringContaining(PIN_MISMATCH_REASON),
    ]);
  });
});
