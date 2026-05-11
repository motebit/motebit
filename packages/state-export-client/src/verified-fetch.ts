/**
 * Verified-fetch wrapper for motebit state-export endpoints.
 *
 * Every `app.get(...)` in `services/relay/src/state-export.ts` emits an
 * outer `ContentArtifactManifest` in the `X-Motebit-Content-Manifest`
 * HTTP header (signed by the relay's identity). This module wraps
 * `fetch` to verify the manifest against the response body bytes on
 * every call, optionally pinning the producer key against a trust
 * anchor obtained from `fetchTransparencyAnchor`.
 *
 * The consumer-side primitive that turns producer-side signing into
 * an operational invariant: an operator who silently degrades their
 * own signing breaks their own dashboard. Doctrine:
 * `docs/doctrine/nist-alignment.md` §8, `docs/doctrine/self-attesting-system.md`.
 */

import type { ContentArtifactManifest } from "@motebit/crypto";
import { verifyContentArtifact } from "@motebit/crypto";
import type { ContentArtifactType } from "@motebit/protocol";

import type { TransparencyAnchor } from "./transparency-anchor.js";

/** HTTP header carrying the relay-signed content-artifact manifest. */
export const MANIFEST_HEADER = "X-Motebit-Content-Manifest";

/** Verification outcome accompanying every state-export response body. */
export type StateExportVerification =
  | {
      readonly valid: true;
      readonly producerPublicKeyHex: string;
      readonly producerDid: string;
      readonly artifactType: ContentArtifactType;
      readonly claimGenerator: string;
      readonly producedAt: string;
      readonly contentHash: string;
    }
  | {
      readonly valid: false;
      readonly reason: StateExportVerificationFailureReason;
      readonly detail?: string;
    };

export type StateExportVerificationFailureReason =
  | "manifest_header_missing"
  | "malformed_manifest_header"
  | "content_hash_mismatch"
  | "signature_invalid"
  | "malformed_public_key"
  | "malformed_signature"
  | "unsupported_suite"
  | "producer_key_mismatch";

export interface VerifiedStateExportResponse<T> {
  /**
   * Parsed JSON body — present only when verification succeeded.
   * `null` on verification failure: callers MUST check
   * `verification.valid` before consuming the body. Never render
   * unverified state.
   */
  readonly body: T | null;
  /** Raw bytes the verifier hashed. Exposed so callers that need byte-level access (audit, hashing, re-serialization) don't double-fetch. */
  readonly bodyBytes: Uint8Array;
  /** Structured verification result. Callers branch on `valid` for UI status and `reason` for audit logging. */
  readonly verification: StateExportVerification;
}

export interface VerifiedFetchOptions {
  /**
   * Trust anchor obtained from `fetchTransparencyAnchor`. When set,
   * the verifier rejects with `producer_key_mismatch` if the manifest's
   * declared producer key does not match the pinned hex value.
   *
   * Omitting the anchor still verifies the manifest's self-consistency
   * (content_hash + signature against the declared key) — but a verifier
   * with no pin trusts the declared key. Production callers SHOULD
   * always pass an anchor.
   */
  readonly anchor?: TransparencyAnchor;
  /**
   * Inject the fetch implementation. Defaults to global `fetch`. Tests
   * pass a mock; integrators with auth-proxy or tunneling transports
   * pass a wrapper.
   */
  readonly fetch?: typeof globalThis.fetch;
  /** Forwarded to the underlying fetch call. */
  readonly init?: RequestInit;
}

/**
 * Fetch a state-export endpoint and verify its content-artifact
 * manifest against the response body bytes. Returns the parsed body,
 * the raw bytes, and a typed verification result.
 *
 * The verifier reads `X-Motebit-Content-Manifest` from the response,
 * decodes the base64url-encoded canonical-JSON manifest, recomputes
 * SHA-256 over the body bytes, and verifies the signature against the
 * manifest's declared producer key. With `anchor` set, also enforces
 * a byte-equal match between the declared key and the pinned key.
 *
 * Non-2xx HTTP responses throw — the verifier does not attempt to
 * verify error bodies. A 5xx response from the relay is a service
 * outage, not a signing failure; let the caller's catch handle it.
 */
