/**
 * @motebit/state-export-client — verified fetch wrapper for motebit
 * state-export endpoints. Closes the producer-consumer asymmetry that
 * the state-export-signing arc opened: every endpoint in
 * `services/relay/src/state-export.ts` emits a `ContentArtifactManifest`
 * in the `X-Motebit-Content-Manifest` HTTP header; consumers wrap
 * `fetch` through this package to verify each manifest against the
 * response body and (optionally) pin the signer against an anchor from
 * `/.well-known/motebit-transparency.json`.
 *
 * Apache-2.0 permissive floor; browser-safe; consumes `@motebit/crypto`
 * and `@motebit/protocol` only. No network at module-load time, no
 * implicit fetches — the caller controls every round-trip.
 *
 * Programmatic shape:
 *
 * ```ts
 * import {
 *   fetchTransparencyAnchor,
 *   verifiedStateExportFetch,
 * } from "@motebit/state-export-client";
 *
 * // Once, at app boot — TOFU bootstrap.
 * const result = await fetchTransparencyAnchor("https://relay.example.com");
 * if (!result.ok) throw new Error(`anchor: ${result.reason}`);
 *
 * // Per state-export call — wrap fetch.
 * const { body, verification } = await verifiedStateExportFetch<AuditResponse>(
 *   `${baseUrl}/api/v1/audit/${motebitId}`,
 *   {
 *     anchor: result.anchor,
 *     init: { headers: { Authorization: `Bearer ${token}` } },
 *   },
 * );
 *
 * if (!verification.valid) {
 *   // Banner the inspector panel; log to audit.
 *   showTamperBadge(verification.reason);
 * }
 * ```
 *
 * Doctrine: `docs/doctrine/nist-alignment.md` §8, `docs/doctrine/self-attesting-system.md`,
 * `docs/doctrine/operator-transparency.md`.
 */

export { fetchTransparencyAnchor, verifyTransparencyDeclaration } from "./transparency-anchor.js";
export type {
  TransparencyAnchor,
  SignedTransparencyDeclaration,
  TransparencyAnchorResult,
  TransparencyAnchorFailureReason,
  FetchTransparencyAnchorOptions,
} from "./transparency-anchor.js";

export {
  verifiedStateExportFetch,
  verifyManifestAgainstBytes,
  StateExportFetchError,
  MANIFEST_HEADER,
} from "./verified-fetch.js";
export type {
  StateExportVerification,
  StateExportVerificationFailureReason,
  VerifiedFetchOptions,
  VerifiedStateExportResponse,
} from "./verified-fetch.js";

export { lookupTransparencyAnchor, verifyDeclarationOnchainAnchor } from "./onchain-anchor.js";
export type {
  OnchainAnchorLookupOptions,
  OnchainAnchorResult,
  OnchainAnchorFailureReason,
} from "./onchain-anchor.js";

export { lookupIdentityLogAnchor } from "./identity-anchor.js";
export type {
  IdentityAnchorLookupOptions,
  IdentityAnchorResult,
  IdentityAnchorFailureReason,
} from "./identity-anchor.js";

export { lookupKeyRevocation } from "./key-revocation.js";
export type { KeyRevocationLookupOptions, KeyRevocationResult } from "./key-revocation.js";

export { verifyInnerSignedReceipts } from "./inner-receipts.js";
export type {
  InnerReceiptVerification,
  InnerReceiptVerificationFailureReason,
  InnerReceiptsVerification,
} from "./inner-receipts.js";

export { verifyReceiptDocument } from "./receipt-document.js";
export type {
  ReceiptDocumentVerification,
  ReceiptDocumentFailureReason,
  ReceiptBindingStatus,
  ReceiptAnchorOptions,
  VerifyReceiptDocumentOptions,
} from "./receipt-document.js";
