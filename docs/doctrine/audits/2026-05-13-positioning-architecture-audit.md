# Positioning-architecture audit — 2026-05-13

**Audit scope.** Validate whether motebit's architecture is coherent with the proposed positioning sentence:

> **"Motebit lets AI agents act with identity, trust, permissions, receipts, and settlement. Open protocol. Managed cloud. Relay economy."**

The sentence makes six structural claims (identity, trust, permissions, receipts, settlement, three-layer business). This audit verifies whether each is architecturally real, well-named, and coherent — or surfaces a drift between positioning and code.

**Load-bearing principle.** This audit verifies the constitutional invariant in [`../protocol-primacy.md`](../protocol-primacy.md) — _"motebit is a protocol with a company on top, not a company with a protocol on the side."_ Each "first-class" finding is evidence the protocol-business hierarchy is being respected; each asymmetry finding is potential drift on that hierarchy.

## Audit format

This is the **first entry**; the format below is the template subsequent audits inherit.

**Naming convention.** Files in this directory are dated `YYYY-MM-DD-<scope>-audit.md`. Multiple audits in one day get suffixed (`-a`, `-b`). The date is the audit date, not the artifact-creation date.

**Required sections** (in order):

1. **Audit scope** — the positioning artifact, feature proposal, or strategic claim under review.
2. **Load-bearing principle** — explicit reference to which doctrine memo (`protocol-primacy.md` for positioning audits) the audit is verifying. Each "first-class" finding maps to evidence of the principle holding; each asymmetry to drift on it.
3. **Audit format** (template entries only) — the structural conventions other audits inherit.
4. **Findings** — per-concept or per-claim table with `status` (✅ / ⚠️ / ❌), `canonical owner` (package or file path), and `drift gate` (the `scripts/check-*.ts` enforcing it, if any). Three-status convention: ✅ first-class and well-named; ⚠️ present but fragmented / mis-named / under-articulated; ❌ missing or implicit.
5. **Asymmetries** — each finding marked ⚠️ or ❌ gets its own section with the gap named and the lightweight fix (doctrine-first; code consolidation deferred to real-consumer trigger).
6. **Verdict** — one-sentence headline + the operational implication (e.g., "tagline is shippable" / "needs fix X before shipping" / "structural gap requires architectural work").
7. **Cross-cuts** — links to the doctrine memos the audit's findings reinforce or extend.

**Trigger discipline.** Positioning audits run event-triggered, not scheduled: when the tagline changes, when fundraising materials are refreshed, when the marketing site is rewritten, when a new tier description ships, when a partner integration changes positioning. Quarterly cadence is too frequent for stable language, too infrequent for active pitch development.

**Methodology.** Each audit spawns an Explore agent or runs a direct grep pass across `packages/`, `services/`, `docs/doctrine/`, `scripts/check-*.ts`, and `spec/`. The audit asks per-concept: "where does this live, what enforces it, what doctrine names it." Findings are reported back as the per-claim table. Asymmetries are diagnosed, not prescribed — the fix conversation comes after the verdict.

## Findings

### Six structural claims

