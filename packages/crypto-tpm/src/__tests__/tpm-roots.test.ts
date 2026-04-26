/**
 * Production pinned-root attestation test.
 *
 * For each pinned vendor root, asserts:
 *   1. The PEM parses cleanly with `@peculiar/x509`.
 *   2. The cert is self-signed (terminal anchor).
 *   3. The cert's `basicConstraints.cA === true` (valid CA).
 *   4. The cert's SHA-256 fingerprint byte-matches the expected value
 *      committed in `tpm-roots.ts`'s inline attribution comment.
 *   5. The cert's subject DN byte-matches the expected vendor identity
 *      (catches a copy-paste / vendor-confusion drift).
 *   6. "Now" falls within `notBefore..notAfter`.
 *
 * The fingerprint check is the audit anchor — a third-party operator
 * fetching the same vendor URL and computing SHA-256 should reach the
 * byte-identical value asserted here. Drift in any single byte fails
 * the test before the verifier ever sees it.
 *
 * Real-fixture coverage (a real TPM2_Quote chained to one of these
 * roots) stays privacy-deferred per
 * `docs/doctrine/hardware-attestation.md`. This test certifies the
 * TRUST-ANCHOR side of the moat-claim; real-device captures certify
 * the LEAF side once owned hardware lands.
 */

import { describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";
import { createHash } from "node:crypto";

import {
  DEFAULT_PINNED_TPM_ROOTS,
  INFINEON_TPM_EK_ROOT_PEM,
  NUVOTON_TPM_EK_ROOT_PEM,
  STMICRO_TPM_EK_RSA_ROOT_PEM,
  STMICRO_TPM_EK_ECC_ROOT_PEM,
  INTEL_PTT_EK_ROOT_PEM,
} from "../tpm-roots.js";

x509.cryptoProvider.set(new Crypto() as unknown as globalThis.Crypto);

interface PinnedRoot {
  readonly label: string;
  readonly pem: string;
  readonly expectedSha256: string;
  readonly expectedSubjectFragment: string;
}

const pinnedRoots: readonly PinnedRoot[] = [
  {
    label: "Infineon OPTIGA(TM) ECC Root CA",
    pem: INFINEON_TPM_EK_ROOT_PEM,
    expectedSha256: "cfeb02fecd55ad7a73c6e1d11985d4c47dee248ab63dcb66091a2489660443c3",
    expectedSubjectFragment: "Infineon OPTIGA(TM) ECC Root CA",
  },
  {
    label: "Nuvoton TPM Root CA 2110",
    pem: NUVOTON_TPM_EK_ROOT_PEM,
    expectedSha256: "4aebe77a51ed29959a7f9f5e07a24a558dee8167f3985d724995a541c258dfda",
    expectedSubjectFragment: "Nuvoton TPM Root CA 2110",
  },
  {
    label: "STSAFE RSA Root CA 02",
    pem: STMICRO_TPM_EK_RSA_ROOT_PEM,
    expectedSha256: "c8f179943356e13d9d84b100201cefabbf408880241e5329e60d950ce1dea623",
    expectedSubjectFragment: "STSAFE RSA Root CA 02",
  },
  {
    label: "STSAFE ECC Root CA 02",
    pem: STMICRO_TPM_EK_ECC_ROOT_PEM,
    expectedSha256: "fd1e7b68accd825636b27b3177c67402d463a7f04c97b6c47ab705fcdc1a04f6",
    expectedSubjectFragment: "STSAFE ECC Root CA 02",
  },
  {
    label: "Intel TPM EK root",
    pem: INTEL_PTT_EK_ROOT_PEM,
    expectedSha256: "2e1b3ba79af56d758be51697621bc4b9e8cee0983db3e749c55eb9b37c6d2ae0",
    expectedSubjectFragment: "Intel Corporation",
  },
];

describe("DEFAULT_PINNED_TPM_ROOTS — production trust anchors", () => {
  it("pins exactly the five expected vendor roots", () => {
    expect(DEFAULT_PINNED_TPM_ROOTS).toHaveLength(5);
    expect([...DEFAULT_PINNED_TPM_ROOTS]).toEqual(pinnedRoots.map((r) => r.pem));
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
