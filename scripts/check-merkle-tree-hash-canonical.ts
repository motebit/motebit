#!/usr/bin/env tsx
/**
 * `check-merkle-tree-hash-canonical` — coverage gate for the
 * `MerkleTreeVersion` closed registry AND the dispatch invariant that
 * gives it teeth.
 *
 * `MerkleTreeVersion` (`packages/protocol/src/merkle-tree-hash.ts`) is the
 * agility axis for RFC 6962 §2.1 leaf/node domain separation — `absent ⇒
 * merkle-sha256-plain-v1`, `merkle-sha256-rfc6962-v2` applies the `0x00`
 * leaf / `0x01` node tags. It is the eighth registered registry per
 * `docs/doctrine/registry-pattern-canonical.md`; this is artifact (5) of
 * its eight-artifact set, watched by `check-closed-registry-canonical`.
 *
 * Unlike the pure three-way-lock registry gates (`check-settlement-mode-
 * canonical` and friends), this gate's PRIMARY assertion is LOAD-BEARING in
 * the `check-suite-dispatch` sense (`docs/doctrine/merkle-tree-hash-
 * versioning.md` §6 assertion 1): the leaf tag and the node tag must live in
 * exactly one place each, so a second hand-rolled Merkle implementation
 * cannot silently ship RFC-6962-minus-§2.1 hashing while the registry looks
 * healthy. A weaker "registry exists, all v1 IDs present" check would pass
 * VACUOUSLY while the real invariant (no inline domain-tag hashing outside
 * the version-dispatched primitives) goes unchecked. The four assertions:
 *
 *   1. (LOAD-BEARING) Tag-byte localization. The RFC 6962 domain-separation
 *      tag bytes — the single-byte `new Uint8Array([0x00])` / `[0x01]` — may
 *      appear ONLY in the two allowlisted Merkle primitives
 *      (`packages/crypto/src/merkle.ts`, `packages/encryption/src/merkle.ts`).
 *      The only way to hand-roll RFC 6962 tagging is to introduce that byte;
 *      anywhere else it is a Merkle combine/leaf path that bypassed the
 *      primitive. An explicit `// merkle-tree-hash: intentional-domain-tag`
 *      waiver (with a reason) exempts a non-Merkle use, auditably.
 *
 *   2. (LOAD-BEARING) Leaf-builder route-through. Every registered leaf
 *      builder routes its leaf hash through the version-dispatched primitive
 *      (`canonicalLeaf` / `hashLeaf` in `@motebit/crypto`), or appears on the
 *      documented EXCLUSIONS list with a reason. This is the route-through-
 *      or-documented-exclusion shape §6 demands for the leaf side.
 *
 *   3. (SECONDARY) Registry ↔ dispatch-arm sync. Every member of
 *      `ALL_MERKLE_TREE_VERSIONS` has a string-literal dispatch arm in BOTH
 *      primitives, so a registry append without a primitive arm — the
 *      deploy-verifier-first footgun — fails here, not at a verifier on the
 *      wire.
 *
 *   4. (DORMANT) Spec-claim → producer (Option A). A spec MAY declare its
 *      registered tree-hash version + the producer it governs via a machine-
 *      readable frontmatter line `tree_hash_version: <id>` plus
 *      `tree_hash_producer: <path>`; the gate then asserts the named producer
 *      emits that version. No spec declares this in PR1 (the first v2 producer
 *      ships in PR2), so this arm is vacuous today and named here so PR2 knows
 *      the convention.
 *
 * Doctrine: `docs/doctrine/merkle-tree-hash-versioning.md` (§6 the gate, §2
 * the blast radius), `docs/doctrine/registry-pattern-canonical.md` (eighth
 * registered registry).
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Constants — the canonical surfaces this gate locks
// ---------------------------------------------------------------------------

/** The two Merkle primitives — the ONLY homes for the domain-tag bytes. */
const ALLOWLISTED_PRIMITIVES = new Set([
  "packages/crypto/src/merkle.ts",
  "packages/encryption/src/merkle.ts",
]);

/** Source trees scanned for inline domain-tag hashing (assertion 1). */
const SCAN_ROOTS = ["packages", "services", "apps"];

/** A single RFC 6962 domain-separation tag byte allocated inline. */
const TAG_BYTE_PATTERN = /new Uint8Array\(\[0x0[01]\]\)/;
const WAIVER = /merkle-tree-hash:\s*intentional-domain-tag/;
const WAIVER_REASON = /merkle-tree-hash:\s*intentional-domain-tag\s*[—-]\s*(.+?)$/;

