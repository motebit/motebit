/**
 * Evidence provenance — the re-verifiable shape an {@link EvidenceRef} MAY carry
 * so a `VerificationVerdict`'s evidence axis stops being a bare pointer and
 * becomes locally re-checkable down to the primary record. Verifiable-locality
 * extended from signatures to EVIDENCE (agency.computer co-design, 2026-06).
 *
 * The law (see `@motebit/crypto` `verifyEvidenceProvenance`): the named `span`
 * is an exact substring of `projection(bytes)`, where the bytes are
 * content-addressed by `digest`. It re-verifies PRESENCE — "is this claim backed
 * by a primary record?" — never TRUTH, and with no oracle: the bytes either
 * contain the span or they don't.
 *
 * Domain-blindness is load-bearing. The protocol carries the SLOT (the opaque,
 * app-owned `projection` recipe id) and the verifier re-applies whatever the
 * consumer injects; motebit never owns a projection catalog — that would be
 * document-format authority. `binding` is an opaque resolved-identity reference
 * the protocol carries but does NOT verify — who counts as a valid issuer is
 * app-layer.
 */

/**
 * Content-digest hash algorithm. A digest names a HASH (the content is hashed,
 * not signed), so it rides its own role here rather than `SuiteId` (the
 * signature-suite registry). Agile by registry append (agility-as-role);
 * `sha-256` today, a post-quantum or alternative hash is one entry.
 */
export type DigestAlgorithm = "sha-256";

export const ALL_DIGEST_ALGORITHMS: readonly DigestAlgorithm[] = Object.freeze(["sha-256"]);

export function isDigestAlgorithm(s: string): s is DigestAlgorithm {
  return (ALL_DIGEST_ALGORITHMS as readonly string[]).includes(s);
}

/** Content address of the raw, independently-obtainable bytes. */
export interface DigestRef {
  /** Hash algorithm — the role, never baked into a field name. */
  readonly algorithm: DigestAlgorithm;
  /** Lowercase hex digest of the raw bytes under `algorithm`. */
  readonly value: string;
}

/**
 * The re-verifiable provenance an {@link EvidenceRef} may carry. The property
 * holds when EITHER `projection` is absent (the span is located over the raw
 * bytes directly — re-verifiable by construction) OR the named recipe is spec'd
 * to byte-determinism (a third party reimplements it from its spec to byte
 * identity; proven by a projection-divergence conformance fixture, never one
 * implementation checked against itself).
 */
export interface EvidenceProvenance {
  /**
   * Digest of the RAW, independently-obtainable bytes (e.g. the raw filing a
   * third party fetches from the primary source) — NEVER the projected text.
   * This is the half that is re-verifiable with no shared code.
   */
  readonly digest: DigestRef;
  /**
   * Opaque, APP-OWNED projection recipe id (e.g. an issuer's declared HTML→text
   * spec). Absent ⇒ the span is located over the raw bytes directly. Present ⇒ a
   * re-verifier applies the consumer-injected recipe before confirming the span;
   * with no injected resolver the check fails closed. motebit carries the id and
   * re-applies it; the recipe CATALOG and SPEC are the consumer's.
   */
  readonly projection?: string;
  /** The verbatim span asserted PRESENT in `projection(bytes)` — the law's subject. */
  readonly span: string;
  /**
   * Advisory locator narrowing where the span sits. NOT load-bearing: the law is
   * exact-substring presence, so the locator only disambiguates a search — it is
   * never a second thing a re-verifier must reproduce.
   */
  readonly locator?: { readonly start: number; readonly end: number };
  /**
   * Opaque resolved-identity reference the evidence is bound to (a `motebit_id`
   * or a domain-identity token the consumer resolves). Carried, NOT verified by
   * the law — issuer authority is app-layer (domain-blind).
   */
  readonly binding?: string;
}

/**
 * A piece of evidence a `VerificationVerdict`'s `evidenceBasis` cites. The bare
 * `{ kind, ref }` is a POINTER (what the verdict used); the optional
 * `provenance` makes it locally re-verifiable down to the primary record.
 * Back-compat by absence — a producer that does not retrieve emits `{ kind, ref }`
 * exactly as before, so the whole verdict family stays wire-compatible.
 */
export interface EvidenceRef {
  /** e.g. "receipt", "public_key", "revocation_root", "anchor", "document". */
  readonly kind: string;
  /** The evidence value or locator (hash, hex key, root, slot). */
  readonly ref: string;
  /** Optional re-verifiable provenance (a content-addressed span in a primary record). */
  readonly provenance?: EvidenceProvenance;
}
