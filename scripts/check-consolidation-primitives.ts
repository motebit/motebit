/**
 * Consolidation-primitive drift gate (invariant #34).
 *
 * Enforces: the four-phase consolidation cycle (orient → gather →
 * consolidate → prune) lives in `packages/runtime/src/consolidation-cycle.ts`.
 * Inline reinvention of the cycle's distinguishing logic — clustering
 * episodic memories, summarizing them via the LLM, and closing the loop
 * with formMemory + deleteMemory — is a CI failure.
 *
 * Why this drift is real: motebit shipped two separate maintenance
 * loops (`runHousekeeping` and `proactiveAction:"reflect"`) that did
 * overlapping work in different shapes. Commits 1-3 unified them into
 * `runConsolidationCycle`. The second time someone needs "cluster +
 * LLM-summarize + form-semantic-memory + tombstone-sources" in a new
 * place, this gate fires and points them at the cycle.
 *
 * Heuristic (all three required in one file):
 *   1. References `clusterBySimilarity(` — the cosine-clustering primitive.
 *   2. References `provider.generate(` OR an LLM-summary prompt phrase
 *      (`summariz` substring, case-insensitive). The LLM-summarization
 *      step is the cycle's distinguishing move.
 *   3. References `formMemory(` AND `deleteMemory(` (closing the loop:
 *      synthesize new + tombstone sources).
 *
 * Files allowed to express the full pattern (the canonical home + the
 * deprecation-window shim):
 *   - packages/runtime/src/consolidation-cycle.ts (the cycle itself)
 *   - packages/runtime/src/housekeeping.ts (deprecated alias; deletion
 *     follow-up tracked outside this gate)
 *
 * Allowlist additions require a one-line reason + named follow-up.
 *
 * Exit 1 on violation. Runs in CI via `pnpm check`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: "packages/runtime/src/consolidation-cycle.ts",
    reason: "the canonical home of the four-phase cycle",
  },
];

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

  const scanRoots = [
    join(ROOT, "apps"),
    join(ROOT, "services"),
    ...readdirSync(join(ROOT, "packages")).map((name) => join(ROOT, "packages", name)),
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

        const refsCluster = /\bclusterBySimilarity\s*\(/.test(source);
        if (!refsCluster) continue;

        const refsLlmSummary = /\bprovider\.generate\s*\(/.test(source) || /summariz/i.test(source);
        if (!refsLlmSummary) continue;

        const refsForm = /\bformMemory\s*\(/.test(source);
        const refsDelete = /\bdeleteMemory\s*\(/.test(source);
        if (!(refsForm && refsDelete)) continue;

        violations.push({
          file: rel,
          detail:
            "inline consolidation cycle — file combines clusterBySimilarity + LLM summarization + formMemory + deleteMemory without importing the canonical cycle. Use `runConsolidationCycle` from `packages/runtime/src/consolidation-cycle.ts` (or call `runtime.consolidationCycle()` from a runtime consumer). The cycle composes the four phases with per-phase budgets, presence transitions, and a single audit event.",
        });
      }
    }
  }
  return violations;
}

function main(): void {
  console.log(
    "▸ check-consolidation-primitives — the four-phase consolidation cycle (cluster + LLM-summarize + form-semantic + tombstone-sources) lives in packages/runtime/src/consolidation-cycle.ts (or call runtime.consolidationCycle()), not inline in apps/services/sibling-packages (invariant #34, added 2026-04-20 alongside the unification of runHousekeeping + proactive reflection into one cycle — extends the protocol-primitive doctrine to proactive-interior judgment and prevents the next consumer from re-implementing the autoDream-shape loop in a new shape)",
  );
  const violations = scan();
  if (violations.length === 0) {
    console.log(
      `✓ check-consolidation-primitives: no inline cycle reinvention in scanned source (allowlist: ${ALLOWLIST.length}).`,
    );
    process.exit(0);
  }

  console.error(`✗ check-consolidation-primitives: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    ${v.detail}\n`);
  }
  console.error(
    "Fix: call `runtime.consolidationCycle()` (the runtime method) or `runConsolidationCycle(deps, config)` directly. Both invoke the four-phase pipeline with budgets, presence transitions, and a single audit event. Inline cluster+summarize+form+delete is exactly the shape that diverged into housekeeping vs reflection before — the gate exists to prevent the third copy.",
  );
  console.error(
    "If the file legitimately needs an alternative consolidation path that can't be expressed via the cycle, add it to ALLOWLIST in scripts/check-consolidation-primitives.ts with the reason + follow-up pass named.",
  );
  process.exit(1);
}

main();
