---
"@motebit/protocol": minor
---

Sub-phase A of the asset-pluggability commitment named in [`docs/doctrine/off-ramp-as-user-action.md`](../docs/doctrine/off-ramp-as-user-action.md) § "The settlement-asset registry — sub-phase A SHIPPED."

**`SettlementAsset`** — closed union `type SettlementAsset = "USDC"`. Single member at land — USDC is the bootstrap stablecoin. The vocabulary IS the interop boundary: a third-party motebit receiving a sovereign-rail announcement with an unknown asset (`"USDT"`, `"DAI"`) must fail-closed at the type guard, not silently treat it as a settlement asset.

**`ALL_SETTLEMENT_ASSETS`** — frozen iteration array, same shape as `ALL_SETTLEMENT_MODES` / `ALL_EVENT_TYPES`.

**`isSettlementAsset(value: unknown): value is SettlementAsset`** — type guard for narrowing wire-format payloads at intake (discovery responses, signed `SovereignRail` declarations, peer-negotiation messages).

**`SovereignRail.asset` tightened from `string` to `SettlementAsset`** — the structural enforcement site. Reads remain backwards-compatible (a `SettlementAsset` value is still a `string`); implementers of `SovereignRail` outside the monorepo must now produce a value assignable to the closed union. The single in-tree implementer (`SolanaWalletRail` in `@motebit/wallet-solana`) already declared `asset = "USDC" as const`, so no implementation change was required. Adopters of `SovereignRail` who produce an unknown asset symbol will see a TypeScript error and must either register their asset (sub-phase B) or wrap in an adapter.

**Sub-phase B (deferred)** — promotion to the 8th registered registry per `docs/doctrine/registry-pattern-canonical.md` (per-registry coverage gate, perturbation probe, drift-defenses inventory entry, `REGISTERED_REGISTRIES` append) lands when a second asset (PYUSD, USDP, etc.) arrives as a real consumer. The sub-phase-A iteration array + type guard are already shaped so the promotion is a one-line `REGISTERED_REGISTRIES` append plus the per-registry coverage gate, not a refactor.

**Sibling-audit note** (not in this changeset): `SovereignReceiptRequest.asset: string` in `@motebit/runtime` and the matching wire-format declaration in `spec/delegation-v1.md` § 8.1 carry the same semantic. They retain `string` typing pending a follow-on that narrows the HTTP receipt-exchange boundary via the type guard at JSON intake. Two-step approach (type guard at boundary, then tighten the interface) so the tightening is purely additive on the wire format.

**Architectural intent**: the registry membership IS the protocol-vs-product wall named in `docs/doctrine/protocol-primacy.md` — if `"MOTE"` is ever added to `ALL_SETTLEMENT_ASSETS`, it's protocol; if it isn't, it's a motebit-cloud product overlay that converts to/from a protocol-level asset at its boundaries. See the `feedback_no_mote_stablecoin` memory for the current deferral framing.

Composes with the off-ramp arc's prior Layer 1 enforcement shapes (per the `architecture_disjointness_by_construction` memory): surface deletion (`BridgeSettlementRail.withdraw`), marker interface (`WithdrawableGuestRail`), asymmetric typing (`WritableSettlementMode`). Sub-phase A adds the **typed vocabulary** shape — a closed string-literal union whose membership is the protocol-vs-product wall.
