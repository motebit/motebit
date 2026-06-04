#!/usr/bin/env tsx
/**
 * check-artifact-type-canonical — synchronization invariant for the
 * `ContentArtifactType` closed registry.
 *
 * Doctrine: `docs/doctrine/nist-alignment.md` §8 (content-provenance);
 * the `ContentArtifactType` literal union in
 * `packages/protocol/src/artifact-type.ts`.
 *
 * Pre-registry, `artifact_type` on `ContentArtifactManifest` was a free
 * string and the manifest JSDoc carried three example values
 * (`"audit-trail"`, `"memory-export"`, `"plan"`). A typo at a producer
 * site (`artifact_type: "audit_trail"` instead of `"audit-trail"`) was
 * a verifier-side classification miss with no compile-time signal.
 * Locking the registry as a closed union makes the typo a compile
 * error AND a CI error: this gate scans every artifact-type literal
 * site in the repo and asserts the literal is in
 * `ALL_CONTENT_ARTIFACT_TYPES`.
 *
 * Forbidden: a string literal at a known signing-site shape that is
 * not a member of the canonical set.
 *
 *   ✗  artifact_type: "audit_trail"                  // typo
 *   ✗  artifactType: "exec-ledger"                   // typo
 *   ✗  artifact_type: "new-thing"                    // unregistered
 *
 * Allowed:
 *
 *   ✓  artifact_type: "audit-trail"                  // canonical literal
 *   ✓  artifactType: AUDIT_TRAIL_ARTIFACT            // typed constant
 *   ✓  artifact_type: ContentArtifactType variable   // already narrowed
 *
 * Adding a category requires updating
 * `packages/protocol/src/artifact-type.ts` (the union, the named
 * constant, `ALL_CONTENT_ARTIFACT_TYPES`) plus the doctrine entry at
 * `docs/doctrine/nist-alignment.md` §8. Same governance as
 * `TokenAudience` (see `check-audience-canonical.ts`).
 *
 * Scope: TS files under `packages/`, `services/`, `apps/`. Excludes
 * the canonical home (`packages/protocol/src/artifact-type.ts`),
 * tests, dist, and node_modules.
 *
 * Usage:
 *   tsx scripts/check-artifact-type-canonical.ts        # exit 1 on violation
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

/**
 * The canonical set, mirrored from
 * `packages/protocol/src/artifact-type.ts:ALL_CONTENT_ARTIFACT_TYPES`.
 * The mirror is intentional — same rationale as `check-audience-canonical`:
 * re-deriving the set at gate runtime would be a circular dependency on
 * the file the gate exists to defend. The sibling-test in this gate reads
 * `artifact-type.ts` and asserts the two lists agree, so a registry
 * update without a gate update is itself a CI failure.
 */
const CANONICAL_ARTIFACT_TYPES = new Set<string>([
  "state-snapshot",
  "memory-export",
  "goal-list",
  "conversation-list",
  "conversation-messages",
  "device-list",
  "audit-trail",
  "plan-list",
  "plan-detail",
  "gradient-history",
  "sync-pull",
  "execution-ledger",
  "goal-result",
  "settlement-summary",
]);

/**
 * The canonical home — the only file allowed to declare artifact-type
 * literal strings outside the matching set (since it IS the matching
 * set). Skipping prevents a circular failure where adding a new type
 * to the union shows up as N "unknown literal" findings in the gate's
 * own self-scan.
 */
const CANONICAL_FILES = new Set<string>(["packages/protocol/src/artifact-type.ts"]);

/**
 * Patterns that identify an artifact-type literal at a signing or
 * verification site:
 *
 *   `artifact_type: "<literal>"`     wire-shape (snake_case) property
 *   `artifactType: "<literal>"`      JS-shape (camelCase) option field
 *   `artifact_type === "<literal>"`  equality check
 *   `artifact_type !== "<literal>"`  negation check
 *   `artifactType === "<literal>"`   equality check (camelCase form)
 *   `artifactType !== "<literal>"`   negation check (camelCase form)
 *
 * Captures the literal in group 1.
 */
const LITERAL_PATTERNS: { regex: RegExp; name: string }[] = [
  { regex: /\bartifact_type\s*:\s*["']([^"']+)["']/g, name: "artifact_type: <literal>" },
  { regex: /\bartifactType\s*:\s*["']([^"']+)["']/g, name: "artifactType: <literal>" },
  { regex: /\bartifact_type\s*===\s*["']([^"']+)["']/g, name: "artifact_type === <literal>" },
  { regex: /\bartifact_type\s*!==\s*["']([^"']+)["']/g, name: "artifact_type !== <literal>" },
  { regex: /\bartifactType\s*===\s*["']([^"']+)["']/g, name: "artifactType === <literal>" },
  { regex: /\bartifactType\s*!==\s*["']([^"']+)["']/g, name: "artifactType !== <literal>" },
];

const SCAN_ROOTS = [
  join(REPO_ROOT, "packages"),
  join(REPO_ROOT, "services"),
  join(REPO_ROOT, "apps"),
];

