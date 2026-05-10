#!/usr/bin/env tsx
/**
 * check-ha-not-a-gate — synchronization invariant for the negative
 * doctrine "Hardware attestation is additive, never a gate."
 *
 * Doctrine: `docs/doctrine/hardware-attestation.md`; CLAUDE.md root
 * principle "Hardware-rooted identity is additive."
 *
 * The promise — software-only identity is the floor; hardware
 * attestation raises the `HardwareAttestationSemiring` score, never
 * admits or rejects — is the load-bearing claim that lets the software
 * floor exist. Today `HardwareAttestationSemiring` is structurally
 * additive (max/min algebra over a continuous score axis); a future PR
 * adding `if (peer.hardware_attestation.score < 0.5) reject` in any
 * routing/scoring/policy/runtime path silently converts an additive
 * scoring axis into an admission criterion. That kind of drift is
 * invisible to the user (the rejected peer just doesn't appear) and
 * invisible to CI (no existing gate catches it). This gate closes the
 * asymmetry: every other architectural promise in CLAUDE.md is hard-
 * gated; the most-cited one was prose-only.
 *
 * Forbidden shapes:
 *   1. `attestation_score [< > <= >=] <numeric>` — direct threshold
 *      compare on the canonical scoring field.
 *   2. `<expr>.hardware_attestation(_\w+)?[.\w?]*.score [< > <= >=]
 *      <numeric>` — same compare via HA property chain.
 *   3. `.filter(<arg> => [!]<expr>.hardware_attestation...)` —
 *      exclusionary filter (the most common admission shape in code
 *      that processes peer lists).
 *   4. `if (!?<expr>.hardware_attestation(_\w+)?...)` followed within
 *      3 lines by `return (false|null|undefined|[])`, `throw`,
 *      `continue;`, `reject(`, `deny(`, or `skip(` — gate-on-
 *      presence/absence inside a conditional.
 *
 * Allowed (these are the actual current readers; the gate must let
 * them pass):
 *   - Property access for projection / aggregation / display
 *   - Multiplicative scoring (`score *= ...peer.hardware_attestation...`)
 *   - Null-coalesce read for default scoring
 *     (`candidate.hardware_attestation_aggregate?.attestation_score ??
 *     scoreAttestation(candidate.hardware_attestation)`)
 *   - `switch (claim.platform) { ... }` weighting per platform inside
 *     the semiring's own composer (semiring/* is out of scope)
 *
 * Waiver: a line carrying
 *   `// hardware-attestation: intentional-threshold — <reason>`
 * on the same line or the line above the match is honored. Same shape
 * as `check-suite-dispatch`'s waiver — explicit acknowledgement is
 * cheap, drift is expensive.
 *
 * Scope: the layer where admission decisions actually occur.
 *   - services/relay/src/  (routing, task assignment, federation)
 *   - packages/policy/src/ (the policy layer itself)
 *   - packages/market/src/ (scoring, graph-routing, credential-weight)
 *   - packages/runtime/src/ (per-motebit runtime)
 *
 * Out of scope (legitimate readers):
 *   - packages/semiring/src/ — the semiring's own min/max algebra
 *   - packages/crypto/src/, crypto-{appattest,tpm,...}/src/ — verifiers
 *   - packages/encryption/src/ — composer
 *   - apps/* — display formatters (`formatHardwarePlatform`)
 *   - Tests
 *
 * Usage:
 *   tsx scripts/check-ha-not-a-gate.ts           # exit 1 on violation
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

const SCAN_ROOTS = [
  join(REPO_ROOT, "services", "relay", "src"),
  join(REPO_ROOT, "packages", "policy", "src"),
  join(REPO_ROOT, "packages", "market", "src"),
  join(REPO_ROOT, "packages", "runtime", "src"),
];

const WAIVER_COMMENT = /hardware-attestation:\s*intentional-threshold/;
const WAIVER_REASON = /hardware-attestation:\s*intentional-threshold\s*[—-]\s*(.+?)$/;

/**
 * Per-line patterns. Each carries a name (printed on failure) and a
 * regex that must match the code-only portion of the line (line
 * comments stripped). Patterns are precise enough to avoid the most
 * common false positives (logging strings, type annotations, comment
 * prose).
 */
interface LinePattern {
  name: string;
  regex: RegExp;
}

const LINE_PATTERNS: LinePattern[] = [
  // Direct numeric threshold compare on `attestation_score` (the
  // canonical scoring field defined in @motebit/market's
  // HardwareAttestationAggregate).
  {
    name: "attestation_score < N (threshold compare)",
    regex: /\battestation_score\s*[<>]=?\s*[\d.]/,
  },
  // HA-property-chain score threshold:
  // `peer.hardware_attestation.score < 0.5` or via aggregate.
  {
    name: "hardware_attestation.…score < N (threshold compare)",
    regex: /\bhardware_attestation(_\w+)?[.?\w]*\.(score|attestation_score|level)\s*[<>]=?\s*[\d.]/,
  },
  // hwAttestation camelCase variant.
  {
    name: "hwAttestation.…score < N (threshold compare)",
    regex: /\bhwAttestation[.?\w]*\.(score|attestation_score|level)\s*[<>]=?\s*[\d.]/,
  },
  // Exclusionary filter on HA presence:
  //   .filter(p => p.hardware_attestation)
  //   .filter(p => !p.hardware_attestation)
  //   .filter((p) => p.hardware_attestation_aggregate?.attestation_score >= 0.7)
  // Filtering by HA membership is the routing-layer admission shape
  // even when the predicate looks innocuous — the absence of the
  // claim becomes the rejection criterion.
  {
    name: ".filter(…hardware_attestation…) (exclusionary filter)",
    regex: /\.filter\s*\(\s*\(?[^)]*?\)?\s*=>\s*[!]?\s*[\w.]+\.hardware_attestation/,
  },
];

