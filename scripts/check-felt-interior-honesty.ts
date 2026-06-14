#!/usr/bin/env tsx
/**
 * check-felt-interior-honesty — locks the two structural honesty invariants
 * of the felt-interior binding (`docs/doctrine/felt-interior.md`,
 * `spec/consolidation-mutation-manifest-v1.md`). The doctrine + the code +
 * the wire schema exist; this is the third artifact (legibility ratio,
 * `feedback_legibility_ratio`) that makes the commitment self-healing.
 *
 * Invariant 1 — coverage is never faked. The felt projection
 * (`@motebit/panels`) must never hard-code `mutationsCoveredBySignature: true`.
 * That field is honest only when it is the value `verifyFeltCoverage`
 * computes from a cryptographically-verified `ConsolidationMutationManifest`
 * (signature + receipt linkage + per-mutation content match). A literal
 * `true` is a fabricated coverage claim — the exact dishonesty the binding
 * exists to kill (a signed/anchored glyph implying the displayed sentences
 * are signed when only the counts are).
 *
 * Invariant 2 — the owner-local manifest never leaks via sync. While the
 * `ConsolidationMutationManifest` type exists, the relay's ingress redaction
 * MUST strip `mutation_manifest` from `consolidation_receipt_signed` events.
 * This is a sibling-boundary class (`feedback_synced_event_payload_redaction`):
 * `SyncEngine.pushEvents` queries ALL local events with no type filter and
 * pushes them to the relay, and `redactSensitiveEvents` is the one ingress
 * defense. The manifest carries per-node content digests (dictionary-
 * attackable) + per-node sensitivity tiers that must never persist at or
 * forward through the relay — only the counts-only receipt syncs. Removing
 * the strip silently re-opens the leak.
 *
 * This is a synchronization-invariant defense; see docs/drift-defenses.md.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function read(rel: string): string {
  const abs = resolve(ROOT, rel);
  return existsSync(abs) ? readFileSync(abs, "utf-8") : "";
}

const findings: string[] = [];

// ── Invariant 1: coverage is never faked ──────────────────────────────────
// The evidence union (`{ status: "verified", mutations } | { status: "receipt_only" }`)
// makes an unverified-record-with-details unrepresentable. The one remaining
// way to fake it is to CONSTRUCT `{ status: "verified", ... }` in the
// projection (which holds only time-window candidates) instead of the
// verifier. So a verified-evidence VALUE (a literal `status: "verified",` —
// trailing comma distinguishes the object construction from the type union's
// `status: "verified";`) may appear only at/after `verifyFeltCoverage`.
const PROJECTION = "packages/panels/src/memory/felt-consolidation.ts";
const projection = read(PROJECTION);
const VERIFIED_VALUE = /status\s*:\s*["']verified["']\s*,/;
if (!projection) {
  findings.push(`${PROJECTION}: missing — the felt projection is the honesty boundary.`);
} else {
  const verifyIdx = projection.indexOf("export async function verifyFeltCoverage");
  const beforeVerify = verifyIdx >= 0 ? projection.slice(0, verifyIdx) : projection;
  if (VERIFIED_VALUE.test(beforeVerify)) {
    findings.push(
      `${PROJECTION}: a "verified" mutation evidence VALUE is constructed outside (before) verifyFeltCoverage. Only the verifier may mint "verified" — projectFeltConsolidation produces unverified candidates; verified detail must derive from a cryptographically-checked manifest. (docs/doctrine/felt-interior.md)`,
    );
  }
}

// ── Invariant 2: the owner-local manifest is stripped on relay sync ────────
const protocol = read("packages/protocol/src/index.ts");
const featurePresent = /interface ConsolidationMutationManifest\b/.test(protocol);
if (featurePresent) {
  const REDACTION = "services/relay/src/redaction.ts";
  const redaction = read(REDACTION);
  // Word-boundary tests so a `_PROBE`-suffixed rename (or removal) is caught:
  // `mutation_manifest_PROBE` does not match `/mutation_manifest\b/`.
  const stripsManifest =
    /\bConsolidationReceiptSigned\b/.test(redaction) && /mutation_manifest\b/.test(redaction);
  if (!stripsManifest) {
    findings.push(
      `${REDACTION}: ConsolidationMutationManifest exists but the relay does not strip \`mutation_manifest\` from \`consolidation_receipt_signed\` events on sync ingress. SyncEngine.pushEvents syncs ALL events — the owner-local manifest (per-node content digests + sensitivity tiers) would leak to the relay. Add a strip branch to redactSensitiveEvents. (feedback_synced_event_payload_redaction; spec/consolidation-mutation-manifest-v1.md §2)`,
    );
  }
}

if (findings.length > 0) {
  console.error(`✗ check-felt-interior-honesty: ${findings.length} violation(s):`);
  for (const f of findings) console.error(`    ${f}`);
  process.exit(1);
}

console.log(
  "✓ check-felt-interior-honesty: coverage is never faked; the owner-local mutation manifest is stripped on relay sync.",
);
