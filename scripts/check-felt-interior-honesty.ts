#!/usr/bin/env tsx
/**
 * check-felt-interior-honesty — locks the five structural honesty invariants
 * of the felt-interior binding (`docs/doctrine/felt-interior.md`,
 * `spec/consolidation-mutation-manifest-v1.md`). The doctrine + the code +
 * the wire schema exist; this is the third artifact (legibility ratio,
 * `feedback_legibility_ratio`) that makes the commitment self-healing.
 *
 * Invariants 1–2 cover the CONSOLIDATION record (the signed act-trail); invariant
 * 3 covers the MEMORY record (the unsigned standing record, felt-interior.md §5),
 * whose honesty is the inverse: it shows shape because it is NOT signed, so it
 * must claim no assurance and carry no content. Invariant 4 covers the TRUST
 * record (the relational register, felt-interior.md §6), whose honesty is the
 * moat turned inward: it shows depth because it is proven, but must carry no
 * global reputation/rank/aggregate score — minting that score for the owner about
 * the owner's own graph re-introduces the §1 sybil-bait pointed inward. Invariant
 * 5 covers the MEMORY ENVIRONMENT (the §5 record in the spatial register, an
 * ambient haze): the memory mass becomes a bounded ambient scalar, never a raw
 * count or climbing score — the §"What not to build" vanity refusal at the type.
 * All locked structurally below.
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

// ── Invariant 3: the memory record is shape-only (unsigned-local honesty) ──
// felt-interior.md §5: the memory graph's standing state is unsigned-and-local,
// so the felt memory record's honesty is structural and the INVERSE of
// consolidation's — it makes NO assurance claim (no verified/attested field) and
// carries NO content (the input slice is content-free, so content cannot enter
// the projection). A future edit enriching the record with content or an
// assurance claim is the drift this invariant locks.
const FELT_MEMORY = "packages/panels/src/memory/felt-memory.ts";
const feltMemory = read(FELT_MEMORY);
if (feltMemory) {
  // Extract a top-level interface body by brace-matching from its `{`.
  const interfaceBody = (name: string): string => {
    const i = feltMemory.indexOf(`interface ${name} {`);
    if (i < 0) return "";
    const start = feltMemory.indexOf("{", i);
    let depth = 0;
    for (let j = start; j < feltMemory.length; j++) {
      if (feltMemory[j] === "{") depth++;
      else if (feltMemory[j] === "}" && --depth === 0) return feltMemory.slice(start, j + 1);
    }
    return "";
  };
  // The input slice must stay content-free, so memory content cannot enter the record.
  if (/\bcontent\s*\??\s*:/.test(interfaceBody("FeltMemoryNode"))) {
    findings.push(
      `${FELT_MEMORY}: FeltMemoryNode declares a \`content\` field — remove it; the felt memory slice MUST be content-free so memory content cannot enter the record (felt-interior.md §5).`,
    );
  }
  // The record must claim no assurance and carry no content — shape + presence only.
  if (
    /\b(content|verified|assurance|status|mutations|manifest)\s*\??\s*:/.test(
      interfaceBody("FeltMemoryRecord"),
    )
  ) {
    findings.push(
      `${FELT_MEMORY}: FeltMemoryRecord declares a forbidden field (content/verified/assurance/status/mutations/manifest) — remove it; the memory record makes NO assurance claim and carries NO content, it is shape + presence only, the inverse of consolidation's signed honesty (felt-interior.md §5).`,
    );
  }
}

// ── Invariant 4: the trust record carries no inward global score ───────────
// felt-interior.md §6: trust shows DEPTH because it is proven (Known-only), but
// refusing the global reputation score is the necessary core of sybil-resistance
// (§1; agents-as-first-person-trust-graph.md). Minting that score for the owner,
// about the owner's own graph, re-introduces the exact gameable aggregate pointed
// inward. So `FeltTrustRecord` must declare no reputation/rank/aggregate/score
// field — a future edit adding one is the drift this invariant locks. (The
// proven-only floor is type-enforced: the projection takes the Known `AgentRecord`
// slice, and a relay-claimed `DiscoveredAgent` is a different type.)
const FELT_TRUST = "packages/panels/src/agents/felt-trust.ts";
const feltTrust = read(FELT_TRUST);
if (feltTrust) {
  const trustInterfaceBody = (name: string): string => {
    const i = feltTrust.indexOf(`interface ${name} {`);
    if (i < 0) return "";
    const start = feltTrust.indexOf("{", i);
    let depth = 0;
    for (let j = start; j < feltTrust.length; j++) {
      if (feltTrust[j] === "{") depth++;
      else if (feltTrust[j] === "}" && --depth === 0) return feltTrust.slice(start, j + 1);
    }
    return "";
  };
  if (
    /\b(score|reputation|rank|ranking|aggregate|global)\s*\??\s*:/.test(
      trustInterfaceBody("FeltTrustRecord"),
    )
  ) {
    findings.push(
      `${FELT_TRUST}: FeltTrustRecord declares a forbidden field (score/reputation/rank/ranking/aggregate/global) — remove it; the trust record makes NO global-reputation claim, it is first-person counts at rest. Refusing the global score is the core of sybil-resistance (felt-interior.md §6; agents-as-first-person-trust-graph.md §1) — minting it inward, about the owner's own graph, re-introduces the gameable aggregate.`,
    );
  }
}

// ── Invariant 5: the memory environment exposes no raw count or score ──────
// felt-interior.md §5, spatial register: the memory mass becomes an ambient haze
// (the Environment primitive), and the §"What not to build" bound bites hardest
// here — a memory count is the most natural vanity metric. The honesty rests on
// `EnvironmentExpression` being a bounded ambient scalar (`density`) plus a
// present-state `tone`, NEVER a raw held/total count or a score the haze could
// surface as a climbing number. A future edit adding such a field is the drift
// this invariant locks — the inward-vanity refusal at the type, the §5 analogue
// of invariant 4's global-score refusal. (The saturating density mapping and the
// content-free `{ held, fading }` summary are enforced by the memory-environment
// test suite in @motebit/render-engine.)
const EXPRESSION = "packages/render-engine/src/expression.ts";
const expression = read(EXPRESSION);
if (expression) {
  const envBody = (() => {
    const i = expression.indexOf("interface EnvironmentExpression {");
    if (i < 0) return "";
    const start = expression.indexOf("{", i);
    let depth = 0;
    for (let j = start; j < expression.length; j++) {
      if (expression[j] === "{") depth++;
      else if (expression[j] === "}" && --depth === 0) return expression.slice(start, j + 1);
    }
    return "";
  })();
  if (
    /\b(count|total|held|fading|score|rank|trend|delta|growth|memories)\s*\??\s*:/.test(envBody)
  ) {
    findings.push(
      `${EXPRESSION}: EnvironmentExpression declares a forbidden field (count/total/held/fading/score/rank/trend/delta/growth/memories) — remove it; the memory environment is a bounded ambient scalar (density) + present tone, NEVER a raw count or climbing score. A memory count is the §5 vanity metric turned inward (felt-interior.md §5 "What not to build"); the haze shows the mass as texture, never a number.`,
    );
  }
}

if (findings.length > 0) {
  console.error(`✗ check-felt-interior-honesty: ${findings.length} violation(s):`);
  for (const f of findings) console.error(`    ${f}`);
  console.error(
    "\nFix: in packages/panels/src/memory/felt-consolidation.ts, route the `verified` status\n" +
      "     through verifyFeltCoverage — projectFeltConsolidation must emit only unverified\n" +
      "     candidates; the `verified` evidence value derives from the cryptographically-checked\n" +
      "     manifest the verifier returns, never a literal set before the check. Doctrine:\n" +
      "     docs/doctrine/felt-interior.md.",
  );
  process.exit(1);
}

console.log(
  "✓ check-felt-interior-honesty: coverage is never faked; the owner-local mutation manifest is stripped on relay sync.",
);