interface Finding {
  file: string;
  line: number;
  pattern: string;
  literal: string;
  context: string;
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
        entry.name === ".turbo" ||
        entry.name === ".next"
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
  return (
    rel.includes("/__tests__/") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx") ||
    rel.endsWith(".spec.ts") ||
    rel.endsWith(".spec.tsx")
  );
}

/**
 * `typeof x === "string"` is a JS runtime type check, not a literal.
 * Skipping lines that contain `typeof` rules out the (unlikely) case
 * where an identifier named `artifactType` appears with a typeof
 * idiom — defensive parity with `check-audience-canonical`.
 */
function isTypeofIdiom(line: string): boolean {
  return /\btypeof\b/.test(line);
}

function scanFile(abs: string): Finding[] {
  const rel = relative(REPO_ROOT, abs);
  if (CANONICAL_FILES.has(rel)) return [];
  if (isTestFile(rel)) return [];
  const src = readFileSync(abs, "utf-8");
  const lines = src.split("\n");
  const findings: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const code = line.replace(/\/\/.*$/, "");
    if (isTypeofIdiom(code)) continue;
    for (const { regex, name } of LITERAL_PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(code)) !== null) {
        const literal = match[1]!;
        if (CANONICAL_ARTIFACT_TYPES.has(literal)) continue;
        findings.push({
          file: rel,
          line: i + 1,
          pattern: name,
          literal,
          context: line.trim(),
        });
      }
    }
  }
  return findings;
}

/**
 * Sibling check: the gate's hardcoded `CANONICAL_ARTIFACT_TYPES` must
 * exactly match `ALL_CONTENT_ARTIFACT_TYPES` in
 * `packages/protocol/src/artifact-type.ts`. Drift between the two is
 * itself a failure — a registry addition without a gate update would
 * silently allow the new literal here.
 */
function assertRegistryAlignment(): void {
  const src = readFileSync(join(REPO_ROOT, "packages/protocol/src/artifact-type.ts"), "utf-8");
  const blockMatch =
    /export const ALL_CONTENT_ARTIFACT_TYPES[\s\S]*?Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src);
  if (!blockMatch || !blockMatch[1]) {
    process.stderr.write(
      "check-artifact-type-canonical: cannot locate ALL_CONTENT_ARTIFACT_TYPES in packages/protocol/src/artifact-type.ts\n",
    );
    process.exit(2);
  }
  const declared = new Set<string>();
  for (const m of blockMatch[1].matchAll(/["']([^"']+)["']/g)) {
    declared.add(m[1]!);
  }
  const missingFromGate = [...declared].filter((a) => !CANONICAL_ARTIFACT_TYPES.has(a));
  const extraInGate = [...CANONICAL_ARTIFACT_TYPES].filter((a) => !declared.has(a));
  if (missingFromGate.length > 0 || extraInGate.length > 0) {
    process.stderr.write(
      "check-artifact-type-canonical: registry alignment failure — gate's CANONICAL_ARTIFACT_TYPES is out of sync with packages/protocol/src/artifact-type.ts ALL_CONTENT_ARTIFACT_TYPES.\n",
    );
    if (missingFromGate.length > 0) {
      process.stderr.write(
        `  Types in artifact-type.ts but not in this gate: ${missingFromGate.join(", ")}\n`,
      );
    }
    if (extraInGate.length > 0) {
      process.stderr.write(
        `  Types in this gate but not in artifact-type.ts: ${extraInGate.join(", ")}\n`,
      );
    }
    process.stderr.write(
      "  Fix: update CANONICAL_ARTIFACT_TYPES in scripts/check-artifact-type-canonical.ts to mirror ALL_CONTENT_ARTIFACT_TYPES.\n",
    );
    process.exit(1);
  }
}

function main(): void {
  assertRegistryAlignment();

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

  console.log(
    `check-artifact-type-canonical — scanned ${files.length} files across packages/, services/, apps/ (excluding ${[...CANONICAL_FILES].join(", ")} and tests)\n`,
  );

  if (findings.length === 0) {
    console.log(
      `✓ Every artifact-type literal at a signing or verification site is in the canonical ContentArtifactType set (${CANONICAL_ARTIFACT_TYPES.size} types).`,
    );
    return;
  }

  console.log(`✗ Artifact-type literal not in the canonical ContentArtifactType set:\n`);
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  "${f.literal}"  (${f.pattern})`);
    console.log(`    ${f.context}`);
  }
  console.log(
    `\n  Fix: either use a canonical literal / named constant\n` +
      `       (import from "@motebit/protocol"), OR add the new type to\n` +
      `       the registry in three places:\n` +
      `         1. \`ContentArtifactType\` union in packages/protocol/src/artifact-type.ts\n` +
      `         2. Named constant + ALL_CONTENT_ARTIFACT_TYPES entry in same file\n` +
      `         3. CANONICAL_ARTIFACT_TYPES in scripts/check-artifact-type-canonical.ts\n` +
      `       Plus a doctrine update at docs/doctrine/nist-alignment.md §8.\n`,
  );
  process.exit(1);
}

main();
