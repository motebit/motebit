/**
 * Production pinned-root attestation test for Apple's App Attestation
 * Root CA.
 *
 * Asserts:
 *   1. The PEM parses cleanly with `@peculiar/x509`.
 *   2. The cert is self-signed (terminal trust anchor).
 *   3. The cert's `basicConstraints.cA === true` (valid CA).
 *   4. The cert's SHA-256 fingerprint byte-matches the value committed
 *      in `apple-root.ts`'s inline attribution comment.
 *   5. "Now" falls within `notBefore..notAfter`.
 *
 * The fingerprint is the audit anchor — a third-party operator that
 * fetches `https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem`
 * and computes SHA-256 should reach the byte-identical value asserted
 * here. Drift in any single byte fails this test before the verifier
 * ever sees it.
 *
 * Sibling of `packages/crypto-tpm/src/__tests__/tpm-roots.test.ts` and
 * `packages/crypto-android-keystore/src/__tests__/google-roots.test.ts`
 * — same shape, same purpose. The original commit of `apple-root.ts`
 * carried a wrong fingerprint comment (`bfeb88ce…`) that survived for
 * months because no parity test caught it; this test closes that gap.
 */

import { describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";
import { createHash } from "node:crypto";

import { APPLE_APPATTEST_ROOT_PEM } from "../apple-root.js";

x509.cryptoProvider.set(new Crypto() as unknown as globalThis.Crypto);

const EXPECTED_SHA256 = "1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932";
const EXPECTED_SUBJECT_FRAGMENT = "Apple App Attestation Root CA";

describe("APPLE_APPATTEST_ROOT_PEM — production trust anchor", () => {
  it("parses with @peculiar/x509 + matches committed fingerprint + is current self-signed CA", async () => {
    const cert = new x509.X509Certificate(APPLE_APPATTEST_ROOT_PEM);
    const der = new Uint8Array(cert.rawData);
    const fingerprint = createHash("sha256").update(der).digest("hex");

    expect(fingerprint).toBe(EXPECTED_SHA256);
    expect(cert.subject).toContain(EXPECTED_SUBJECT_FRAGMENT);
    expect(await cert.isSelfSigned()).toBe(true);

    const bc = cert.getExtension<x509.BasicConstraintsExtension>("2.5.29.19");
    expect(bc?.ca).toBe(true);

    const now = new Date();
    expect(now >= cert.notBefore).toBe(true);
    expect(now <= cert.notAfter).toBe(true);
  });
});
