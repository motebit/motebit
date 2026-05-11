#!/usr/bin/env tsx
/**
 * check-execution-ledger-inner-receipt-verified — locks the consumer-
 * side wiring that completes the v1.1 producer-consumer arc.
 *
 * Doctrine: `spec/execution-ledger-v1.md` §4.3 (Inner Signed Receipts —
 * v1.1 additive); `docs/doctrine/nist-alignment.md` §8 "Inner-receipt
 * verifier shipped."
 *
 * The producer side (drift-defense #89, `check-execution-ledger-receipts-
 * archived`) requires the relay to surface byte-identical inner receipts
 * via the v1.1 `signed_receipts` field. This gate is the consumer-side
 * counterpart — without it, the v1.1 wire change is invisible truth:
 * verifiers see the field but never recursively verify, so a relay
 * lying about which motebit did the work is still undetectable in
 * practice.
 *
 * The gate scans two surfaces:
 *
 *   1. `@motebit/state-export-client` — the verifier-side primitive
 *      `verifyInnerSignedReceipts` MUST be declared. The package's
 *      `src/inner-receipts.ts` is the canonical home; the index MUST
 *      re-export it.
 *
 *   2. `motebit-verify` CLI — the `content-artifact` subcommand MUST
 *      consume `verifyInnerSignedReceipts` so a CLI verifier produces
 *      a per-receipt verdict for v1.1 bodies. Without the CLI wiring,
 *      the primitive exists in the library but no shipping tool uses
 *      it; the operator-trust gap stays open at the operator-facing
 *      surface.
 *
 * Forbidden: the primitive is removed from `@motebit/state-export-client`
 * OR the CLI stops calling it for execution-ledger artifacts.
 *
 *   ✗  state-export-client drops the `verifyInnerSignedReceipts` export
 *      → consumers cannot recursively verify
 *   ✗  CLI's `content-artifact` subcommand no longer calls
 *      `verifyInnerSignedReceipts` → v1.1 wire change becomes inert
 *
 *   ✓  Both surfaces wire the primitive end-to-end + the CLI's output
 *      surfaces per-receipt verdicts.
 *
 * Adversarial-tested: remove the import of `verifyInnerSignedReceipts`
 * from `packages/verify/src/cli.ts`; the gate flags the silent
 * regression to outer-only verification.
 *
 * Usage:
 *   tsx scripts/check-execution-ledger-inner-receipt-verified.ts   # exit 1 on violation
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

interface SurfaceCheck {
  /** Repo-relative path of the file the gate scans. */
  readonly file: string;
  /** Regex patterns the file MUST contain. */
  readonly requires: ReadonlyArray<{ readonly pattern: RegExp; readonly missingMessage: string }>;
}

const SURFACES: ReadonlyArray<SurfaceCheck> = [
  {
    file: "packages/state-export-client/src/inner-receipts.ts",
    requires: [
      {
        pattern: /\bexport\s+(?:async\s+)?function\s+verifyInnerSignedReceipts\b/,
        missingMessage:
          "verifyInnerSignedReceipts export is missing from packages/state-export-client/src/inner-receipts.ts — the primitive must remain in the canonical home so consumers can import it",
      },
      {
        pattern: /\bverifyReceipt\b/,
        missingMessage:
          "verifyReceipt from @motebit/crypto must be consumed in inner-receipts.ts — without it, the consumer-side primitive is decorative; verification requires the crypto-layer Ed25519 check",
      },
    ],
  },
  {
    file: "packages/state-export-client/src/index.ts",
    requires: [
      {
        pattern: /\bverifyInnerSignedReceipts\b/,
        missingMessage:
          "verifyInnerSignedReceipts is not re-exported from packages/state-export-client/src/index.ts — consumers that import from the package root cannot reach it; the consumer-side wiring becomes a deep-import dependency",
      },
    ],
  },
  {
    file: "packages/verify/src/cli.ts",
    requires: [
      {
        pattern: /\bverifyInnerSignedReceipts\b/,
        missingMessage:
          "motebit-verify's content-artifact subcommand does not call verifyInnerSignedReceipts — the v1.1 wire change becomes inert at the operator-facing CLI surface, and the operator-trust gap stays open in shipping tooling",
      },
      {
        pattern: /\bmotebit\/state-export-client\b/,
        missingMessage:
          "motebit-verify does not import from @motebit/state-export-client — the recursive verifier lives there and the CLI must consume it through the package boundary",
      },
    ],
  },
];

interface Finding {
  file: string;
  reason: string;
}

function main(): void {
  const findings: Finding[] = [];

  for (const surface of SURFACES) {
    const abs = resolve(REPO_ROOT, surface.file);
    let src: string;
    try {
      src = readFileSync(abs, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        file: surface.file,
        reason: `cannot read file (${msg}) — the consumer-side wiring's canonical surface is missing from the repo, breaking the v1.1 verification arc`,
      });
      continue;
    }
    for (const req of surface.requires) {
      if (!req.pattern.test(src)) {
        findings.push({ file: surface.file, reason: req.missingMessage });
      }
    }
  }

  console.log(
    `check-execution-ledger-inner-receipt-verified — scanned ${SURFACES.length} surface file(s)\n`,
  );

  if (findings.length === 0) {
    console.log(
      `✓ Consumer-side recursive verification is wired end-to-end (state-export-client primitive + motebit-verify CLI integration).`,
    );
    return;
  }

  console.log(`✗ v1.1 consumer-side wiring missing or regressed:\n`);
  for (const f of findings) {
    console.log(`  ${f.file}`);
    console.log(`    ${f.reason}\n`);
  }
  console.log(
    `  Fix: keep verifyInnerSignedReceipts in @motebit/state-export-client\n` +
      `       and call it from motebit-verify's content-artifact path when\n` +
      `       the body's manifest declares artifact_type === "execution-ledger".\n` +
      `       The CLI surfaces a per-receipt verdict in human + JSON output and\n` +
      `       fails the overall exit code when any inner receipt fails to verify.\n` +
      `\n` +
      `       Doctrine: spec/execution-ledger-v1.md §4.3,\n` +
      `       docs/doctrine/nist-alignment.md §8 "inner-receipt verifier."\n`,
  );
  process.exit(1);
}

main();
