/**
 * Production pinned-root attestation test for Google's Hardware
 * Attestation roots.
 *
 * For each pinned root, asserts:
 *   1. The PEM parses cleanly with `@peculiar/x509`.
 *   2. The cert is self-signed (terminal trust anchor).
 *   3. The cert's `basicConstraints.cA === true` (valid CA).
 *   4. The cert's SHA-256 fingerprint byte-matches the value committed
 *      in `google-roots.ts`'s inline attribution comment.
 *   5. "Now" falls within `notBefore..notAfter`.
 *
 * The fingerprint is the audit anchor — a third-party operator that
 * fetches `roots.json` from `android/keyattestation` and computes
 * SHA-256 should reach the byte-identical values asserted here. Drift
 * in any single byte fails the test before the verifier ever sees it.
 *
 * Real-fixture coverage (a real device-emitted chain validating
 * against these roots without a test override) is a separate
 * follow-up — this test certifies the trust-anchor side; real-device
 * captures certify the leaf side.
 */

import { describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";
import { createHash } from "node:crypto";

import {
  DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS,
  GOOGLE_ANDROID_KEYSTORE_ROOT_RSA_PEM,
  GOOGLE_ANDROID_KEYSTORE_ROOT_ECDSA_PEM,
} from "../google-roots.js";

x509.cryptoProvider.set(new Crypto() as unknown as globalThis.Crypto);

interface PinnedRoot {
  readonly label: string;
  readonly pem: string;
  readonly expectedSha256: string;
  readonly expectedSubjectFragment: string;
}

const pinnedRoots: readonly PinnedRoot[] = [
  {
    label: "Google Hardware Attestation Root — RSA-4096",
    pem: GOOGLE_ANDROID_KEYSTORE_ROOT_RSA_PEM,
    expectedSha256: "cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc",
    expectedSubjectFragment: "f92009e853b6b045",
  },
  {
    label: "Google Hardware Attestation Root — ECDSA P-384",
    pem: GOOGLE_ANDROID_KEYSTORE_ROOT_ECDSA_PEM,
    expectedSha256: "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0",
    expectedSubjectFragment: "Key Attestation CA1",
  },
];

describe("DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS — production trust anchors", () => {
  it("pins exactly the two expected Google roots", () => {
    expect(DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS).toHaveLength(2);
    expect([...DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS]).toEqual(pinnedRoots.map((r) => r.pem));
  });

  for (const root of pinnedRoots) {
    describe(root.label, () => {
      it("parses with @peculiar/x509 + matches committed fingerprint + is current self-signed CA", async () => {
        const cert = new x509.X509Certificate(root.pem);
        const der = new Uint8Array(cert.rawData);
        const fingerprint = createHash("sha256").update(der).digest("hex");

        expect(fingerprint).toBe(root.expectedSha256);
        expect(cert.subject).toContain(root.expectedSubjectFragment);
        expect(await cert.isSelfSigned()).toBe(true);

        const bc = cert.getExtension<x509.BasicConstraintsExtension>("2.5.29.19");
        expect(bc?.ca).toBe(true);

        const now = new Date();
        expect(now >= cert.notBefore).toBe(true);
        expect(now <= cert.notAfter).toBe(true);
      });
    });
  }
});