/**
 * The registered Merkle leaf builders (assertion 2). Each file MUST reference
 * the version-dispatched leaf primitive (`canonicalLeaf` or `hashLeaf`); a
 * builder that stops routing through it is a violation.
 */
const LEAF_BUILDERS: ReadonlyArray<{ file: string; symbol: string }> = [
  { file: "packages/crypto/src/agent-settlement-anchor.ts", symbol: "computeAgentSettlementLeaf" },
  { file: "packages/crypto/src/credential-anchor.ts", symbol: "computeCredentialLeaf" },
  { file: "packages/crypto/src/index.ts", symbol: "identityLogLeaf" },
  { file: "packages/encryption/src/consolidation-anchor.ts", symbol: "verifyConsolidationAnchor" },
  // The relay's per-agent settlement producer (PR2) — the first v2 producer.
  // Hashes record_json directly; MUST route through hashLeaf so the leaf tag
  // is applied by the primitive, never inlined.
  { file: "services/relay/src/anchoring.ts", symbol: "agentSettlementLeaf" },
];

/**
 * Documented exclusions — leaf-shaped hashers that legitimately do NOT route
 * through the version-dispatched primitive yet, each with the reason. The §6
 * "or appears on a documented exclusion list with a reason" arm.
 */
const LEAF_EXCLUSIONS: ReadonlyArray<{ symbol: string; reason: string }> = [
  {
    symbol: "computeSettlementLeaf",
    reason:
      "federation-settlement leaf (packages/encryption/src/merkle.ts) — v1-only, deferred to PR3+ per merkle-tree-hash-versioning.md §2 (folds into the item-4 convergence). Lives inside an allowlisted primitive file; carries no domain tag.",
  },
];

/** The closed-registry source (assertion 3). */
const REGISTRY_SOURCE = "packages/protocol/src/merkle-tree-hash.ts";
const DISPATCH_PRIMITIVES = ["packages/crypto/src/merkle.ts", "packages/encryption/src/merkle.ts"];

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

