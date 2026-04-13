/**
 * Cryptosuite registry — the protocol's open set of verification recipes.
 *
 * A cryptosuite is the complete specification of how a signature is
 * produced and verified for a class of artifacts: which algorithm,
 * which canonicalization, which signature and key encodings. Matches
 * the pattern of W3C VC 2.0 (`cryptosuite: "eddsa-jcs-2022"`) and
 * COSE/JOSE algorithm registries — one ID per full recipe, not just
 * "which primitive."
 *
 * Every signed wire-format artifact in motebit MUST carry a `suite`
 * field (see each artifact's `#### Wire format (foundation law)`
 * subsection in `spec/*.md`). Verifiers dispatch on the suite value.
 * Missing or unknown suites are rejected fail-closed. See the
 * `check-suite-declared` (spec-side) and `check-suite-dispatch`
 * (code-side) drift gates.
 *
 * Post-quantum migration becomes a new registry entry + dispatch arm
 * in `@motebit/crypto/suite-dispatch.ts`, not a wire-format change.
 *
 * MIT, type-only, zero runtime deps.
 */

/**
 * The closed set of suite identifiers motebit currently supports.
 *
 * Four Ed25519 suites cover the four canonicalization/encoding bundles
 * already used in the codebase (exploration 2026-04-13 found these
 * were genuinely distinct recipes, not one). The fifth entry is the
 * W3C standard suite used by Verifiable Credentials.
 *
 * Adding a new suite is an intentional protocol-level change: new
 * string literal here, new dispatch arm in `verifyBySuite`, new
 * `SUITE_REGISTRY` entry, a changeset bump, and (typically) a new spec
 * paragraph naming which artifacts adopt it.
 */
export type SuiteId =
  | "motebit-jcs-ed25519-b64-v1"
  | "motebit-jcs-ed25519-hex-v1"
  | "motebit-jwt-ed25519-v1"
  | "motebit-concat-ed25519-hex-v1"
  | "eddsa-jcs-2022";

/**
 * Lifecycle status for each registered suite. Prevents today's bundles
 * from calcifying into accidental permanent doctrine when PQ suites
 * land — a demotion path is declared up front.
 *
 * - `preferred`: signers SHOULD emit under this suite; verifiers accept.
 * - `allowed`: verifiers accept; signers MAY emit but `preferred` is
 *   recommended. Used during transition windows.
 * - `legacy`: verifiers accept; signers MUST NOT emit. Migration-only.
 */
export type SuiteStatus = "preferred" | "allowed" | "legacy";

/**
 * The primitive signature algorithm family. Separate from the suite
 * name because several bundles share Ed25519 today, and the PQ world
 * will introduce algorithms (ML-DSA-44, ML-DSA-65, SLH-DSA-SHA2-128s)
 * that will each appear in multiple encoding variants.
 */
export type SuiteAlgorithm = "Ed25519" | "ML-DSA-44" | "ML-DSA-65" | "SLH-DSA-SHA2-128s";

/** Canonicalization used to produce signed bytes. */
export type SuiteCanonicalization =
  | "jcs" // RFC 8785 JSON Canonicalization Scheme
  | "json-stringify" // plain JSON.stringify (JWT-style)
  | "utf8-concat"; // UTF-8 byte concatenation of a fixed template

/** On-wire encoding of the signature string. */
export type SuiteSignatureEncoding =
  | "base64url" // RFC 4648 §5, no padding
  | "hex" // lowercase
  | "multibase-base58btc"; // `z...` prefix, per W3C DI

/** On-wire encoding of the public key reference carried alongside the signature. */
export type SuitePublicKeyEncoding = "hex" | "multibase-did-key"; // `did:key:z...`

/**
 * The complete verification recipe for one suite. Metadata is readable
 * by verifiers and by documentation / CLI tooling; the dispatcher in
 * `@motebit/crypto/suite-dispatch.ts` is the authority on actual
 * verification semantics.
 */
