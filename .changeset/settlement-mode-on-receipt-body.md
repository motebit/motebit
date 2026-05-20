---
"@motebit/protocol": major
---

Add `settlement_mode: SettlementMode` as a required field on the signed `SettlementRecord` body — lane discriminant (`"relay"` vs `"p2p"`) is now part of the relay's attestation, not derivable from sibling fields. Doctrine: [`docs/doctrine/settlement-rails.md`](https://github.com/motebit/motebit/blob/main/docs/doctrine/settlement-rails.md) § "Lanes for external readers".

**Why this is a major bump.** Adding a required field to an interface is a breaking change for any caller constructing a `SettlementRecord` (directly or through `signSettlement(Omit<SettlementRecord, "signature" | "suite">, ...)`). External code that built receipts under the prior shape will fail to typecheck until it supplies the new field.

The custody split was already enforced at the type level (`GuestRail` vs `SovereignRail`), and the agent-registry already carried `settlement_modes: "relay" | "p2p"`, but the lane was missing from the per-settlement signed body. An auditor reading a `SettlementRecord` previously had to derive the custody posture from `custody × settlement_mode-on-table × x402_tx_hash-presence`. Now the lane is a required wire field on the signed receipt: instantly legible, signed into the canonical bytes, and structurally impossible for a relay to silently relabel after the fact.

Putting the lane inside the signature commits the relay to a specific custody posture per settlement. Tamper with `settlement_mode` and the Ed25519 signature stops verifying — same self-attestation contract as `amount_settled` and `platform_fee_rate`. This closes the legibility-but-not-architecture gap: graduation from `"relay"` to `"p2p"` was already mechanized via `evaluateSettlementEligibility`, but the lane chosen for each individual settlement was inferred, not declared.

**Reuses an existing registry.** `SettlementMode` is the seventh registered registry per [`registry-pattern-canonical.md`](https://github.com/motebit/motebit/blob/main/docs/doctrine/registry-pattern-canonical.md) — promoted 2026-05-15. This change adds a new wire-format consumer of the existing closed union; no new vocabulary, no new registry, no naming drift. `"treasury"` is deliberately not a member: treasury reconciliation is structurally a different audit shape (own-account operator fee accrual vs onchain balance) and never appears as a settlement lane.

## Migration

Before:

```ts
const record: SettlementRecord = {
  settlement_id,
  allocation_id,
  receipt_hash,
  ledger_hash,
  amount_settled,
  platform_fee,
  platform_fee_rate,
  status: "completed",
  settled_at,
  issuer_relay_id,
  suite: "motebit-jcs-ed25519-b64-v1",
  signature,
};
```

After:

```ts
const record: SettlementRecord = {
  settlement_id,
  allocation_id,
  receipt_hash,
  ledger_hash,
  amount_settled,
  platform_fee,
  platform_fee_rate,
  settlement_mode: "relay", // NEW — required; "relay" or "p2p"
  status: "completed",
  settled_at,
  issuer_relay_id,
  suite: "motebit-jcs-ed25519-b64-v1",
  signature,
};
```

Pick the lane by custody intent: `"relay"` when the relay holds the money (virtual-account credit/debit on its books — the default for guest-rail settlement), `"p2p"` when funds move agent-to-agent onchain via a `SovereignRail` and the relay records the audit only.

If you read pre-migration rows from a database, default to `"relay"` — the prior schema's only persisted lane was relay-custody since p2p audit rows already wrote their lane explicitly via raw SQL.

Rationale: the lane belongs in the signed body, not in storage-side metadata. A relay that custodied a settlement cannot retroactively relabel it as p2p; the signature commits the relay to its claimed custody posture. Auditors and counsel reading a single `SettlementRecord` should see the lane directly without consulting sibling fields or table-level defaults.
