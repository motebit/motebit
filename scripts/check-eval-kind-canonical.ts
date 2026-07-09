#!/usr/bin/env tsx
/**
 * `check-eval-kind-canonical` — registry-coverage gate for the `EvalKind`
 * closed registry (the eleventh registered registry;
 * docs/doctrine/evals-as-attestations.md, promoted 2026-07-08).
 *
 * Closed-registry / structural-lock pattern — same shape as
 * `check-settlement-mode-canonical` (#79) and siblings, with one extra leg:
 *
 *   1. `EvalKind` (the union in `packages/protocol/src/eval-attestation.ts`)
 *      is the closed vocabulary of measurement FAMILIES a consumer
 *      dispatches on to interpret an attestation's `results[]`. Unknown
 *      kinds fail closed at wire intake (`verifyEvalAttestation`) — a
 *      consumer that cannot interpret the family must not act on its
 *      verdicts. Cross-implementation drift here is the audience-typo
 *      class: an issuer minting a kind the verifier rejects strands
 *      attestations.
 *
 *   2. FOUR-way lock (one more site than the usual three): the union ×
 *      `ALL_EVAL_KINDS` (protocol frozen array) × `EVAL_KINDS_MIRROR`
 *      (`packages/crypto/src/eval-attestation.ts` — crypto keeps zero
 *      runtime monorepo deps, so the fail-closed intake check mirrors the
 *      registry the way SuiteId values mirror into the dispatch table) ×
 *      this gate's `EVAL_KINDS_REFERENCE`. A drift between any pair fails.
 *
 *   3. Emit-site scan (the leg that keeps a single-member registry
 *      non-vacuous): every `eval_kind: "<literal>"` in `packages/` and
 *      `services/` source must be a registry member — a producer typo'ing
 *      a kind fails HERE, in CI, not at a verifier three hops away.
 *
 *   4. Wire-format compliance: every value MUST be snake_case
 *      (`^[a-z][a-z0-9_]*$`).
 *
 * Doctrine: `docs/doctrine/registry-pattern-canonical.md`;
 * `docs/doctrine/evals-as-attestations.md`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * The canonical set, mirrored from
 * `packages/protocol/src/eval-attestation.ts:ALL_EVAL_KINDS`. Re-deriving
 * at gate runtime would be circular; the alignment block reads the sources
 * and asserts the four lists agree exactly.
 */
const EVAL_KINDS_REFERENCE = ["verification_audit"] as const;

const SNAKE_CASE_PATTERN = /^[a-z][a-z0-9_]*$/;

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

function extractQuoted(body: string): string[] {
  const values: string[] = [];
  const valuePattern = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = valuePattern.exec(body)) !== null) values.push(m[1] as string);
  return values;
}

function readUnionValues(source: string): string[] {
  const unionMatch = source.match(/export type EvalKind\s*=([^;]+);/);
  return unionMatch === null ? [] : extractQuoted(unionMatch[1] ?? "");
}

function readArrayValues(source: string, arrayName: string): string[] {
  const arrayMatch = source.match(
    new RegExp(`${arrayName}[^=]*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]`),
  );
  return arrayMatch === null ? [] : extractQuoted(arrayMatch[1] ?? "");
}

/** Walk packages/ + services/ TypeScript sources (skip node_modules/dist/tests-irrelevant dirs). */
function walkSources(dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    // __tests__ excluded: negative fixtures legitimately mint non-members
    // (the tamper vectors); the emit scan defends PRODUCTION emit sites.
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === ".turbo" ||
      entry === "coverage" ||
      entry === "__tests__"
    )
      continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkSources(full, acc);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) acc.push(full);
  }
}