export interface SuiteEntry {
  readonly id: SuiteId;
  readonly algorithm: SuiteAlgorithm;
  readonly canonicalization: SuiteCanonicalization;
  readonly signatureEncoding: SuiteSignatureEncoding;
  readonly publicKeyEncoding: SuitePublicKeyEncoding;
  readonly status: SuiteStatus;
  /**
   * Short prose description — surfaces in tooling (e.g. CLI `motebit
   * inspect`), spec cross-references, and error messages.
   */
  readonly description: string;
}

export const SUITE_REGISTRY: Readonly<Record<SuiteId, SuiteEntry>> = Object.freeze({
  "motebit-jcs-ed25519-b64-v1": {
    id: "motebit-jcs-ed25519-b64-v1",
    algorithm: "Ed25519",
    canonicalization: "jcs",
    signatureEncoding: "base64url",
    publicKeyEncoding: "hex",
    status: "preferred",
    description:
      "RFC 8785 JCS canonicalization + Ed25519 signature + base64url. Execution receipts, delegation-lifecycle, dispute-lifecycle, migration-lifecycle artifacts.",
  },
  "motebit-jcs-ed25519-hex-v1": {
    id: "motebit-jcs-ed25519-hex-v1",
    algorithm: "Ed25519",
    canonicalization: "jcs",
    signatureEncoding: "hex",
    publicKeyEncoding: "hex",
    status: "preferred",
    description:
      "RFC 8785 JCS canonicalization + Ed25519 signature + hex. Identity files, succession, guardian attestations, credential anchors, relay metadata.",
  },
  "motebit-jwt-ed25519-v1": {
    id: "motebit-jwt-ed25519-v1",
    algorithm: "Ed25519",
    canonicalization: "json-stringify",
    signatureEncoding: "base64url",
    publicKeyEncoding: "hex",
    status: "preferred",
    description:
      "JWT-style bearer token (`base64url(payload).base64url(signature)`). Signed bearer tokens only; suite is a field of the JSON payload.",
  },
  "motebit-concat-ed25519-hex-v1": {
    id: "motebit-concat-ed25519-hex-v1",
    algorithm: "Ed25519",
    canonicalization: "utf8-concat",
    signatureEncoding: "hex",
    publicKeyEncoding: "hex",
    status: "preferred",
    description:
      "UTF-8 concatenation of a fixed template + Ed25519 signature + hex. Federation handshake challenges and heartbeats.",
  },
  "eddsa-jcs-2022": {
    id: "eddsa-jcs-2022",
    algorithm: "Ed25519",
    canonicalization: "jcs",
    signatureEncoding: "multibase-base58btc",
    publicKeyEncoding: "multibase-did-key",
    status: "preferred",
    description:
      "W3C Verifiable Credentials 2.0 Data Integrity cryptosuite (eddsa-jcs-2022). Verifiable Credentials and Presentations.",
  },
});

/**
 * Type guard — narrows `unknown` or arbitrary strings to `SuiteId`.
 * Verifiers MUST call this before dispatching; an unchecked cast is a
 * fail-open path that the `check-suite-dispatch` gate will flag.
 */
export function isSuiteId(value: unknown): value is SuiteId {
  return typeof value === "string" && value in SUITE_REGISTRY;
}

/**
 * Look up a suite entry. Returns `undefined` for unknown IDs so
 * callers can decide rejection semantics at their boundary (verifiers
 * reject fail-closed; tooling may display "unknown suite").
 */
export function getSuiteEntry(id: SuiteId): SuiteEntry;
export function getSuiteEntry(id: string): SuiteEntry | undefined;
export function getSuiteEntry(id: string): SuiteEntry | undefined {
  return SUITE_REGISTRY[id as SuiteId];
}

/**
 * Canonical list of all registered suite IDs, frozen. Consumers that
 * need to iterate (tooling, docs, tests) should use this instead of
 * `Object.keys(SUITE_REGISTRY)` so TypeScript sees the narrow union.
 */
export const ALL_SUITE_IDS: readonly SuiteId[] = Object.freeze([
  "motebit-jcs-ed25519-b64-v1",
  "motebit-jcs-ed25519-hex-v1",
  "motebit-jwt-ed25519-v1",
  "motebit-concat-ed25519-hex-v1",
  "eddsa-jcs-2022",
]);
