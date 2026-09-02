/**
 * Identity-binding transparency wire types — `GET /api/v1/identity/:motebitId`.
 *
 * Foundation law as of `spec/identity-v1.md` §7.5/§7.6. These are the shapes an
 * external verifier codes against to answer the question
 * `docs/doctrine/identity-binding-verification.md` poses: *does this public key
 * really belong to this `motebit_id`?* — the binding half that integrity alone
 * can never establish.
 *
 * They live in the permissive floor because a third party must be able to
 * verify a motebit's binding without taking a BSL dependency, and because
 * `docs/doctrine/agency-proof-integration.md` names the reciprocal obligation:
 * an external consumer is asked to consume `@motebit/verifier` rather than fork
 * it, and in exchange gets a pinned API surface with a semver guarantee
 * (`check-api-surface`). A wire shape defined inside a relay service could not
 * carry that promise.
 *
 * The relay is a CDN here, not a trust root. Succession records are signed by
 * the motebit's own keys — the relay stores them and cannot forge them — and
 * the relay cannot make a binding `anchored` by assertion: the verifier must
 * independently confirm `anchored.proof.anchoredRoot` is posted on-chain at the
 * relay's pinned address. Until then `anchored` is `null`, which is an honest
 * state and not an error (the verifier stays at `pinned`/integrity-only).
 *
 * Types only — verification lives in `@motebit/crypto`
 * (`verifyKeyBindingAtTime`, `verifyIdentityBindingAnchored`) and anchor lookup
 * in `@motebit/state-export-client`.
 */

import type { MerkleTreeVersion } from "./merkle-tree-hash.js";

/** One motebit's leaf in the identity log: id bound to its current key. */
export interface IdentityBinding {
  readonly motebit_id: string;
  /** The motebit's CURRENT identity public key (hex) — the head of its chain. */
  readonly public_key: string;
}

/** Inclusion proof shape consumed verbatim by `verifyIdentityBindingAnchored`. */
export interface IdentityLogProof {
  readonly index: number;
  readonly siblings: string[];
  readonly layerSizes: number[];
  /** The log's Merkle root (hex) — the value the relay anchors on-chain. */
  readonly anchoredRoot: string;
  /**
   * Tree-hash recipe for the leaf + Merkle path (RFC 6962 §2.1 domain
   * separation — `MerkleTreeVersion`). **Omitted ⇒ `merkle-sha256-plain-v1`**
   * so a proof built under v1 is byte-identical to one minted before this axis
   * existed. A v2 log stamps the explicit string; the verifier resolves it
   * fail-closed.
   */
  readonly tree_hash_version?: MerkleTreeVersion;
}

/** Inclusion proof against the latest confirmed on-chain root, with its anchor tx. */
export interface AnchoredInclusion {
  /** Merkle proof; `proof.anchoredRoot` is the root the relay posted on-chain. */
  readonly proof: IdentityLogProof;
  /** The chain transaction that posted `anchoredRoot` — provenance for the verifier. */
  readonly tx_hash: string;
  /** CAIP-2 network of the anchor tx. */
  readonly network: string;
}

/**
 * The `GET /api/v1/identity/:motebitId` response: binding material plus, once
 * anchored, the inclusion proof that lifts a verifier from `pinned` to
 * `anchored` on the binding ladder.
 */
export interface IdentityBindingBundle {
  readonly motebit_id: string;
  /** ISO timestamp the genesis key became active (the registration time). */
  readonly created_at: string;
  /** The motebit's current identity public key (hex) — the chain head. */
  readonly current_public_key: string;
  /**
   * The motebit's guardian public key (hex), if it registered one. Required to
   * verify a guardian-recovery rotation in the succession chain (the spec's
   * key-compromise mechanism, §3.8.3) — without it a third party cannot check a
   * recovery link, so the whole chain fails to verify.
   */
  readonly guardian_public_key?: string;
  /**
   * The self-signed rotation chain (genesis → current). Empty if never rotated.
   *
   * `KeySuccessionRecord` lives beside these types (relocated from the package
   * root, same public export) rather than being imported from
   * `@motebit/crypto`: this package has zero monorepo dependencies by
   * construction (permissive-floor purity, `check-deps`). The two are
   * structurally identical, which is the compatibility the crypto-side
   * docblock already asserts.
   */
  readonly succession: readonly KeySuccessionRecord[];
  /**
   * Inclusion proof against the latest CONFIRMED on-chain anchored root plus its
   * tx. `null` until this motebit's binding has been anchored — an honest
   * "not anchored yet" state. A non-null proof here is only `anchored` once the
   * verifier independently confirms `proof.anchoredRoot` is on-chain at the
   * relay's pinned address.
   */
  readonly anchored: AnchoredInclusion | null;
}

/**
 * A key succession record proving that one Ed25519 key has been replaced by another.
 * Both the old and new keys sign the record, creating a cryptographic chain of custody.
 * Structurally compatible with @motebit/crypto KeySuccessionRecord.
 *
 * Guardian recovery records have `recovery: true` and `guardian_signature` instead of
 * `old_key_signature`. This allows identity recovery when the primary key is compromised.
 */
export interface KeySuccessionRecord {
  old_public_key: string; // hex
  new_public_key: string; // hex
  timestamp: number;
  reason?: string;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-hex-v1"` for
   * this artifact today — JCS canonicalization of the unsigned payload,
   * Ed25519 primitive, hex signature encoding, hex public-key encoding.
   * The same suite as the identity frontmatter (spec/identity-v1.md §3.8).
   * Verifiers reject missing or unknown suite values fail-closed.
   */
  suite: "motebit-jcs-ed25519-hex-v1";
  old_key_signature?: string; // hex — present in normal rotation, absent in guardian recovery
  new_key_signature: string; // hex, new key signs the canonical payload
  /** Guardian recovery: true when succession was authorized by guardian, not old key. */
  recovery?: boolean;
  /** Guardian signature — present only when recovery is true. */
  guardian_signature?: string; // hex
}
