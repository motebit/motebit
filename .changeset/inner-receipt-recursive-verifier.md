---
"@motebit/crypto": minor
"@motebit/state-export-client": minor
"@motebit/verify": minor
---

Ship the consumer side of v1.1 inner-receipt recursive verification. Closes the producer-consumer arc the previous commit opened — the v1.1 wire change is no longer invisible truth, every shipping verifier now demands the inner signatures.

**`@motebit/crypto`** — `verifyReceipt` is now publicly exported (was internal-only). Verifies a single `ExecutionReceipt`'s Ed25519 signature against its embedded `public_key` and walks `delegation_receipts` recursively for multi-hop chains. Returns the standard `ReceiptVerifyResult` shape used elsewhere in the package.

**`@motebit/state-export-client`** — new export `verifyInnerSignedReceipts(body)`:

```ts
import { verifyInnerSignedReceipts } from "@motebit/state-export-client";

const result = await verifyInnerSignedReceipts(body);
if (result.applicable) {
  console.log(`${result.verifiedCount}/${result.totalCount} inner receipts verified`);
  for (const r of result.results) {
    if (!r.valid) console.error(`✗ ${r.taskId} (${r.motebitId}): ${r.reason}`);
  }
}
```

Parses each entry in `signed_receipts: string[]` as an `ExecutionReceipt`, calls `verifyReceipt`, returns a per-receipt verdict. Detects v1.1 bodies by checking `spec === "motebit/execution-ledger@1.1"` plus a non-empty `signed_receipts` field; returns `applicable: false` for v1.0 bodies, non-execution-ledger bodies, and non-object input. Five typed failure reasons: `malformed_json`, `missing_public_key`, `signature_invalid`, `delegation_failed`, `unknown`. Browser-safe — same dep boundary as the rest of the package.

**`@motebit/verify`** — `motebit-verify content-artifact` auto-invokes the recursive verifier whenever the manifest's `artifact_type === "execution-ledger"` and the body declares v1.1. No flag required (calm-software default — silent when the field doesn't apply). Per-receipt outcomes surface in both human output and `--json` output. Exit code now gates on outer AND inner — a v1.1 bundle where any inner receipt fails (`signature_invalid`, etc.) fails the overall verification even when the relay's outer signature is valid: the relay is correctly attesting bytes it assembled, but those bytes contain falsified inner claims.

**Why this matters:** the v1.1 producer commit shipped byte-identical inner receipts into a void — no consumer recursively verified. Today, every motebit-verify run audits inner signatures end-to-end. A federation peer with the relay's transparency-pinned key + a cross-relay state-export + `motebit-verify` can audit every motebit's claim inside without trusting the relay or any intermediary. Cross-relay verification becomes operationally complete, not just structurally possible.

Drift-locked by `check-execution-ledger-inner-receipt-verified` (drift-defense #90): the gate scans the state-export-client primitive home, the package re-export, and the CLI's import + call site; a refactor that disconnects the consumer-side wiring fails CI.

Doctrine: `spec/execution-ledger-v1.md` §4.3; `docs/doctrine/nist-alignment.md` §8 "Inner-receipt verifier shipped 2026-05-12."