export async function verifiedStateExportFetch<T>(
  url: string,
  options: VerifiedFetchOptions = {},
): Promise<VerifiedStateExportResponse<T>> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const res = await fetchImpl(url, options.init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new StateExportFetchError(res.status, res.statusText, body, url);
  }

  // Read body bytes once — JSON.parse runs over a UTF-8 decode of the
  // same bytes the verifier hashes. ArrayBuffer keeps both views safe.
  const arrayBuffer = await res.arrayBuffer();
  const bodyBytes = new Uint8Array(arrayBuffer);

  // Verify BEFORE JSON-parse: a tampered body can corrupt JSON
  // structure, which would mask the typed crypto reason
  // (`content_hash_mismatch`) behind a generic parse error. Running
  // verification first preserves the structured failure reason for
  // audit logging even when the bytes are wholly garbage.
  const headerValue = res.headers.get(MANIFEST_HEADER);
  const verification = await verifyManifestAgainstBytes(headerValue, bodyBytes, options.anchor);

  // JSON parsing only meaningful when the bytes are what the producer
  // signed. On verification failure, `body` is null — callers MUST
  // check `verification.valid` before rendering; the discriminated
  // union below makes that compile-time enforceable.
  let body: T | null = null;
  if (verification.valid) {
    const bodyText = new TextDecoder().decode(bodyBytes);
    try {
      body = JSON.parse(bodyText) as T;
    } catch (err) {
      // Verified bytes that don't parse as JSON are a producer bug —
      // the manifest swore these bytes are the export, but they aren't
      // valid JSON. Surface as a thrown error rather than mixing
      // crypto-valid + parse-failed into the same return shape.
      throw new StateExportFetchError(
        200,
        "verified body is not valid JSON",
        err instanceof Error ? err.message : String(err),
        url,
      );
    }
  }

  return { body, bodyBytes, verification };
}

/**
 * Pure-function verifier: decode the header value, parse the manifest,
 * verify against the body bytes, optionally enforce the producer-key
 * pin. Exposed so tests + audit tooling can replay a captured response
 * without a fresh HTTP round-trip.
 */
export async function verifyManifestAgainstBytes(
  headerValue: string | null,
  bodyBytes: Uint8Array,
  anchor?: TransparencyAnchor,
): Promise<StateExportVerification> {
  if (headerValue == null || headerValue === "") {
    return { valid: false, reason: "manifest_header_missing" };
  }

  let manifest: ContentArtifactManifest;
  try {
    const manifestBytes = base64UrlDecode(headerValue);
    const manifestJson = new TextDecoder().decode(manifestBytes);
    manifest = JSON.parse(manifestJson) as ContentArtifactManifest;
  } catch (err) {
    return {
      valid: false,
      reason: "malformed_manifest_header",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Producer-key pin runs BEFORE the crypto check — a key-mismatch
  // rejection is cheaper and more informative than a generic
  // signature_invalid when the verifier knows the expected signer.
  if (anchor !== undefined) {
    const declared = manifest.producer_public_key.toLowerCase();
    if (declared !== anchor.relayPublicKeyHex) {
      return {
        valid: false,
        reason: "producer_key_mismatch",
        detail: `expected ${anchor.relayPublicKeyHex}, got ${declared}`,
      };
    }
  }

  const result = await verifyContentArtifact(manifest, bodyBytes);
  if (!result.valid) {
    // Map primitive reasons into the consumer-facing failure union.
    // Both unions share most variants verbatim; the consumer-facing
    // one adds the header- and key-pin-specific reasons above.
    return {
      valid: false,
      reason: result.reason as StateExportVerificationFailureReason,
    };
  }

  return {
    valid: true,
    producerPublicKeyHex: manifest.producer_public_key.toLowerCase(),
    producerDid: manifest.producer,
    artifactType: manifest.artifact_type,
    claimGenerator: manifest.claim_generator,
    producedAt: manifest.produced_at,
    contentHash: manifest.content_hash,
  };
}

/**
 * Thrown when the underlying HTTP fetch returns non-2xx. The verifier
 * does not attempt to verify error bodies — the relay's error
 * envelope is unsigned by design (signing 5xx pages would be
 * misleading provenance for a service outage).
 */
export class StateExportFetchError extends Error {
  public constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`state-export fetch ${url} → ${status} ${statusText}`);
    this.name = "StateExportFetchError";
  }
}

/**
 * Inline base64url decoder — avoids pulling Buffer (Node-only) or a
 * new dependency. Browsers + Node 20+ have `atob`, but `atob` rejects
 * base64url; we normalize to standard base64 first.
 */
function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  // atob requires padded base64. Compute padding from length mod 4.
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