/**
 * Conditional-then-reject patterns. A line that opens a conditional
 * on hardware_attestation, followed within `PEEK_LINES` of code by a
 * reject/throw/skip verb, is an admission gate.
 *
 * The peek window covers the common shapes:
 *   if (!peer.hardware_attestation) return null;
 *   if (!peer.hardware_attestation) {
 *     return null;
 *   }
 *   if (peer.hwAttestation == null) {
 *     continue;
 *   }
 */
const CONDITIONAL_OPEN = /\bif\s*\(\s*[^)]*?\b(hardware_attestation|hwAttestation)\b/;

const REJECT_VERBS =
  /\b(return\s+(false|null|undefined|\[\])|throw\s|reject\s*\(|deny\s*\(|skip\s*\()|^\s*continue\s*;/;

const PEEK_LINES = 3;

interface Finding {
  file: string;
  line: number;
  pattern: string;
  context: string;
  waived: boolean;
  reason: string | null;
}

function walkTs(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "dist" ||
        entry.name === "node_modules" ||
        entry.name === ".turbo"
      ) {
        continue;
      }
      walkTs(full, out);
    } else if (
      (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) ||
      entry.name.endsWith(".tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

function isTestFile(rel: string): boolean {
  return rel.includes("/__tests__/") || rel.endsWith(".test.ts") || rel.endsWith(".spec.ts");
}

/** Return the line above stripped of indentation, for waiver inspection. */
function lineAbove(lines: string[], i: number): string {
  return i > 0 ? lines[i - 1]! : "";
}

function findingFor(
  rel: string,
  lineNo: number,
  patternName: string,
  rawLine: string,
  prevLine: string,
): Finding {
  const waiverLine = WAIVER_COMMENT.test(rawLine)
    ? rawLine
    : WAIVER_COMMENT.test(prevLine)
      ? prevLine
      : null;
  const waived = waiverLine !== null;
  const reason = waiverLine ? (WAIVER_REASON.exec(waiverLine)?.[1]?.trim() ?? null) : null;
  return {
    file: rel,
    line: lineNo,
    pattern: patternName,
    context: rawLine.trim(),
    waived,
    reason,
  };
}

function scanFile(abs: string): Finding[] {
  const rel = relative(REPO_ROOT, abs);
  if (isTestFile(rel)) return [];
  const src = readFileSync(abs, "utf-8");
  const lines = src.split("\n");
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    // Strip line comments before pattern matching so a comment-only
    // mention (e.g. JSDoc, file header) doesn't trip the gate.
    const code = rawLine.replace(/\/\/.*$/, "");

    // Per-line patterns.
    for (const { regex, name } of LINE_PATTERNS) {
      if (regex.test(code)) {
        findings.push(findingFor(rel, i + 1, name, rawLine, lineAbove(lines, i)));
      }
    }

    // Conditional-then-reject: if the line opens an HA conditional,
    // check the same line first (one-liner form: `if (...) return null;`),
    // then peek ahead up to PEEK_LINES non-empty code lines for a reject
    // verb. Comment-only and blank lines don't consume the peek budget.
    if (CONDITIONAL_OPEN.test(code)) {
      let matched = REJECT_VERBS.test(code);
      if (!matched) {
        let consumed = 0;
        for (let j = i + 1; j < lines.length && consumed < PEEK_LINES; j++) {
          const peek = lines[j]!;
          const peekCode = peek.replace(/\/\/.*$/, "");
          if (peekCode.trim().length === 0) continue;
          consumed++;
          if (REJECT_VERBS.test(peekCode)) {
            matched = true;
            break;
          }
        }
      }
      if (matched) {
        findings.push(
          findingFor(
            rel,
            i + 1,
            "if (…hardware_attestation…) → reject (admission gate)",
            rawLine,
            lineAbove(lines, i),
          ),
        );
      }
    }
  }
  return findings;
}

function main(): void {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    try {
      statSync(root);
    } catch {
      continue;
    }
    walkTs(root, files);
  }
  const findings = files.flatMap(scanFile);
  const active = findings.filter((f) => !f.waived);
  const waived = findings.filter((f) => f.waived);

  console.log(
    `check-ha-not-a-gate — scanned ${files.length} files across services/relay/src, packages/{policy,market,runtime}/src (excluding tests)\n`,
  );

  if (waived.length > 0) {
    console.log(
      `ℹ Waived call sites (explicit ${"// hardware-attestation: intentional-threshold"}):\n`,
    );
    for (const f of waived) {
      console.log(`  ${f.file}:${f.line}  ${f.pattern}`);
      console.log(`    ${f.context}`);
      if (f.reason) console.log(`    reason: ${f.reason}`);
    }
    console.log();
  }

  if (active.length === 0) {
    console.log(
      "✓ Hardware attestation is additive — no threshold-style admission gates found in routing, scoring, policy, or runtime.",
    );
    return;
  }

  console.log(
    `✗ Hardware attestation used as an admission gate — must be additive, never a gate:\n`,
  );
  for (const f of active) {
    console.log(`  ${f.file}:${f.line}  ${f.pattern}`);
    console.log(`    ${f.context}`);
  }
  console.log(
    `\n  Doctrine: docs/doctrine/hardware-attestation.md.\n` +
      `  Hardware attestation raises the HardwareAttestationSemiring score; it never\n` +
      `  admits or rejects. The software floor is part of the protocol promise.\n\n` +
      `  Fix: route through the semiring's continuous scoring axis, or add\n` +
      `  \`// hardware-attestation: intentional-threshold — <reason>\` above the\n` +
      `  line if this is a deliberate admission boundary (rare; explain why).`,
  );
  process.exit(1);
}

main();
