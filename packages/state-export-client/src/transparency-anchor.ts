/**
 * Trust-anchor discovery from `/.well-known/motebit-transparency.json`.
 *
 * The operator-transparency declaration (`docs/doctrine/operator-transparency.md`)
 * is a self-signed JSON artifact: the relay's Ed25519 public key is
 * embedded inside the signed payload, and the payload's signature verifies
 * against that same key. Trust-on-first-use (TOFU): a verifier that does
 * not yet know the relay's key fetches the declaration once, verifies its
 * self-signature, and caches the key. From then on every state-export
 * `X-Motebit-Content-Manifest` header is verified against the cached key
 * offline — no further relay contact at verify time.
 *
 * Why this is sufficient (not circular):
 * The declaration's signature commits the relay to the key it carries.
 * An attacker who substitutes a different key must also re-sign the
 * declaration; doing so produces a different declaration that any
 * holder of a prior (signed) declaration can detect by comparing keys
 * or by walking the onchain anchor chain once stage 2 ships. The
 * disappearance test still applies: the declaration is durable across
 * operator vanishings; the key it commits to remains the anchor.
 *
 * Doctrine: `docs/doctrine/operator-transparency.md`, `docs/doctrine/nist-alignment.md` §8.
 */

import { canonicalJson, hexToBytes, sha256, bytesToHex, verifyBySuite } from "@motebit/crypto";
import type { SuiteId } from "@motebit/protocol";

/**
 * The pinned trust anchor — what a verifier carries forward after a
 * successful TOFU bootstrap. Subsequent state-export manifests are
 * checked against `relayPublicKey`.
 */
export interface TransparencyAnchor {
  /** 32-byte Ed25519 public key — the canonical signer for this operator. */
  readonly relayPublicKey: Uint8Array;
  /** Hex form, for `motebit-verify --producer-key` pinning + log display. */
  readonly relayPublicKeyHex: string;
  /** Relay motebit ID from the declaration. */
  readonly relayId: string;
  /** ISO timestamp of the declaration. */
  readonly declaredAt: number;
}

/**
 * Wire shape of `/.well-known/motebit-transparency.json`. Matches
 * `SignedDeclaration` in `services/relay/src/transparency.ts` — the
 * canonical reference implementation. Stage 2's wire-format spec
 * (`spec/relay-transparency-v1.md`) will pin this shape; until then,
 * the client mirrors the relay's emit shape.
 */
export interface SignedTransparencyDeclaration {
  readonly spec: string;
  readonly declared_at: number;
  readonly relay_id: string;
  readonly relay_public_key: string;
  readonly content: unknown;
  readonly hash: string;
  readonly suite: SuiteId;
  readonly signature: string;
}

export interface FetchTransparencyAnchorOptions {
  /**
   * Override the default endpoint path. Production callers leave this
   * unset; tests pass a fixture path. The default mirrors the
   * well-known URI defined in `docs/doctrine/operator-transparency.md`.
   */
  readonly path?: string;
  /**
   * Inject the fetch implementation. Defaults to global `fetch`.
   * Tests pass a mock; integrators with custom transport (auth proxy,
   * tunneling) pass a wrapper.
   */
  readonly fetch?: typeof globalThis.fetch;
  /** Abort signal for the network request. */
  readonly signal?: AbortSignal;
}

/** Verification outcome with a structured failure reason for audit logging. */
export type TransparencyAnchorResult =
  | { readonly ok: true; readonly anchor: TransparencyAnchor }
  | {
      readonly ok: false;
      readonly reason: TransparencyAnchorFailureReason;
      readonly detail?: string;
    };

export type TransparencyAnchorFailureReason =
  | "fetch_failed"
  | "malformed_declaration"
  | "hash_mismatch"
  | "malformed_public_key"
  | "malformed_signature"
  | "signature_invalid"
  | "unsupported_suite";

