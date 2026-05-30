/**
 * Merkle tree-hash version registry — the agility axis for how a Merkle
 * tree's leaves and interior nodes are hashed.
 *
 * A `MerkleTreeVersion` is the complete specification of the tree-hash
 * recipe for a class of anchored artifacts: which leaf-domain tag, which
 * node-domain tag, which hash function. It is a SEPARATE axis from
 * `SuiteId` (`crypto-suite.ts`) — that names the SIGNATURE recipe over a
 * batch payload; this names the TREE-HASH recipe that builds the root the
 * signature commits to. Keeping them distinct registries prevents the
 * confusion their names would otherwise invite.
 *
 * Scope of a `MerkleTreeVersion` — exactly `(leaf tag, node tag, hash
 * function)`. It does **not** cover payload canonicalization: the bytes a
 * leaf commits to (`canonicalJson` / JCS over the signed artifact) are the
 * entry-bytes contract and version independently. A reviewer must not read
 * this axis as governing canonicalization.
 *
 * Migration is a registry append, not a wire break (see
 * `docs/doctrine/merkle-tree-hash-versioning.md` and
 * `docs/doctrine/agility-as-role.md`): a signed Merkle proof carries an
 * optional `tree_hash_version` field; absent ⇒ `merkle-sha256-plain-v1`
 * (every proof minted before this axis existed still verifies offline).
 * Adding a version means a new entry here + a new dispatch arm in the
 * Merkle primitives (`@motebit/crypto/merkle.ts`,
 * `@motebit/encryption/merkle.ts`), exactly as a new `SuiteId` means a new
 * arm in `verifyBySuite`.
 *
 * Permissive floor (Apache-2.0), type + constants, zero runtime deps. The
 * tag bytes below are documentation-canonical; the dispatching primitives
 * apply them in an exhaustive switch and the known-answer vectors pin the
 * actual byte layout against an independent RFC 6962 implementation.
 */

/**
 * The closed set of tree-hash version identifiers motebit supports.
 *
 *   - `merkle-sha256-plain-v1` — SHA-256 with NO domain separation: leaf =
 *     `SHA-256(entry)`, node = `SHA-256(left ‖ right)`. The original
 *     behavior. `legacy`: verifiers accept it, producers MUST NOT emit it.
 *   - `merkle-sha256-rfc6962-v2` — RFC 6962 §2.1 domain separation: leaf =
 *     `SHA-256(0x00 ‖ entry)`, node = `SHA-256(0x01 ‖ left ‖ right)`. The
 *     `preferred` version; gives the leaf-vs-node second-preimage
 *     resistance the anchor specs' RFC 6962 citation promises.
 */
export type MerkleTreeVersion = "merkle-sha256-plain-v1" | "merkle-sha256-rfc6962-v2";

/**
 * Lifecycle status, mirroring `SuiteStatus`. `legacy` = accept on verify,
 * never emit; `preferred` = producers SHOULD emit, verifiers accept.
 */
export type MerkleTreeVersionStatus = "preferred" | "allowed" | "legacy";

/** The hash function a tree-hash version uses. */
export type MerkleHashFunction = "SHA-256";

/**
 * The complete tree-hash recipe for one version. `leafTag` / `nodeTag` are
 * the RFC 6962 §2.1 domain-separation prefix bytes, or `null` when the
 * version applies no tag (the legacy v1 behavior). Documentation-canonical:
 * the dispatching Merkle primitives hold the authoritative algorithm in an
 * exhaustive switch; a known-answer vector pins the bytes. A test asserts
 * this metadata stays consistent with the primitives' behavior.
 */
export interface MerkleTreeVersionEntry {
  readonly id: MerkleTreeVersion;
  readonly hash: MerkleHashFunction;
  /** RFC 6962 leaf-domain prefix byte, or `null` for no leaf tag (v1). */
  readonly leafTag: number | null;
  /** RFC 6962 node-domain prefix byte, or `null` for no node tag (v1). */
  readonly nodeTag: number | null;
  readonly status: MerkleTreeVersionStatus;
  /** Short prose description — surfaces in tooling, error messages, docs. */
  readonly description: string;
}

export const MERKLE_TREE_VERSION_REGISTRY: Readonly<
  Record<MerkleTreeVersion, MerkleTreeVersionEntry>
> = Object.freeze({
  "merkle-sha256-plain-v1": {
    id: "merkle-sha256-plain-v1",
    hash: "SHA-256",
    leafTag: null,
    nodeTag: null,
    status: "legacy",
    description:
      "SHA-256, no domain separation (leaf = SHA-256(entry), node = SHA-256(left ‖ right)). The original tree-hash; verifiers accept, producers must not emit. Proofs minted before the tree_hash_version field existed are this version by the absent ⇒ v1 default.",
  },
  "merkle-sha256-rfc6962-v2": {
    id: "merkle-sha256-rfc6962-v2",
    hash: "SHA-256",
    leafTag: 0x00,
    nodeTag: 0x01,
    status: "preferred",
    description:
      "RFC 6962 §2.1 domain separation (leaf = SHA-256(0x00 ‖ entry), node = SHA-256(0x01 ‖ left ‖ right)). Provides the leaf-vs-node second-preimage resistance the anchor specs' RFC 6962 citation promises.",
  },
});

/**
 * The default version for a proof that carries no `tree_hash_version`
 * field. Absent ⇒ v1 — never silently upgraded. This is the load-bearing
 * downgrade-safety constant: verifiers resolve absent to exactly this and
 * a v2 producer MUST emit the field rather than rely on the default.
 */
export const DEFAULT_MERKLE_TREE_VERSION: MerkleTreeVersion = "merkle-sha256-plain-v1";

/**
 * Type guard — narrows `unknown` / arbitrary strings to `MerkleTreeVersion`.
 * Verifiers MUST call this (or resolve absent ⇒ default) before dispatching;
 * an unchecked cast is a fail-open path.
 */
export function isMerkleTreeVersion(value: unknown): value is MerkleTreeVersion {
  return typeof value === "string" && value in MERKLE_TREE_VERSION_REGISTRY;
}

/**
 * Look up a tree-hash version entry. Returns `undefined` for unknown IDs so
 * callers decide rejection at their boundary (verifiers reject fail-closed).
 */
export function getMerkleTreeVersionEntry(id: MerkleTreeVersion): MerkleTreeVersionEntry;
export function getMerkleTreeVersionEntry(id: string): MerkleTreeVersionEntry | undefined;
export function getMerkleTreeVersionEntry(id: string): MerkleTreeVersionEntry | undefined {
  return MERKLE_TREE_VERSION_REGISTRY[id as MerkleTreeVersion];
}

/**
 * Canonical frozen list of all registered tree-hash versions. Iterate this
 * (not `Object.keys`) so TypeScript sees the narrow union.
 */
export const ALL_MERKLE_TREE_VERSIONS: readonly MerkleTreeVersion[] = Object.freeze([
  "merkle-sha256-plain-v1",
  "merkle-sha256-rfc6962-v2",
]);
