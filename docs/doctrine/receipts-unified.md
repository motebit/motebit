# Receipts — three types, one family

Motebit's signed-receipt surface is three types in three packages, unified by one cryptographic shape and one verification path. The positioning sentence's "receipts" claim points at this family, not at any single type. This memo names the family so future contributors find the unification by reading, not by reconstruction.

## The three types

| Type                      | Signed by                | Granularity               | Spec                                                                                     | Owner               |
| ------------------------- | ------------------------ | ------------------------- | ---------------------------------------------------------------------------------------- | ------------------- |
| `ExecutionReceipt`        | Agent (motebit identity) | Per-task / per-goal       | [`spec/execution-ledger-v1.md`](../../spec/execution-ledger-v1.md)                       | `@motebit/protocol` |
| `ToolInvocationReceipt`   | Agent (motebit identity) | Per-tool-call             | [`spec/execution-ledger-v1.md`](../../spec/execution-ledger-v1.md) §4                    | `@motebit/protocol` |
| `ContentArtifactManifest` | Relay identity           | Per-bundle (state export) | [`packages/protocol/src/artifact-type.ts`](../../packages/protocol/src/artifact-type.ts) | `@motebit/protocol` |

Three distinct types with three distinct attestation roles. They are NOT redundant — each answers a different question:

- **`ExecutionReceipt`** — "what did this agent accomplish, end-to-end, on this goal?" Agent-signed; the whole-task proof.
- **`ToolInvocationReceipt`** — "what did this agent do in this single tool call?" Agent-signed; per-step granularity for auditors who need to trace not just outcomes but each act.
- **`ContentArtifactManifest`** — "the relay assembled this bundle of agent-signed artifacts at time T." Relay-signed wrapper that lets a third party verify bundle assembly without trusting the relay's word about agent identity (because the inner agent-signed receipts verify independently).

## What unifies them

Every receipt across all three types satisfies the same five invariants:

1. **JCS-canonicalized** — RFC 8785 JSON Canonicalization Scheme, byte-identical across implementations.
2. **Ed25519-signed** — via the `SuiteId` registry in `@motebit/protocol`; suite-dispatched verification in `@motebit/crypto`. Cryptosuite-agile per [`agility-as-role.md`](agility-as-role.md) — PQ migration is a registry append, not a wire-format break.
3. **Independently verifiable** — `@motebit/verifier` (Apache-2.0, permissive floor, zero monorepo deps) verifies any receipt offline without relay contact.
4. **Identity-bound** — every signature binds to a specific `MotebitId` or relay `RelayIdentity` public key; receipts are not anonymous.
5. **Append-only at storage** — the relay's `relay_receipts.receipt_json` column is byte-identical to the canonical serialization at write time (per [`services/relay/CLAUDE.md`](../../services/relay/CLAUDE.md) rule 11); never re-serialized through a non-JCS path.

The five invariants are protocol-level. Per [`protocol-primacy.md`](protocol-primacy.md), they apply whether the user pays motebit-cloud, brings their own keys, or runs on-device. Receipts are not a subscription benefit — they're a baseline property of every motebit identity.

## The verification path

A third party verifying any receipt:

1. Reads the receipt's `suite` field (e.g., `"motebit-jcs-ed25519-b64-v1"`).
2. Looks up the verification arm in `@motebit/crypto`'s `verifyBySuite` dispatch.
3. Reconstructs the canonical JSON via JCS.
4. Verifies the Ed25519 signature against the named identity's public key.
5. For nested chains (delegation receipts within tasks, inner agent receipts within manifests), recurses.

The CLI tool `motebit-verify` (in `@motebit/verify`) bundles this path for end-users: `motebit-verify execution-receipt <json>`, `motebit-verify content-artifact <json> --producer-key <hex>`. Apache-2.0, ships in a published npm package. Federation peers, regulatory auditors, and third-party validators consume this surface.

## Why three types instead of one

The natural question: if the unification is so strong, why aren't they one type with discriminants?

Three distinct types because **different parties sign, on different cadences, for different consumers**:

- An agent signs `ToolInvocationReceipt` immediately on tool dispatch — the receipt's purpose is forensic per-action proof.
- An agent signs `ExecutionReceipt` at task completion — the receipt's purpose is end-to-end outcome attestation.
- The relay signs `ContentArtifactManifest` on export bundling — the receipt's purpose is "this is what I assembled at time T," which the relay can attest to but cannot fake (because inner agent-signed receipts verify independently).

Collapsing the three into one type with discriminants would hide the signer-asymmetry. The relay cannot sign agent-level claims; the agent cannot sign bundle-assembly claims. Three types make the trust boundary structurally legible.

This is the same architectural principle as the settlement-rail custody split per [`settlement-rails.md`](settlement-rails.md): different custody regimes need different types so the boundary stays compile-time-enforceable.

## What's NOT yet unified, and why

There is no `@motebit/receipts` package that re-exports the three types under one namespace. Future contributors looking for "the receipts code" find:

- Type definitions in `@motebit/protocol/src/index.ts` + `artifact-type.ts`
- Signing primitives in `@motebit/encryption` (`signExecutionReceipt`, `signContentArtifact`)
- Archive + retrieval in `services/relay/src/receipts-store.ts`
- Verification entry point in `@motebit/verifier`
- CLI tool in `@motebit/verify`

The pieces are coherent by design (same crypto suite, same canonicalization, same verifier), but they're spread across five places. This is a **discoverability gap**, not an architectural one.

**Deferral rationale.** A `@motebit/receipts` facade package would consolidate the namespace and improve newcomer onboarding, but adding it now would be premature — the doctrine-first / code-second pattern (per the four-part typed-truth promotion in [`runtime-invariants-over-prompt-rules.md`](runtime-invariants-over-prompt-rules.md)) says doctrine names the unification first; code consolidation follows when a real consumer hits the discoverability problem.

The trigger for shipping `@motebit/receipts` as a facade package: a third-party verifier, audit partner, regulatory body, or external integrator hitting "where do I import the unified type from?" twice. At that point the cost is paid for; before that point it's speculative consolidation.

Until then, this doctrine memo IS the unification surface. Future contributors searching for "receipts" find this memo via `grep` in `docs/doctrine/`, follow the table to the canonical owners, and read the verification path. That's the lightweight fix the audit identified.

## Cross-cuts

- [`self-attesting-system.md`](self-attesting-system.md) — every claim is user-verifiable; receipts are the structural implementation of that principle.
- [`protocol-primacy.md`](protocol-primacy.md) — receipts are protocol-level, available to every motebit regardless of subscription. The convenience-tier may extend retention; it cannot gate the existence.
- [`nist-alignment.md`](nist-alignment.md) — receipt verification is one of the eight asks the NCCoE submission shipped against; structurally bound to code via `check-execution-ledger-receipts-archived` (#89) and `check-execution-ledger-inner-receipt-verified`.
- [`services/relay/CLAUDE.md`](../../services/relay/CLAUDE.md) rule 11 (`relay_receipts.receipt_json` append-only byte-identical) + rule 17 (`state-export.ts` envelope signing via `emitSignedExport`).
- [`spec/execution-ledger-v1.md`](../../spec/execution-ledger-v1.md) — the canonical wire spec for `ExecutionReceipt` + `ToolInvocationReceipt`.
- [`packages/protocol/src/artifact-type.ts`](../../packages/protocol/src/artifact-type.ts) — the canonical artifact-type registry for `ContentArtifactManifest`.