function main(): void {
  console.log(
    "▸ check-eval-kind-canonical — EvalKind four-way lock (union × ALL_EVAL_KINDS × crypto mirror × gate) + emit-site scan",
  );

  const protocolSource = readFile("packages/protocol/src/eval-attestation.ts");
  if (protocolSource === null) {
    console.error(
      "check-eval-kind-canonical: could not read packages/protocol/src/eval-attestation.ts.",
    );
    console.error("Fix: restore the EvalKind registry surface — the gate cannot validate.");
    process.exit(1);
  }
  const cryptoSource = readFile("packages/crypto/src/eval-attestation.ts");
  if (cryptoSource === null) {
    console.error(
      "check-eval-kind-canonical: could not read packages/crypto/src/eval-attestation.ts.",
    );
    console.error("Fix: restore the crypto EVAL_KINDS_MIRROR — the gate cannot validate.");
    process.exit(1);
  }

  const unionValues = readUnionValues(protocolSource);
  const arrayValues = readArrayValues(protocolSource, "ALL_EVAL_KINDS");
  const mirrorValues = readArrayValues(cryptoSource, "EVAL_KINDS_MIRROR");
  const gateValues = [...EVAL_KINDS_REFERENCE];

  if (unionValues.length === 0 || arrayValues.length === 0 || mirrorValues.length === 0) {
    console.error(
      "check-eval-kind-canonical: could not parse one of EvalKind union / ALL_EVAL_KINDS / EVAL_KINDS_MIRROR.",
    );
    console.error(
      "Fix: keep all three as literal declarations in packages/protocol/src/eval-attestation.ts and packages/crypto/src/eval-attestation.ts.",
    );
    process.exit(1);
  }

  const sites: Array<[string, Set<string>]> = [
    ["union (protocol)", new Set(unionValues)],
    ["ALL_EVAL_KINDS (protocol)", new Set(arrayValues)],
    ["EVAL_KINDS_MIRROR (crypto)", new Set(mirrorValues)],
    ["EVAL_KINDS_REFERENCE (gate)", new Set(gateValues)],
  ];
  const all = new Set(sites.flatMap(([, s]) => [...s]));
  const misaligned: string[] = [];
  for (const value of all) {
    const missing = sites.filter(([, s]) => !s.has(value)).map(([name]) => name);
    if (missing.length > 0) {
      misaligned.push(`  "${value}" missing from: ${missing.join(", ")}`);
    }
  }
  if (misaligned.length > 0) {
    console.error(
      "check-eval-kind-canonical: four-way lock failure across union × ALL_EVAL_KINDS × EVAL_KINDS_MIRROR × gate reference:",
    );
    for (const line of misaligned) console.error(line);
    console.error("");
    console.error(
      "Fix: adding an eval kind is intentional protocol-level work — update the EvalKind union + ALL_EVAL_KINDS in packages/protocol/src/eval-attestation.ts, EVAL_KINDS_MIRROR in packages/crypto/src/eval-attestation.ts, and EVAL_KINDS_REFERENCE in scripts/check-eval-kind-canonical.ts in the same commit.",
    );
    console.error("Doctrine: docs/doctrine/registry-pattern-canonical.md.");
    process.exit(1);
  }

  // === Wire-format compliance ===
  const malformed = gateValues.filter((v) => !SNAKE_CASE_PATTERN.test(v));
  if (malformed.length > 0) {
    console.error(
      `check-eval-kind-canonical: ${malformed.length} value(s) violate snake_case wire convention: ${malformed.join(", ")}`,
    );
    console.error(
      "Fix: rename the value in packages/protocol/src/eval-attestation.ts to ^[a-z][a-z0-9_]*$ (registries cross process boundaries; casing must round-trip identically).",
    );
    process.exit(1);
  }

  // === Emit-site scan — producers may only mint registry members ===
  const files: string[] = [];
  walkSources(join(ROOT, "packages"), files);
  walkSources(join(ROOT, "services"), files);
  const registry = new Set(gateValues);
  const violations: string[] = [];
  const emitPattern = /eval_kind:\s*"([^"]+)"/g;
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    while ((m = emitPattern.exec(src)) !== null) {
      const value = m[1] as string;
      if (!registry.has(value)) {
        const line = src.slice(0, m.index).split("\n").length;
        violations.push(`  ${relative(ROOT, file)}:${line} — eval_kind: "${value}"`);
      }
    }
  }
  if (violations.length > 0) {
    console.error(
      `check-eval-kind-canonical: ${violations.length} emit site(s) mint an eval_kind outside the closed registry:`,
    );
    for (const v of violations) console.error(v);
    console.error(
      "Fix: use a member of ALL_EVAL_KINDS from packages/protocol/src/eval-attestation.ts, or add the new kind to the registry (all four sites, same commit).",
    );
    process.exit(1);
  }

  console.log(
    `✓ check-eval-kind-canonical: ${gateValues.length} eval kind(s) locked across four sites; ${files.length} source files scanned; all emit sites registry-members; wire-format-compliant.`,
  );
}

main();
