/**
 * Operator-transparency declaration — the trust-anchor primitive.
 *
 * The motebit relay publishes a signed declaration of its observability
 * posture at `/.well-known/motebit-transparency.json`. The declaration
 * commits the operator to one Ed25519 public key (`relay_public_key`)
 * and to the operator-defined `content` payload. Verifiers pin that
 * key as the trust anchor for every other relay-asserted artifact:
 * content-artifact manifests on state-export endpoints, settlement
 * receipts the operator counter-signs, federation handshakes.
 *
 * This module exports the binding wire types per
 * `spec/relay-transparency-v1.md` (2b-i, the trust-anchor primitive).
 * The operator-comparison vocabulary (Stage 2b-ii — retention/processor
 * field standardization) is deferred until a second motebit-compatible
 * operator forces field standardization; the `content` field stays
 * operator-defined here and verifiers MUST NOT reject declarations on
 * unknown `content` fields.
 *
 * Doctrine: `docs/doctrine/operator-transparency.md`,
 * `docs/doctrine/nist-alignment.md` §8 "savant gap closure",
 * `docs/doctrine/self-attesting-system.md`.
 *
 * Permissive floor (Apache-2.0), type-only, zero runtime deps.
 */

import type { SuiteId } from "./crypto-suite.js";

/**
 * The pinned cryptosuite for transparency declarations. JCS
 * canonicalization (RFC 8785) + Ed25519 + hex signature encoding.
 * Matches the identity-file + credential-anchor + content-artifact
 * family. See `SUITE_REGISTRY` in `./crypto-suite.ts`.
 */
export const TRANSPARENCY_SUITE: SuiteId = "motebit-jcs-ed25519-hex-v1";

/**
 * Canonical memo prefix the relay emits when anchoring the
 * declaration hash to Solana via the Memo program. Full memo shape:
 * `motebit:transparency:v1:{hash_hex}`. Verifiers scan for this
 * prefix at the relay's pinned anchor address. See
 * `spec/relay-transparency-v1.md` §5.2.
 */
export const TRANSPARENCY_ANCHOR_MEMO_PREFIX = "motebit:transparency:v1:" as const;

/**
 * Current spec identifier. Bumps require explicit doctrine alignment
 * + a new wire-format spec doc — the verifier MUST reject declarations
 * with unrecognized `spec` values.
 */
export const TRANSPARENCY_SPEC_ID = "motebit-transparency/draft-2026-04-14" as const;

/**
 * Operator-transparency declaration — the trust-anchor envelope.
 *
 * Wire format (foundation law) — see `spec/relay-transparency-v1.md` §3.1
 * for the binding shape. Field names, types, and the canonical-JSON
 * ordering of the signed payload are protocol law. The `content` field
 * is operator-extensible — the protocol commits to the envelope, not
 * to the posture vocabulary inside `content`.
 *
 * Hash derivation: `sha256(utf8(canonicalJson({spec, declared_at,
 * relay_id, relay_public_key, content})))` — the post-sign fields
 * `hash`, `suite`, `signature` are NOT included in the canonical bytes.
 * Two implementations that hash the same payload MUST produce the same
 * hex string byte-for-byte. Per `spec/relay-transparency-v1.md` §4.
 */
export interface SignedTransparencyDeclaration {
  /** Spec identifier — e.g. `"motebit-transparency/draft-2026-04-14"`. Bump on breaking schema changes. */
  readonly spec: string;
  /** Epoch milliseconds when the declaration was minted. */
  readonly declared_at: number;
  /** Relay's identity — same MotebitId space as agent identities. */
  readonly relay_id: string;
  /** Hex-encoded Ed25519 public key (32 bytes / 64 chars). */
  readonly relay_public_key: string;
  /**
   * Operator-defined posture payload — retention, processors,
   * jurisdiction, honest gaps. Opaque to the protocol. Verifiers MUST
   * NOT reject declarations on unknown `content` fields. Cross-operator
   * comparison vocabulary is deferred to Stage 2b-ii.
   */
  readonly content: unknown;
  /** Hex-encoded SHA-256 of the canonical-JSON of the signed payload. */
  readonly hash: string;
  /** Cryptosuite identifier — `motebit-jcs-ed25519-hex-v1` today. */
  readonly suite: SuiteId;
  /** Hex-encoded Ed25519 signature over the canonical-JSON of the signed payload. */
  readonly signature: string;
}

/**
 * The five-field signed payload — what `hash` and `signature` cover.
 * Exposed as a type so producers can construct + canonicalize the
 * exact bytes the verifier checks against. The post-sign fields
 * (`hash`, `suite`, `signature`) are appended AFTER signing and are
 * NOT part of this payload.
 */
export type TransparencySignedPayload = Pick<
  SignedTransparencyDeclaration,
  "spec" | "declared_at" | "relay_id" | "relay_public_key" | "content"
>;

/**
 * Onchain anchor record — the verifier's view of a memo found at the
 * relay's pinned anchor address. Returned by
 * `@motebit/state-export-client::lookupTransparencyAnchor` on success.
 * Per `spec/relay-transparency-v1.md` §5.
 */
export interface TransparencyAnchorRecord {
  /** Solana transaction signature containing the anchor memo. */
  readonly tx_hash: string;
  /** Anchored hash (the declaration's `hash` field at time of anchoring), lowercase hex. */
  readonly anchored_hash_hex: string;
  /** Solana address (base58 pubkey) where the anchor lives. Pinned out-of-band by the verifier. */
  readonly anchor_address: string;
}

/**
 * Type guard — narrows `unknown` to `SignedTransparencyDeclaration`.
 * Structural shape only; does NOT verify the signature, anchor, or
 * succession chain. Verifiers call this before parsing then proceed
 * through the verification algorithm in `spec/relay-transparency-v1.md`
 * §4.1.
 */
export function isSignedTransparencyDeclaration(
  value: unknown,
): value is SignedTransparencyDeclaration {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.spec === "string" &&
    typeof o.declared_at === "number" &&
    typeof o.relay_id === "string" &&
    typeof o.relay_public_key === "string" &&
    "content" in o &&
    typeof o.hash === "string" &&
    typeof o.suite === "string" &&
    typeof o.signature === "string"
  );
}
