#!/usr/bin/env tsx
/**
 * check-audience-canonical — synchronization invariant for the
 * `TokenAudience` closed registry.
 *
 * Doctrine: `services/relay/CLAUDE.md` Rule 5; the `TokenAudience`
 * literal union in `packages/protocol/src/audience.ts`.
 *
 * Pre-registry, the canonical audience set lived in three places that
 * disagreed (relay middleware: 10, callers: 15, doctrine: 6). A typo
 * at a signing site (`aud: "task:sumbit"`) became a runtime 401 at
 * the verifier — same fail-loud semantics, but the wire round-trip
 * is the only signal. Locking the registry as a closed union makes
 * typos a compile error AND a CI error: this gate scans every
 * audience-literal site in the repo and asserts the literal is in
 * `ALL_TOKEN_AUDIENCES`.
 *
 * Forbidden: a string literal at a known-signing-site shape that is
 * not a member of the canonical set.
 *
 *   ✗  aud: "task:sumbit"                        // typo
 *   ✗  createSyncToken("syncc")                  // typo
 *   ✗  aud: "new-thing"                          // unregistered
 *
 * Allowed:
 *
 *   ✓  aud: "task:submit"                        // canonical literal
 *   ✓  aud: TASK_SUBMIT_AUDIENCE                 // typed constant
 *   ✓  aud: TokenAudience-typed variable         // already narrowed
 *   ✓  expectedAudience: TokenAudience parameter // verifier-side; typed since the
 *      relay hardening pass — a plain-string audience param at a verifier seam
 *      reopens the positional-arg blindness this line-based gate cannot see.
 *      Structural typing is the primary defense; this gate is the lint backstop.
 *
 * Adding an audience requires updating
 * `packages/protocol/src/audience.ts` (the union, the named constant,
 * `ALL_TOKEN_AUDIENCES`) plus the doctrine entry at
 * `services/relay/CLAUDE.md` Rule 5. Same governance as cryptosuite
 * agility (`SuiteId` registry).
 *
 * Scope: TS files under `packages/`, `services/`, `apps/`. Excludes
 * the canonical home (`packages/protocol/src/audience.ts`), tests,
 * dist, and node_modules.
 *
 * Usage:
 *   tsx scripts/check-audience-canonical.ts        # exit 1 on violation
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

/**
 * The canonical set, mirrored from
 * `packages/protocol/src/audience.ts:ALL_TOKEN_AUDIENCES`. The mirror
 * is intentional: this gate's correctness depends on the registry
 * being closed, so re-deriving the set at gate runtime would be a
 * circular dependency on the file the gate exists to defend. The
 * sibling-test in this gate reads `audience.ts` and asserts the two
 * lists agree, so a registry update without a gate update is itself
 * a CI failure.
 */
const CANONICAL_AUDIENCES = new Set<string>([
  "sync",
  "device:auth",
  "pair",
  "rotate-key",
  "push:register",
  "task:submit",
  "task:query",
  "task:result",
  "admin:query",
  "proposal",
  "receipts:read",
  "market:listing",
  "market:query",
  "credentials",
  "credentials:present",
  "account:balance",
  "account:deposit",
  "account:withdraw",
  "account:withdrawals",
  "account:checkout",
  "browser-sandbox-grant",
  "browser-sandbox",
  "runtime:attach",
]);

/**
 * The canonical home — the only file allowed to declare
 * audience-literal strings outside the matching set (since it IS
 * the matching set). Skipping prevents a circular failure where
 * adding a new audience to the union shows up as N "unknown
 * literal" findings in the gate's own self-scan.
 */
const CANONICAL_FILES = new Set<string>(["packages/protocol/src/audience.ts"]);

/**
 * Patterns that identify an audience literal at a signing or
 * verification site:
 *
 *   `aud: "<literal>"`               object property syntax
 *   `aud === "<literal>"`            equality check
 *   `aud !== "<literal>"`            negation check
 *   `createSyncToken("<literal>")`   the WebApp / mobile-app helper
 *   `createCallerToken("<literal>")` future-shape; defensive
 *
 * Captures the literal in group 1.
 */