/**
 * Fetch the operator-transparency declaration and verify its
 * self-signature. Returns the pinned `TransparencyAnchor` on success,
 * or a structured failure reason. Fail-closed — every rejection has a
 * typed reason, no thrown exceptions for verification failures.
 *
 * The relay's identity key is embedded in the declaration as
 * `relay_public_key` (hex) and the signature is over
 * `canonicalJson({spec, declared_at, relay_id, relay_public_key, content})`.
 * Verification recomputes the hash, then checks the signature against
 * the declared key via `verifyBySuite`.
 */
export async function fetchTransparencyAnchor(
  baseUrl: string,
  options: FetchTransparencyAnchorOptions = {},
): Promise<TransparencyAnchorResult> {
  const path = options.path ?? "/.well-known/motebit-transparency.json";
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  let declaration: SignedTransparencyDeclaration;
  try {
    const res = await fetchImpl(url, { signal: options.signal });
    if (!res.ok) {
      return {
        ok: false,
        reason: "fetch_failed",
        detail: `HTTP ${res.status} ${res.statusText}`,
      };
    }
    declaration = (await res.json()) as SignedTransparencyDeclaration;
  } catch (err) {
    return {
      ok: false,
      reason: "fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  return verifyTransparencyDeclaration(declaration);
}

/**
 * Verify an already-fetched signed transparency declaration. Exposed
 * separately so a verifier with a cached declaration (e.g. captured
 * to a file by an auditor) can re-verify without a network round-trip.
 */
export async function verifyTransparencyDeclaration(
  declaration: SignedTransparencyDeclaration,
): Promise<TransparencyAnchorResult> {
  // Structural sanity — anything malformed past JSON.parse falls into
  // `malformed_declaration` rather than the more specific reasons. A
  // genuinely tampered declaration produces hash_mismatch or
  // signature_invalid; a malformed-shape declaration is a producer
  // bug or wire-protocol mismatch.
  if (
    typeof declaration !== "object" ||
    declaration === null ||
    typeof declaration.relay_public_key !== "string" ||
    typeof declaration.signature !== "string" ||
    typeof declaration.hash !== "string" ||
    typeof declaration.suite !== "string" ||
    typeof declaration.relay_id !== "string" ||
    typeof declaration.declared_at !== "number" ||
    typeof declaration.spec !== "string"
  ) {
    return { ok: false, reason: "malformed_declaration" };
  }

  // Recompute hash over the signed payload (everything except hash, suite, signature).
  const payload = {
    spec: declaration.spec,
    declared_at: declaration.declared_at,
    relay_id: declaration.relay_id,
    relay_public_key: declaration.relay_public_key,
    content: declaration.content,
  };
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  const computedHashBytes = await sha256(canonical);
  const computedHash = bytesToHex(computedHashBytes);
  if (computedHash !== declaration.hash) {
    return { ok: false, reason: "hash_mismatch" };
  }

  // Decode the declared public key. Ed25519 = 32 bytes = 64 hex chars.
  // Future PQ suites will need their own length validation per suite.
  if (!/^[0-9a-fA-F]{64}$/.test(declaration.relay_public_key)) {
    return { ok: false, reason: "malformed_public_key" };
  }
  let publicKey: Uint8Array;
  try {
    publicKey = hexToBytes(declaration.relay_public_key);
  } catch {
    return { ok: false, reason: "malformed_public_key" };
  }

  // Decode the signature (hex form for transparency declarations).
  if (!/^[0-9a-fA-F]+$/.test(declaration.signature)) {
    return { ok: false, reason: "malformed_signature" };
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(declaration.signature);
  } catch {
    return { ok: false, reason: "malformed_signature" };
  }

  // Verify under the declared suite.
  let valid: boolean;
  try {
    valid = await verifyBySuite(declaration.suite, canonical, sigBytes, publicKey);
  } catch {
    return { ok: false, reason: "unsupported_suite" };
  }
  if (!valid) {
    return { ok: false, reason: "signature_invalid" };
  }

  return {
    ok: true,
    anchor: {
      relayPublicKey: publicKey,
      relayPublicKeyHex: declaration.relay_public_key.toLowerCase(),
      relayId: declaration.relay_id,
      declaredAt: declaration.declared_at,
    },
  };
}
