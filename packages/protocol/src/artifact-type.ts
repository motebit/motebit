/**
 * Content-artifact types — the closed registry of `artifact_type` claim
 * values for the C2PA-shape content-provenance primitive
 * (`ContentArtifactManifest` in `@motebit/crypto`).
 *
 * Provenance binding (per `docs/doctrine/self-attesting-system.md` and
 * `docs/doctrine/nist-alignment.md` §8) requires every signed motebit
 * artifact to carry a producer-declared category so a verifier can
 * route, audit, or display the artifact without parsing its bytes.
 * Pre-registry, the category was a free string in the manifest —
 * a typo at a producer site (`artifact_type: "audit_trail"` instead
 * of `"audit-trail"`) became a verifier-side classification miss
 * with no compile-time signal. Locking the registry as a closed
 * union makes the typo a compile error AND a CI error.
 *
 * **Closed registry shape** — same closure pattern as `TokenAudience`,
 * `SuiteId`, `SettlementRail`, `ToolMode`, `ComputerActionKind`. The
 * `ContentArtifactType` literal union is the wire law; named
 * constants are the developer ergonomics. The drift gate
 * `check-artifact-type-canonical` scans every `artifact_type:
 * "<literal>"` and `artifactType: "<literal>"` call against
 * `ALL_CONTENT_ARTIFACT_TYPES`.
 *
 * Adding a category is intentional protocol-level work: a new entry
 * here, a new producer site, the doctrine reference at
 * `docs/doctrine/nist-alignment.md` §8 updated. Same governance as
 * cryptosuite agility (`SuiteId` registry) and audience binding
 * (`TokenAudience` registry).
 *
 * Permissive floor (Apache-2.0), type-only, zero runtime deps.
 */

/**
 * The closed set of content-artifact categories motebit currently
 * signs. Today's set covers the three concrete consumers shipped or
 * pending in this commit series; the rest of the state-export
 * surface migrates as endpoints are wired.
 *
 *   - `audit-trail` — relay-assembled `ToolAuditEntry[]` for a
 *     motebit's session window
 *   - `memory-export` — relay-assembled memory-graph snapshot
 *     (nodes + edges) for a motebit
 *   - `execution-ledger` — relay-assembled execution timeline for a
 *     goal, including inner motebit-signed delegation receipts
 *     (the canonical layered-signing consumer; see
 *     `services/relay/src/state-export.ts` `/api/v1/execution/:motebitId/:goalId`)
 */
export type ContentArtifactType = "audit-trail" | "memory-export" | "execution-ledger";

// === Named constants — same value, narrower type ============================
//
// Callers that import these get `ContentArtifactType` typing without the
// union being inferred from a string-literal at every site. Two ergonomic
// shapes: pass a constant (`EXECUTION_LEDGER_ARTIFACT`) for documentation +
// grep affordance, or inline the literal — the union narrowing catches typos
// in either case.

/** Relay-assembled tool-audit-trail export. */
export const AUDIT_TRAIL_ARTIFACT: ContentArtifactType = "audit-trail";

/** Relay-assembled memory-graph snapshot (nodes + edges). */
export const MEMORY_EXPORT_ARTIFACT: ContentArtifactType = "memory-export";

/**
 * Relay-assembled execution-timeline export with embedded motebit-signed
 * delegation receipts. Canonical layered-signing consumer — outer relay
 * manifest attests bundle assembly, inner motebit signatures pass through
 * byte-identical. See `spec/execution-ledger-v1.md`.
 */
export const EXECUTION_LEDGER_ARTIFACT: ContentArtifactType = "execution-ledger";

// === Iteration + type guard =================================================

/**
 * Canonical iteration order, frozen. Consumers that need to iterate
 * (drift gates, tooling, docs) use this so TypeScript sees the narrow
 * union rather than `string[]`.
 */
export const ALL_CONTENT_ARTIFACT_TYPES: readonly ContentArtifactType[] = Object.freeze([
  "audit-trail",
  "memory-export",
  "execution-ledger",
]);

/**
 * Type guard — narrows `unknown` to `ContentArtifactType`. Drift-gate-driven
 * literal scanners use this to validate strings; verifiers that want to
 * dispatch on category call this before the switch so an unchecked cast
 * is a fail-open path the gate will flag.
 */
export function isContentArtifactType(value: unknown): value is ContentArtifactType {
  return (
    typeof value === "string" && (ALL_CONTENT_ARTIFACT_TYPES as readonly string[]).includes(value)
  );
}
