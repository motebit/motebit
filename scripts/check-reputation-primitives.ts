/**
 * Reputation-primitive drift gate (invariant #28).
 *
 * Enforces: reputation scoring (continuous 0-1 score derived from trust-
 * record fields — successful/failed tasks, interaction volume, recency
 * decay) lives in `@motebit/policy` (basic) or `@motebit/market` (rich
 * composite). Inline reinvention in apps or services is a CI failure.
 *
 * This drift is real: before 2026-04-19, apps/admin/src/components/TrustPanel.ts
 * had a `reputationScore()` whose comment claimed to match @motebit/policy
 * but diverged on the Beta-binomial prior (MLE vs smoothed). Admin showed
 * different scores than AI-core computed for the same agent record. Fixed
 * in the same commit that added this gate.
 *
 * Heuristic (all required in one file):
 *   1. Has `Math.exp(-` or `Math.exp(-(` — the exponential-decay signature
 *      of inline reputation. Consumer code using the canonical function's
 *      output never calls `Math.exp` directly.
 *   2. References `interaction_count` or `volume` in the SAME file —
 *      the volume sub-score is only computed where reputation is computed.
 *   3. Does NOT import `computeReputationScore` or `computeServiceReputation`
 *      from the canonical packages — an import is strong evidence the file
 *      is a consumer, not a reinventor.
 *
 * All three conditions in the same file, outside the owning packages,
 * means inline reputation math — reject.
 *
 * Owning packages (allowed to compute reputation):
 *   - @motebit/policy (packages/policy/src/reputation.ts)
 *   - @motebit/market (packages/market/src/reputation.ts)
 *   - @motebit/runtime (consumes both, may score internally during
 *     trust-transition evaluation)
 *
 * Allowlist is intentionally empty at landing. Any future exception must
 * be added here with the reason + follow-up pass named.
 *
 * Exit 1 on violation. Runs in CI via `pnpm check`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [];

interface Violation {
  file: string;
  detail: string;
}

function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__" || entry === ".turbo")
      continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      out.push(...walkTypeScript(full));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  const allowSet = new Set(ALLOWLIST.map((e) => e.path));

  // Scan everywhere except the owning packages. Policy, market, and
  // runtime legitimately compute reputation; they ARE the canonical
  // implementation.
  const OWNED = new Set(["policy", "market", "runtime"]);
  const scanRoots = [
    join(ROOT, "apps"),
    join(ROOT, "services"),
    ...readdirSync(join(ROOT, "packages"))
      .filter((name) => !OWNED.has(name))
      .map((name) => join(ROOT, "packages", name)),
  ];

  for (const root of scanRoots) {
    let subdirs: string[];
    try {
      subdirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const sub of subdirs) {
      const srcDir = join(root, sub, "src");
      const files = walkTypeScript(srcDir);
      for (const file of files) {
        const rel = relative(ROOT, file);
        if (allowSet.has(rel)) continue;
        const source = readFileSync(file, "utf8");

        // Three-condition heuristic. The distinguishing signal for inline
        // reputation (vs consumer usage) is the exponential-decay math
        // AND absence of a canonical-function import.
        const refsDecay = /Math\.exp\(\s*-/.test(source); // Math.exp(-... — the decay signature
        const refsVolume = /\binteraction_count\b/.test(source) || /\bvolumeScore\b/.test(source);
        const importsCanonical =
          /\bcomputeReputationScore\b/.test(source) || /\bcomputeServiceReputation\b/.test(source);

        if (refsDecay && refsVolume && !importsCanonical) {
          violations.push({
            file: rel,
            detail:
              "inline reputation scoring — file references trust-record success/failure, interaction volume, AND recency decay. Import `computeReputationScore` from `@motebit/policy` (basic formula) or `computeServiceReputation` from `@motebit/market` (receipt-history composite) instead.",
          });
        }
      }
    }
  }
  return violations;
}

function main(): void {
  console.log(
    "▸ check-reputation-primitives — reputation scoring (0-1 continuous score from trust-record + recency decay) lives in @motebit/policy or @motebit/market, not inline in apps/services (invariant #28, added 2026-04-19 after apps/admin/TrustPanel was caught with a reinvented formula that diverged from its claimed @motebit/policy source on the Beta-binomial prior — admin showed different scores than AI-core for the same agent record; extends the protocol-primitive doctrine to reputation judgment)",
  );
  const violations = scan();
  if (violations.length === 0) {
    console.log(
      `✓ check-reputation-primitives: no inline reputation scoring in scanned source (allowlist: ${ALLOWLIST.length}).`,
    );
    process.exit(0);
  }

  console.error(`✗ check-reputation-primitives: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    ${v.detail}\n`);
  }
  console.error(
    "Fix: replace the inline formula with `computeReputationScore(record)` from `@motebit/policy` (if you only have an AgentTrustRecord) or `computeServiceReputation(record, receipts, ...)` from `@motebit/market` (if you also have receipt history).",
  );
  console.error(
    "If the file legitimately needs inline scoring that can't be expressed via the canonical formulas, add it to ALLOWLIST in scripts/check-reputation-primitives.ts with the reason + follow-up pass named.",
  );
  process.exit(1);
}

main();
