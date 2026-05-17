---
"@motebit/crypto": minor
---

Tightens `SovereignPaymentReceiptInput.asset` from `string` to `SettlementAsset` (re-exported from `@motebit/protocol`). Composes with the sub-phase A asset-pluggability commitment in [`docs/doctrine/off-ramp-as-user-action.md`](../docs/doctrine/off-ramp-as-user-action.md) § "The settlement-asset registry — sub-phase A SHIPPED" — the closed asset vocabulary now reaches the deepest wire-format presence in the codebase (the signed receipt body), not just the sovereign rail interface.

**Why this closes a coherency gap**: the asset value is embedded in the signed receipt's `result` string via canonical JSON, so it lives in the cryptographically-bound payload that downstream verifiers, federation peers, and audit consumers all read. Leaving the signing-input type as `string` while its sibling `SovereignRail.asset` (in `@motebit/protocol`) was tightened to `SettlementAsset` would have left the receipt-construction site as the asymmetric weak link.

**Migration**: callers of `signSovereignPaymentReceipt(input, ...)` who pass an unknown asset symbol (anything other than `"USDC"` today) will fail to typecheck. Use a registered asset, or wait for sub-phase B to add a new asset to the registry. The single in-tree caller chain (`MotebitRuntime.handleSovereignReceiptRequest` → `signSovereignPaymentReceipt`) already passes `request.asset` forwarded from `SovereignReceiptRequest.asset`, which is tightened in lockstep in `@motebit/runtime` (private package; type chain compiles end-to-end).

**Boundary defense (not in this changeset)**: the HTTP transport (`@motebit/runtime`'s `http-receipt-exchange.ts`) narrows the incoming wire payload's `asset` field via `isSettlementAsset` at intake and fails-closed with HTTP 400 on unknown values. This is the structural complement to the type-level tightening: TypeScript-checks for in-process callers, type-guard validation for external wire payloads. Together they make "the signed receipt body always carries a registered asset" structurally true regardless of how the receipt was produced.

**Sibling sites in lockstep** (no changesets, both private packages):

- `@motebit/runtime`'s `SovereignReceiptRequest.asset` tightened to `SettlementAsset`
- `@motebit/runtime`'s `http-receipt-exchange.ts` validates via `isSettlementAsset` at intake
- `spec/delegation-v1.md` § 8.1 wire-format annotation updated to `SettlementAsset`

Same shape as the `@motebit/protocol` sub-phase A changeset (`settlement-asset-sub-phase-a.md`) — minor bump with implementer-break note, matching the Arc 3 `WritableSettlementMode` precedent.
