---
"@motebit/protocol": minor
---

Extend `motebit/execution-ledger` from v1.0 to v1.1 — additive, non-breaking. The `GoalExecutionManifest` reconstruction shape gains an optional `signed_receipts?: string[]` field carrying byte-identical canonical-JSON of each delegated motebit's signed `ExecutionReceipt`. New constants `EXECUTION_LEDGER_SPEC_V1_0` and `EXECUTION_LEDGER_SPEC_V1_1` for type-safe spec-version literals.

```ts
import { type GoalExecutionManifest, EXECUTION_LEDGER_SPEC_V1_1 } from "@motebit/protocol";

// v1.1 bodies carry signed_receipts when the relay has the byte-identical archive
const ledger = (await fetch(`${relay}/api/v1/execution/${motebitId}/${goalId}`).then((r) =>
  r.json(),
)) as GoalExecutionManifest;

if (ledger.spec === EXECUTION_LEDGER_SPEC_V1_1 && ledger.signed_receipts) {
  for (const receiptJson of ledger.signed_receipts) {
    const receipt = JSON.parse(receiptJson);
    // Verify each inner motebit's signature independently — no relay trust required.
    // The bytes are canonical-JSON byte-identical with what the motebit signed.
  }
}
```

**Why this closes the operator-trust gap:**

Before v1.1, `delegation_receipts` carried `signature_prefix` — the first 16 characters of the motebit's Ed25519 signature. Display-only, not verifiable. A relay could falsely claim "motebit X did this work" and a verifier had to trust the relay's word (the outer relay-signed manifest on the bundle attests to bundle assembly, not to inner motebit attestation).

With v1.1, the verifier holds the byte-identical canonical JSON of each inner `ExecutionReceipt` — sourced from the relay's `relay_receipts.receipt_json` archive (per `services/relay/CLAUDE.md` Rule 11). Each entry parses to a full `ExecutionReceipt`, including its `public_key`, `suite`, and `signature` fields. The verifier checks each Ed25519 signature against the named motebit's public key, independent of the relay. A relay that lies about which motebit did the work is detectable; cross-relay verification becomes possible; federation peers can audit each other's claims.

**Why this is additive, not breaking:**

- v1.0 consumers continue to parse v1.1 bodies — JSON.parse ignores the unknown `signed_receipts` field
- Relays that don't have the archive populated (testnet, ephemeral deploys, partial sync) continue to emit `spec: "motebit/execution-ledger@1.0"` — graceful degradation
- The spec literal type widens from `"motebit/execution-ledger@1.0"` to `"motebit/execution-ledger@1.0" | "motebit/execution-ledger@1.1"`; consumers narrowing on the v1.0 literal will see a TypeScript widening but their runtime behavior continues

Producer wiring lives in `services/relay/src/state-export.ts` (BSL, reference relay). Drift gate `check-execution-ledger-receipts-archived` (drift-defense #89) prevents silent regression back to v1.0 summary-only semantics.

Doctrine: `spec/execution-ledger-v1.md` §4.3 (Inner Signed Receipts — v1.1 additive); `docs/doctrine/nist-alignment.md` §8 "Inner-receipt verification closed 2026-05-11"; `docs/doctrine/self-attesting-system.md` extends to relay-assembled bundles now that inner signatures pass through byte-identical.
