---
"@motebit/protocol": major
"@motebit/crypto": minor
"@motebit/encryption": minor
"@motebit/wire-schemas": minor
---

Sign SettlementRecord — protocol-layer support. Closes audit
finding #1 from the cross-plane review.

`services/api/CLAUDE.md` rule 6 states: "Every truth the relay
asserts (credential anchor proofs, revocation memos, settlement
receipts) is independently verifiable onchain without relay
contact." Federation settlements deliver this through Merkle
batching + onchain anchoring (relay-federation-v1.md §7.6). **Per-
agent settlements did not** — the wire format was unsigned, so a
relay could issue inconsistent records to different observers (e.g.
show the worker `{amount_settled: 95, fee: 5}` and an auditor
`{amount_settled: 80, fee: 20}`) and both would "validate" because
no signature committed the relay to either claim.

This commit adds the protocol-layer self-attestation primitive:

- `SettlementRecord` gains `issuer_relay_id` + `suite` + `signature`
  fields (`@motebit/protocol`)
- `signSettlement(record, issuerPrivateKey)` and
  `verifySettlement(record, issuerPublicKey)` shipped in
  `@motebit/crypto`, re-exported from `@motebit/encryption`
- `@motebit/wire-schemas` SettlementRecord flips back to `.strict()`
  with the three new required fields; `additionalProperties: false`
  in the published JSON Schema
- Spec `delegation-v1.md` §6.3 wire-format table updated; §6.4
  foundation law adds: "Every emitted SettlementRecord MUST be
  signed by its issuer_relay_id. The signature covers the entire
  record except `signature` itself, including `amount_settled`,
  `platform_fee`, and `platform_fee_rate` — committing the relay
  to the exact values it published. A relay that issues
  inconsistent records to different observers fails self-
  attestation: at most one of the records verifies."

Crypto-layer round-trip + tampering tests added: amount tampering,
fee_rate tampering, wrong-key, unknown-suite all reject as
expected. Determinism (same input → same signature) verified.

## Migration

`SettlementRecord.issuer_relay_id`, `suite`, and `signature` are
now required fields in the wire format. Any consumer constructing
a `SettlementRecord` literal must add them:

```diff
 const record: SettlementRecord = {
   settlement_id: "...",
   allocation_id: "...",
   receipt_hash: "...",
   ledger_hash: null,
   amount_settled: 950_000,
   platform_fee: 50_000,
   platform_fee_rate: 0.05,
   status: "completed",
   settled_at: Date.now(),
+  issuer_relay_id: "<relay motebit_id>",
+  suite: "motebit-jcs-ed25519-b64-v1",
+  signature: "<base64url Ed25519 over canonical body minus signature>",
 };
```

Use `signSettlement(unsignedRecord, issuerPrivateKey)` from
`@motebit/crypto` (or `@motebit/encryption`) to produce a valid
signed record from the body fields:

```ts
import { signSettlement } from "@motebit/encryption";

const signed = await signSettlement(
  {
    settlement_id,
    allocation_id,
    receipt_hash,
    ledger_hash,
    amount_settled,
    platform_fee,
    platform_fee_rate,
    status,
    settled_at,
    issuer_relay_id,
  },
  relayPrivateKey,
);
// signed.suite + signed.signature are now set
```

Verifiers use `verifySettlement(record, issuerPublicKey)` —
returns `true` only if the signature matches the canonical body
under the embedded suite.

`@motebit/api` (services/api) is NOT updated by this commit. The
SettlementRecord-shaped output the relay produces today will fail
the new wire schema validation until the relay integration commit
(C) lands. That commit adds the `signature` column to
`relay_settlements`, signs at INSERT time, and emits the signed
shape on the audit-facing endpoints. The protocol-layer ships
first so the contract is unambiguous before consumer code is
modified.

Drift defense #22 (zod ↔ TS ↔ JSON) and #23 (spec ↔ schema) both
green after `api:extract` baseline refresh.
