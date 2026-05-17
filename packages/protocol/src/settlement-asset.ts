/**
 * Settlement-asset types — the closed vocabulary of stablecoin assets
 * the protocol clears settlement in.
 *
 * Permissive floor (Apache-2.0). Layer 0. Sub-phase A of the
 * asset-pluggability commitment named in
 * [`docs/doctrine/off-ramp-as-user-action.md`](../../../docs/doctrine/off-ramp-as-user-action.md)
 * § "Asset pluggability":
 *
 *   > "settlement is asset-pluggable. USDC is the bootstrap stablecoin.
 *   > A `SettlementAsset` closed union (`"USDC"` only at land) with a
 *   > bespoke coverage test should ship as sub-phase A of this arc — a
 *   > typed vocabulary consumers can reference, promoted to the 8th
 *   > registered registry per `registry-pattern-canonical.md` when a
 *   > second asset (PYUSD, USDP, etc.) arrives as a real consumer
 *   > (sub-phase B)."
 *
 * Sub-phase A intentionally stops short of the full eight-artifact
 * registered-registry set: the per-registry coverage gate, perturbation
 * probe, drift-defenses inventory entry, and `REGISTERED_REGISTRIES`
 * append are deferred until a second asset materializes as a real
 * consumer. With a single literal there is no cross-implementation
 * drift surface to defend against yet; the four criteria in
 * [`docs/doctrine/registry-pattern-canonical.md`](../../../docs/doctrine/registry-pattern-canonical.md)
 * § "When to add a registry to `REGISTERED_REGISTRIES`" require "real
 * or anticipated drift," which this sub-phase does not meet. What it
 * does meet: interop law (the field is signed on `SovereignRail` and
 * read by independent verifiers), multi-consumer (rail + relay book-
 * keeping + agent discovery), wire-format presence (`SovereignRail.asset`
 * is the protocol-shaped boundary). Three of four criteria → bespoke
 * coverage; the fourth criterion gates the registry promotion.
 *
 * **The registry membership IS the protocol-vs-product wall** (per the
 * off-ramp doctrine memo's "asset-pluggability" section): if `"MOTE"`
 * is ever added to `ALL_SETTLEMENT_ASSETS`, it's protocol; if it
 * isn't, it's a motebit-cloud product overlay that converts to/from a
 * protocol-level asset at its boundaries. A future MOTE stablecoin is
 * **not** an architectural endpoint — it's a candidate motebit-cloud
 * convenience product, evaluated against asset-pluggability when its
 * compliance, market, and economic case can stand on its own
 * (deferred per the `feedback_no_mote_stablecoin` memory).
 *
 * Semantic note — `SettlementAsset` is distinct from "currency".
 * `BatchWithdrawalItem.currency`, `DepositResult.currency`,
 * `WithdrawalResult.currency`, `CapabilityPrice.currency`, and
 * `BudgetAllocation.currency` retain `string` typing because they
 * mix fiat ("USD" via Stripe) and stablecoin ("USDC" via x402) across
 * guest-rail kinds. Only fields whose semantic is unambiguously a
 * settlement asset — `SovereignRail.asset` is the canonical site —
 * tighten to this closed union. The fiat/stablecoin distinction lives
 * at the rail-kind boundary, not in this vocabulary.
 */

// === Settlement Asset ===

/**
 * The closed set of stablecoin assets the protocol clears settlement in.
 *
 * Single member at land — USDC is the bootstrap stablecoin. Additions
 * are intentional protocol-level work (sub-phase B): new union member +
 * `ALL_SETTLEMENT_ASSETS` entry + sibling-rail support + registry-
 * pattern-canonical promotion to the 8th registered registry.
 *
 * Why a closed union, not `string`: a third-party motebit implementation
 * receiving a `SovereignRail.asset` value of `"USDT"` or `"DAI"` from a
 * peer should fail-closed (unknown asset) rather than silently continue.
 * The vocabulary IS the interop boundary.
 */
export type SettlementAsset = "USDC";

/**
 * Canonical iteration order over `SettlementAsset`, frozen. The single
 * source of truth for "every settlement asset" — exhaustive switches,
 * bookkeeping enumerations, and the future per-registry coverage gate
 * (sub-phase B) enumerate through this array.
 *
 * Same shape as `ALL_SUITE_IDS`, `ALL_TOKEN_AUDIENCES`,
 * `ALL_CONTENT_ARTIFACT_TYPES`, `ALL_TASK_SHAPES`,
 * `ALL_SENSITIVITY_LEVELS`, `ALL_EVENT_TYPES`, `ALL_SETTLEMENT_MODES`.
 * The array shape is established before the registry is registered so
 * that the sub-phase B promotion is a one-line `REGISTERED_REGISTRIES`
 * append, not a refactor.
 */
export const ALL_SETTLEMENT_ASSETS: readonly SettlementAsset[] = Object.freeze([
  "USDC",
] as SettlementAsset[]);

/**
 * Type guard — narrows `unknown` to `SettlementAsset`. Consumers that
 * derive settlement-asset values from external sources (peer rail
 * announcements, signed `SovereignRail` declarations, discovery
 * responses) call this before dispatching so an unchecked cast is a
 * fail-open path the type system can't catch.
 *
 * Same shape as `isSuiteId`, `isTokenAudience`, `isContentArtifactType`,
 * `isTaskShape`, `isSensitivityLevel`, `isEventType`, `isSettlementMode`.
 */
export function isSettlementAsset(value: unknown): value is SettlementAsset {
  return typeof value === "string" && (ALL_SETTLEMENT_ASSETS as readonly string[]).includes(value);
}