| Claim       | Status                    | Canonical owner                                                                                                                   | Drift gate                                                                                                                               |
| ----------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Identity    | ✅                        | `@motebit/core-identity` (Ed25519 + suite-dispatch + branded `MotebitId`/`DeviceId`/`NodeId`)                                     | `check-suite-declared` (#10), `check-suite-dispatch` (#11)                                                                               |
| Trust       | ✅                        | `@motebit/policy` (`computeReputationScore` — Beta-binomial prior + 90-day half-life; `AgentTrustRecord` in protocol)             | `check-reputation-primitives`                                                                                                            |
| Permissions | ✅ (name asymmetry)       | `@motebit/policy` (`PolicyGate` + `RiskLevel` + `SensitivityLevel`)                                                               | `check-sensitivity-routing` (#65)                                                                                                        |
| Receipts    | ✅ (vocabulary asymmetry) | Three types in `@motebit/protocol` unified by JCS+Ed25519: `ExecutionReceipt`, `ToolInvocationReceipt`, `ContentArtifactManifest` | `check-execution-ledger-receipts-archived` (#89), `check-execution-ledger-inner-receipt-verified`, `check-artifact-type-canonical` (#85) |
| Settlement  | ✅                        | `@motebit/settlement-rails` (Guest/Sovereign type-level custody split) + `@motebit/virtual-accounts` + `@motebit/wallet-solana`   | `check-money-boundary`, type-level negative proof in `custody-boundary.test.ts`                                                          |

### Three-layer business

| Layer         | Status | Canonical owner                                                                                                                                                                      | Enforcement                                                                 |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Open Protocol | ✅     | Apache-2.0 permissive floor — 24 specs in `spec/*.md`; `@motebit/protocol` Layer 0; `@motebit/verifier` Apache-2.0 for third-party verification                                      | `check-deps`, `check-spec-coverage`, `check-spec-permissive-boundary`       |
| Managed Cloud | ✅     | `services/relay/src/subscriptions.ts` — $20/mo → $20 credits + 20% margin baked into per-token billing + sovereign fallback                                                          | `check-api-surface` (sdk.api.md), `protocol-primacy.md` audit               |
| Relay Economy | ✅     | `services/relay` — task-routing + federation + 5% fee + p2p settlement via `@motebit/wallet-solana`; relay is convenience-layer-not-trust-root per `services/relay/CLAUDE.md` rule 6 | `check-deploy-parity`, federation circuit-breaker, transparency declaration |

## Asymmetries

### Asymmetry 1: "Permissions" tagline word vs `@motebit/policy` code term

**Status:** ⚠️ vocabulary mismatch.

**Gap.** Pitch sentence says "permissions"; code says "policy" and `PolicyGate`. The two words map to overlapping but not identical concepts: code's "policy" covers sensitivity routing + risk gating + retention enforcement + deletion certificates + fail-closed defaults across multiple axes (broader than user-permissions). Pitch's "permissions" maps mentally to "what an app is allowed to access" (narrower, consumer-shaped).

**Diagnosis from second-pass review.** Neither "policy" nor "permissions" captures what's distinctive about motebit's architecture. The distinctive primitive is **delegation** — cryptographically-verifiable authorization that agents act _on behalf of_ a user, can be proven, revoked, and follows the user across platforms. Delegation IS architecturally present in the codebase (`packages/runtime/src/relay-delegation.ts`, `delegate_to_agent` tool, delegation chains in receipts, A2A delegation via federation) but is under-articulated doctrinally — no `docs/doctrine/delegation.md` exists despite the primitive being load-bearing.

**Lightweight fix (deferred to its own conversation).** Three artifacts in sequence: (1) write `docs/doctrine/delegation.md` grounded in the existing code surface; (2) swap "permissions" → "delegation" in the tagline candidate, citing the new doctrine; (3) add a one-paragraph note in `packages/policy/CLAUDE.md` clarifying that policy covers what consumer-facing material calls "delegation" (same concept, different audience precision). Order matters: doctrine first, then tagline, then cross-reference — reversed order creates forward references to artifacts that don't yet exist.

### Asymmetry 2: "Receipts" (singular concept) vs three distinct receipt types

**Status:** ⚠️ discoverability gap.

**Gap.** Pitch sentence says "receipts"; code has three distinct types (`ExecutionReceipt`, `ToolInvocationReceipt`, `ContentArtifactManifest`) scattered across `@motebit/protocol`, `@motebit/encryption`, and `services/relay/src/receipts-store.ts`. The three are architecturally cohesive (same JCS canonicalization, same Ed25519 signing, same independent verifier in `@motebit/verifier`) but a newcomer searching for "the receipts code" hits three locations and has to assemble the unification mentally. There is no `@motebit/receipts` package.

**Lightweight fix (shipped concurrently with this audit).** New doctrine memo [`receipts-unified.md`](../receipts-unified.md) names the three types as one family with one verification path. The doctrine becomes the discoverability surface. The `@motebit/receipts` facade package is deferred to a real-consumer trigger (third-party verifier, audit partner, external integrator hitting the discoverability problem twice).

## Verdict

**The tagline is shippable.** Architecture matches positioning. Six concepts × four canonical owner clusters × 85 drift gates × seven-layer DAG × 24 protocol specs = the structure is real, not vapor.

Two asymmetries identified — one resolved immediately (receipts-unified.md ships with this audit), one deferred to its own conversation (delegation doctrine + tagline word + cross-reference, in that order). Neither asymmetry is a blocker; both are sharpening opportunities.

The positioning-architecture isomorphism is now **falsifiable**: a future audit of the same tagline against the same codebase should produce the same per-claim table or surface a specific drift. That's the structural property this audit pattern exists to preserve.

## Cross-cuts

- [`../protocol-primacy.md`](../protocol-primacy.md) — the constitutional invariant this audit verifies; every "first-class" finding is evidence of the principle holding.
- [`../receipts-unified.md`](../receipts-unified.md) — the doctrine memo shipped concurrently to close asymmetry 2.
- [`../agility-as-role.md`](../agility-as-role.md) — naming convention for closed-set additive registries; cryptosuite + ByokVendor + settlement-rail registries cited in findings.
- [`../self-attesting-system.md`](../self-attesting-system.md) — every claim user-verifiable; receipts are the structural implementation.
- [`../settlement-rails.md`](../settlement-rails.md) — custody-split type-level enforcement; basis for settlement finding.
- [`../../drift-defenses.md`](../../drift-defenses.md) — 85 drift gates inventory; the audit cites specific gates as evidence per claim.

## Future audits referencing this entry

When a subsequent audit runs (next tagline change, fundraising-deck refresh, etc.), it inherits the format above and produces a comparable artifact. The longitudinal record across `docs/doctrine/audits/` becomes the structural drift-detection surface — pitch-vs-code drift becomes diff-able the same way code-vs-doctrine drift is gate-checkable.
