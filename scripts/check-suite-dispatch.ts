#!/usr/bin/env tsx
/**
 * check-suite-dispatch — synchronization invariant #12 (code-side).
 *
 * Every verifier in `@motebit/crypto` that checks a signed motebit
 * artifact MUST route primitive verification through
 * `packages/crypto/src/suite-dispatch.ts` (via `verifyBySuite` /
 * `signBySuite` / `ed25519Sign` / `ed25519Verify`). Direct calls to
 * `ed.verifyAsync`, `ed.signAsync`, `ed.sign`, or `ed.verify` outside
 * the dispatcher are a violation.
 *
 * Why: a spec-side gate (`check-suite-declared`, invariant #11)
 * enforces that every artifact declares a `suite` field on the wire.
 * Without this code-side gate, a verifier could silently hardcode
 * Ed25519 while the wire-format declares `suite`, and the spec gate
 * would stay green. Both invariants together give end-to-end
 * enforcement: declared on the wire, dispatched in the code.
 *
 * Allowlist: the dispatcher file itself (`suite-dispatch.ts`) is the
 * single permitted home for the noble `ed.*` primitives. Any other
 * file in `packages/crypto/src/` that contains the flagged patterns
 * is a violation. A call site may declare itself intentional by
 * adding an inline comment `// crypto-suite: intentional-primitive-call`
 * on the same line or the line above; the gate respects that waiver
 * but prints it in the output so waivers are auditable.
 *
 * Usage:
 *   tsx scripts/check-suite-dispatch.ts           # exit 1 on violation
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const DISPATCHER_FILE = "suite-dispatch.ts";
const WAIVER_COMMENT = /crypto-suite:\s*intentional-primitive-call/;
// Optional structured reason after the waiver marker, introduced by
// an em-dash or hyphen. Extracted and printed in the banner so `pnpm
// check` output documents *why* each waiver exists, not just *where*.
const WAIVER_REASON = /crypto-suite:\s*intentional-primitive-call\s*[—-]\s*(.+?)$/;

/**
 * Scope of the scan. Originally `packages/crypto/src/` only — widened
 * 2026-04-13 to include every service and app tree after the
 * cold-install walkthrough found `services/proxy/src/validation.ts`
 * calling `ed.verifyAsync` directly (Vercel Edge Runtime path, legit
 * but previously invisible to the gate). Keeping the dispatcher inside
 * packages/crypto/src/ is still the protocol contract; services and
 * apps either route through @motebit/crypto's dispatcher or declare
 * an explicit waiver.
 */
const SCAN_ROOTS = [
  join(REPO_ROOT, "packages", "crypto", "src"),
  join(REPO_ROOT, "services"),
  join(REPO_ROOT, "apps"),
];
const DISPATCHER_ABS = join(REPO_ROOT, "packages", "crypto", "src", DISPATCHER_FILE);

// Patterns that indicate a direct primitive call. Kept precise to
// avoid false positives on strings, type imports, or destructuring.
const FORBIDDEN_PATTERNS: { regex: RegExp; name: string }[] = [
  { regex: /\bed\.verifyAsync\b/, name: "ed.verifyAsync" },
  { regex: /\bed\.signAsync\b/, name: "ed.signAsync" },
  { regex: /\bed\.verify\b(?!Async)/, name: "ed.verify" },
  { regex: /\bed\.sign\b(?!Async)/, name: "ed.sign" },
  { regex: /\bed\.getPublicKey\b/, name: "ed.getPublicKey" },
  { regex: /\bed\.keygenAsync\b/, name: "ed.keygenAsync" },
];

interface Finding {
  file: string;
  line: number;
  pattern: string;
  context: string;
  waived: boolean;
  reason: string | null;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
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

function scanFile(abs: string): Finding[] {
  const rel = relative(REPO_ROOT, abs);
  if (rel.endsWith(`/${DISPATCHER_FILE}`)) return []; // the one allowed home
  const src = readFileSync(abs, "utf-8");
  const lines = src.split("\n");
  const findings: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip comment-only lines — stripping the trailing comment from a
    // mixed line still scans the code part.
    const code = line.replace(/\/\/.*$/, "");
    for (const { regex, name } of FORBIDDEN_PATTERNS) {
      if (regex.test(code)) {
        const prev = i > 0 ? lines[i - 1]! : "";
        const waiverLine = WAIVER_COMMENT.test(line)
          ? line
          : WAIVER_COMMENT.test(prev)
            ? prev
            : null;
        const waived = waiverLine !== null;
        const reason = waiverLine ? (WAIVER_REASON.exec(waiverLine)?.[1]?.trim() ?? null) : null;
        findings.push({
          file: rel,
          line: i + 1,
          pattern: name,
          context: line.trim(),
          waived,
          reason,
        });
      }
    }
  }
  return findings;
}

function main(): void {
  // Ensure the dispatcher exists; otherwise the invariant is vacuous.
  try {
    statSync(DISPATCHER_ABS);
  } catch {
    console.error(
      `check-suite-dispatch: dispatcher not found at ${relative(REPO_ROOT, DISPATCHER_ABS)}`,
    );
    process.exit(1);
  }

  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    try {
      statSync(root);
    } catch {
      continue; // root may not exist (e.g. `apps/` in a trimmed checkout)
    }
    walkTs(root, files);
  }
  const findings = files.flatMap(scanFile);
  const active = findings.filter((f) => !f.waived);
  const waived = findings.filter((f) => f.waived);

  console.log(
    `check-suite-dispatch — scanned ${files.length} files across packages/crypto/src, services/, apps/ (excluding ${DISPATCHER_FILE})\n`,
  );

  if (waived.length > 0) {
    console.log(
      `ℹ Waived call sites (explicit ${"// crypto-suite: intentional-primitive-call"}):\n`,
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
      "✓ Every signature primitive call in @motebit/crypto is routed through `suite-dispatch.ts`.",
    );
    return;
  }

  console.log(
    `✗ Direct primitive calls outside ${DISPATCHER_FILE} — route via verifyBySuite / signBySuite instead:\n`,
  );
  for (const f of active) {
    console.log(`  ${f.file}:${f.line}  ${f.pattern}`);
    console.log(`    ${f.context}`);
  }
  console.log(
    "\n  Fix: replace the direct call with a dispatcher call, or add " +
      "`// crypto-suite: intentional-primitive-call` above the line with a reason.",
  );
  process.exit(1);
}

main();
