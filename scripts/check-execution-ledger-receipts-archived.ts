#!/usr/bin/env tsx
/**
 * check-execution-ledger-receipts-archived — locks the v1.1 producer
 * wiring that surfaces byte-identical inner signed receipts in the
 * state-export reconstruction.
 *
 * Doctrine: `spec/execution-ledger-v1.md` §4.3 (Inner Signed Receipts —
 * v1.1 additive); `docs/doctrine/nist-alignment.md` §8 "Inner-receipt
 * verification closed."
 *
 * The drift class this gate exists to catch: a future refactor removes
 * the archive lookup in `services/relay/src/state-export.ts`'s
 * execution-ledger handler, silently regressing the reconstruction back
 * to v1.0 summaries. v1.0 summaries carry `signature_prefix` (16 chars
 * — display only, not verifiable); v1.1 surfaces full canonical-JSON
 * receipt bytes so a verifier can independently check inner motebit
 * signatures without trusting the relay's word that "motebit X did this
 * work." The producer side of the operator-trust closure must stay
 * wired.
 *
 * Forbidden: the execution-ledger handler in `state-export.ts` does
 * NOT call `getStoredReceiptJson` (the byte-identical archive accessor
 * per `services/relay/CLAUDE.md` Rule 11) when assembling
 * `signed_receipts`, OR the `motebit/execution-ledger@1.1` spec literal
 * is removed.
 *
 *   ✗  `signedReceipts` populated via custom logic that doesn't read
 *      the canonical archive (drifts away from the byte-identical
 *      invariant)
 *   ✗  Handler emits only `motebit/execution-ledger@1.0` even when
 *      inner receipts are archivable (silent v1.1 → v1.0 regression)
 *
 *   ✓  Handler calls `getStoredReceiptJson(...)` for each delegation
 *      receipt + bumps `spec` to `motebit/execution-ledger@1.1` when
 *      the archive returns rows.
 *
 * Scope: only `services/relay/src/state-export.ts`. The gate is narrow
 * by design — the execution-ledger handler is the unique surface that
 * surfaces inner receipts to third-party verifiers; other relay code
 * paths that touch receipts (settlement, federation, dispute) have
 * their own integrity contracts.
 *
 * Usage:
 *   tsx scripts/check-execution-ledger-receipts-archived.ts       # exit 1 on violation
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const TARGET = "services/relay/src/state-export.ts";

interface Finding {
  reason: string;
}

function main(): void {
  const abs = resolve(REPO_ROOT, TARGET);
  let src: string;
  try {
    src = readFileSync(abs, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `check-execution-ledger-receipts-archived: cannot read ${TARGET}: ${msg}\n`,
    );
    process.exit(2);
  }

  const findings: Finding[] = [];

  // The handler must call the byte-identical archive accessor. Without
  // this, signed_receipts would be assembled from an inferior source
  // (event payloads, raw memos, etc.) and lose canonical-JSON byte-
  // identity with what the motebit originally signed.
  if (!/\bgetStoredReceiptJson\s*\(/.test(src)) {
    findings.push({
      reason: `state-export.ts does NOT call getStoredReceiptJson — inner-receipt source must be the canonical byte-identical archive (per services/relay/CLAUDE.md Rule 11). Without this call, the v1.1 reconstruction loses canonical-JSON byte-identity with what the motebit signed, breaking third-party verification.`,
    });
  }

  // The handler must emit the v1.1 spec literal somewhere in the file
  // — silently regressing the spec back to v1.0 only would erase v1.1's
  // closure of the operator-trust gap (verifiers would see only
  // signature_prefix summaries and have no way to check inner sigs).
  if (!src.includes("motebit/execution-ledger@1.1")) {
    findings.push({
      reason: `state-export.ts does NOT contain the spec literal "motebit/execution-ledger@1.1" — without bumping the spec field when signed_receipts is non-empty, verifiers won't recognize the v1.1 closure and will fall back to v1.0 summary-only semantics. Restore the version-bump path.`,
    });
  }

  // The handler must also retain the v1.0 path for graceful degradation
  // when the archive is empty (testnet, ephemeral deploys, partial
  // sync). Without the v1.0 literal as fallback, the gate-protected
  // invariant becomes "always emit v1.1" — which fails when the archive
  // has no rows. Both literals must coexist.
  if (!src.includes("motebit/execution-ledger@1.0")) {
    findings.push({
      reason: `state-export.ts does NOT contain the spec literal "motebit/execution-ledger@1.0" — graceful degradation requires the v1.0 path when no inner receipts are archived (testnet, ephemeral deploys). Restore the fallback.`,
    });
  }

  console.log(
    `check-execution-ledger-receipts-archived — scanned ${TARGET} for v1.1 inner-receipt wiring\n`,
  );

  if (findings.length === 0) {
    console.log(
      `✓ execution-ledger reconstruction sources inner receipts from the canonical byte-identical archive and bumps to v1.1 when present.`,
    );
    return;
  }

  console.log(`✗ v1.1 inner-receipt wiring missing in ${TARGET}:\n`);
  for (const f of findings) {
    console.log(`  ${f.reason}\n`);
  }
  console.log(
    `  Fix: in the execution-ledger handler, after building the\n` +
      `       delegation-receipt summaries, source byte-identical\n` +
      `       canonical-JSON receipts from the archive:\n` +
      `\n` +
      `         import { getStoredReceiptJson } from "./receipts-store.js";\n` +
      `\n` +
      `         const signedReceipts: string[] = [];\n` +
      `         for (const summary of delegationReceipts) {\n` +
      `           const archived = getStoredReceiptJson(\n` +
      `             moteDb.db, summary.motebit_id, summary.task_id);\n` +
      `           if (archived !== null) signedReceipts.push(archived);\n` +
      `         }\n` +
      `\n` +
      `         const bumpToV1_1 = signedReceipts.length > 0;\n` +
      `         body.spec = bumpToV1_1\n` +
      `           ? "motebit/execution-ledger@1.1"\n` +
      `           : "motebit/execution-ledger@1.0";\n` +
      `         if (bumpToV1_1) body.signed_receipts = signedReceipts;\n` +
      `\n` +
      `       Doctrine: spec/execution-ledger-v1.md §4.3,\n` +
      `       docs/doctrine/nist-alignment.md §8 "inner-receipt verification."\n`,
  );
  process.exit(1);
}

main();
