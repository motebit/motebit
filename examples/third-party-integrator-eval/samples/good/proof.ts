// SPDX-License-Identifier: Apache-2.0
// Reference GOOD solution: installs the published floor, dispatches on the
// suite via the library, and reports integrity and identity binding separately.
//
//   npm install @motebit/verifier
import { verifyArtifact } from "@motebit/verifier";

export interface Trust {
  integrityValid: boolean; // bytes intact, signed by the embedded key
  identity: "sovereign" | "embedded-only" | "invalid";
  signer?: string;
}

export async function checkReceipt(receipt: unknown): Promise<Trust> {
  // The library handles JCS canonicalization and suite dispatch for us.
  const result = await verifyArtifact(receipt as object);

  if (result.type !== "receipt" || !result.valid) {
    return { integrityValid: false, identity: "invalid" };
  }

  // Integrity (valid) is not the same as identity. Report the binding rung.
  return {
    integrityValid: true,
    identity: result.sovereign ? "sovereign" : "embedded-only",
    signer: result.signer,
  };
}