function walkTs(absDir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      walkTs(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

interface TagFinding {
  file: string;
  line: number;
  context: string;
  reason: string | null;
}

function main(): void {
  const errors: string[] = [];

  // === Assertion 1: tag-byte localization (LOAD-BEARING) ==================
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    walkTs(resolve(ROOT, root), files);
  }
  const violations: TagFinding[] = [];
  const waived: TagFinding[] = [];
  for (const abs of files) {
    const rel = relative(ROOT, abs);
    if (ALLOWLISTED_PRIMITIVES.has(rel)) continue;
    const lines = readFileSync(abs, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!TAG_BYTE_PATTERN.test(line.replace(/\/\/.*$/, ""))) continue;
      const prev = i > 0 ? lines[i - 1]! : "";
      const waiverLine = WAIVER.test(line) ? line : WAIVER.test(prev) ? prev : null;
      const reason = waiverLine ? (WAIVER_REASON.exec(waiverLine)?.[1]?.trim() ?? null) : null;
      const finding: TagFinding = { file: rel, line: i + 1, context: line.trim(), reason };
      (waiverLine ? waived : violations).push(finding);
    }
  }
  if (violations.length > 0) {
    errors.push(
      `${violations.length} inline RFC 6962 domain-tag byte(s) outside the allowlisted Merkle primitives:`,
    );
    for (const v of violations) {
      errors.push(`    ${v.file}:${v.line}  ${v.context}`);
    }
    errors.push(
      "  → Route the leaf hash through `canonicalLeaf`/`hashLeaf` and the node combine through " +
        "`verifyMerkleInclusion`/`buildMerkleTree` (the version-dispatched primitives), or add " +
        "`// merkle-tree-hash: intentional-domain-tag — <reason>` if this is a non-Merkle use.",
    );
  }

  // === Assertion 2: leaf-builder route-through (LOAD-BEARING) =============
  for (const builder of LEAF_BUILDERS) {
    const src = readFile(builder.file);
    if (src === null) {
      errors.push(`leaf builder source missing: ${builder.file} (declares ${builder.symbol})`);
      continue;
    }
    if (!new RegExp(`\\b${builder.symbol}\\b`).test(src)) {
      errors.push(`leaf builder ${builder.symbol} not found in ${builder.file}`);
      continue;
    }
    // Word-boundary match so a renamed `canonicalLeafXX` does NOT satisfy the
    // route-through (substring `.includes` would let the rename slip past).
    if (!/\bcanonicalLeaf\b/.test(src) && !/\bhashLeaf\b/.test(src)) {
      errors.push(
        `leaf builder ${builder.symbol} (${builder.file}) no longer routes through the ` +
          "version-dispatched leaf primitive (`canonicalLeaf`/`hashLeaf`). A leaf hashed " +
          "without the primitive bypasses the RFC 6962 §2.1 leaf tag.",
      );
    }
  }

  // === Assertion 3: registry ↔ dispatch-arm sync (SECONDARY) ==============
  const registrySrc = readFile(REGISTRY_SOURCE);
  if (registrySrc === null) {
    errors.push(`registry source missing: ${REGISTRY_SOURCE}`);
  } else {
    const arrayMatch = registrySrc.match(
      /ALL_MERKLE_TREE_VERSIONS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]/,
    );
    const versions: string[] = [];
    if (arrayMatch) {
      const valuePattern = /"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = valuePattern.exec(arrayMatch[1] ?? "")) !== null) versions.push(m[1]!);
    }
    if (versions.length === 0) {
      errors.push(`could not parse ALL_MERKLE_TREE_VERSIONS in ${REGISTRY_SOURCE}`);
    }
    for (const primitive of DISPATCH_PRIMITIVES) {
      const psrc = readFile(primitive);
      if (psrc === null) {
        errors.push(`dispatch primitive missing: ${primitive}`);
        continue;
      }
      for (const v of versions) {
        if (!psrc.includes(`"${v}"`)) {
          errors.push(
            `registry version "${v}" has no dispatch arm in ${primitive} — a registered ` +
              "version without a primitive arm strands proofs (deploy-verifier-first footgun).",
          );
        }
      }
    }
  }

  // === Assertion 4: spec-claim → producer (Option A, DORMANT) =============
  // Scan committed specs for a machine-readable tree-hash declaration. None
  // exist in PR1 (the first v2 producer ships in PR2); this arm activates when
  // a spec opts in via `tree_hash_version:` + `tree_hash_producer:`.
  const specDeclarations: Array<{ spec: string; version: string; producer: string }> = [];
  let specFiles: string[] = [];
  try {
    specFiles = readdirSync(resolve(ROOT, "spec"))
      .filter((n) => n.endsWith(".md"))
      .map((n) => `spec/${n}`);
  } catch {
    specFiles = [];
  }
  for (const spec of specFiles) {
    const src = readFile(spec);
    if (src === null) continue;
    const vMatch = src.match(/^tree_hash_version:\s*(\S+)\s*$/m);
    const pMatch = src.match(/^tree_hash_producer:\s*(\S+)\s*$/m);
    if (vMatch && pMatch) {
      specDeclarations.push({ spec, version: vMatch[1]!, producer: pMatch[1]! });
    }
  }
  for (const decl of specDeclarations) {
    const producerSrc = readFile(decl.producer);
    if (producerSrc === null) {
      errors.push(
        `spec ${decl.spec} declares tree_hash_producer "${decl.producer}" but that file is unreadable.`,
      );
      continue;
    }
    if (!producerSrc.includes(`"${decl.version}"`)) {
      errors.push(
        `spec ${decl.spec} claims tree_hash_version "${decl.version}" but its producer ` +
          `${decl.producer} does not emit that version literal (Option A spec-claim → producer).`,
      );
    }
  }

  // === Report ============================================================
  if (errors.length > 0) {
    console.error(
      "check-merkle-tree-hash-canonical: MerkleTreeVersion dispatch/registry violations:\n",
    );
    for (const e of errors) console.error(`  ${e}`);
    console.error("\nDoctrine: docs/doctrine/merkle-tree-hash-versioning.md §6.");
    process.exit(1);
  }

  if (waived.length > 0) {
    console.log("ℹ Waived domain-tag uses (// merkle-tree-hash: intentional-domain-tag):");
    for (const w of waived) {
      console.log(`  ${w.file}:${w.line}${w.reason ? ` — ${w.reason}` : ""}`);
    }
  }
  console.log(
    `✓ check-merkle-tree-hash-canonical: domain-tag bytes localized to ${ALLOWLISTED_PRIMITIVES.size} ` +
      `primitive(s); ${LEAF_BUILDERS.length} leaf builder(s) route through the version-dispatched ` +
      `primitive (${LEAF_EXCLUSIONS.length} documented exclusion); registry ↔ dispatch arms in sync; ` +
      `Option A spec-claim arm ${specDeclarations.length === 0 ? "dormant (0 spec declarations — first v2 producer is PR2)" : `checked ${specDeclarations.length} declaration(s)`}.`,
  );
}

main();