const LITERAL_PATTERNS: { regex: RegExp; name: string }[] = [
  { regex: /\baud\s*:\s*["']([^"']+)["']/g, name: "aud: <literal>" },
  { regex: /\baud\s*===\s*["']([^"']+)["']/g, name: "aud === <literal>" },
  { regex: /\baud\s*!==\s*["']([^"']+)["']/g, name: "aud !== <literal>" },
  {
    regex: /\bcreateSyncToken\s*\(\s*["']([^"']+)["']/g,
    name: "createSyncToken(<literal>)",
  },
  {
    regex: /\bcreateCallerToken\s*\(\s*["']([^"']+)["']/g,
    name: "createCallerToken(<literal>)",
  },
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
 * `typeof x === "string"` is a JS runtime type check, not an audience
 * literal. The regex `aud === "<literal>"` matches `typeof rec.aud
 * === "string"` because `aud` appears as a sub-identifier on the LHS;
 * skipping lines that contain `typeof` rules these out without losing
 * real audience comparisons (no real comparison would carry `typeof`
 * on the same line).
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
    // Strip line comments so a comment-only mention doesn't trip the gate.
    const code = line.replace(/\/\/.*$/, "");
    if (isTypeofIdiom(code)) continue;
    for (const { regex, name } of LITERAL_PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(code)) !== null) {
        const literal = match[1]!;
        if (CANONICAL_AUDIENCES.has(literal)) continue;
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
 * Sibling check: the gate's hardcoded `CANONICAL_AUDIENCES` must
 * exactly match `ALL_TOKEN_AUDIENCES` in `packages/protocol/src/audience.ts`.
 * Drift between the two is itself a failure — a registry addition
 * without a gate update would silently allow the new literal here
 * (the gate would mirror the OLD set, not the new one).
 */
function assertRegistryAlignment(): void {
  const audienceSrc = readFileSync(join(REPO_ROOT, "packages/protocol/src/audience.ts"), "utf-8");
  // Pull the literal entries from the `ALL_TOKEN_AUDIENCES` array
  // body. Conservative regex: any double-quoted string token
  // appearing inside the freeze body. The file's other literals
  // (the union, the const declarations) also use double-quoted
  // strings, so this catches the full registry surface.
  const blockMatch =
    /export const ALL_TOKEN_AUDIENCES[\s\S]*?Object\.freeze\(\[([\s\S]*?)\]\)/.exec(audienceSrc);
  if (!blockMatch || !blockMatch[1]) {
    process.stderr.write(
      "check-audience-canonical: cannot locate ALL_TOKEN_AUDIENCES in packages/protocol/src/audience.ts\n",
    );
    process.exit(2);
  }
  const declared = new Set<string>();
  for (const m of blockMatch[1].matchAll(/["']([^"']+)["']/g)) {
    declared.add(m[1]!);
  }
  const missingFromGate = [...declared].filter((a) => !CANONICAL_AUDIENCES.has(a));
  const extraInGate = [...CANONICAL_AUDIENCES].filter((a) => !declared.has(a));
  if (missingFromGate.length > 0 || extraInGate.length > 0) {
    process.stderr.write(
      "check-audience-canonical: registry alignment failure — gate's CANONICAL_AUDIENCES is out of sync with packages/protocol/src/audience.ts ALL_TOKEN_AUDIENCES.\n",
    );
    if (missingFromGate.length > 0) {
      process.stderr.write(
        `  Audiences in audience.ts but not in this gate: ${missingFromGate.join(", ")}\n`,
      );
    }
    if (extraInGate.length > 0) {
      process.stderr.write(
        `  Audiences in this gate but not in audience.ts: ${extraInGate.join(", ")}\n`,
      );
    }
    process.stderr.write(
      "  Fix: update CANONICAL_AUDIENCES in scripts/check-audience-canonical.ts to mirror ALL_TOKEN_AUDIENCES.\n",
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
    `check-audience-canonical — scanned ${files.length} files across packages/, services/, apps/ (excluding ${[...CANONICAL_FILES].join(", ")} and tests)\n`,
  );

  if (findings.length === 0) {
    console.log(
      `✓ Every audience literal at a signing or verification site is in the canonical TokenAudience set (${CANONICAL_AUDIENCES.size} audiences).`,
    );
    return;
  }

  console.log(`✗ Audience literal not in the canonical TokenAudience set:\n`);
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  "${f.literal}"  (${f.pattern})`);
    console.log(`    ${f.context}`);
  }
  console.log(
    `\n  Fix: either use a canonical audience literal / named constant\n` +
      `       (import from "@motebit/sdk" or "@motebit/protocol"), OR add\n` +
      `       the new audience to the registry in three places:\n` +
      `         1. \`TokenAudience\` union in packages/protocol/src/audience.ts\n` +
      `         2. Named constant + ALL_TOKEN_AUDIENCES entry in same file\n` +
      `         3. CANONICAL_AUDIENCES in scripts/check-audience-canonical.ts\n` +
      `       Plus a doctrine update at services/relay/CLAUDE.md Rule 5.\n`,
  );
  process.exit(1);
}

main();
