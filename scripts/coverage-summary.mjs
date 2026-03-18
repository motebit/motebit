import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// Known thresholds (from vitest.config.ts files)
const thresholds = {
  "packages/event-log": 100,
  "packages/crypto": 97,
  "packages/memory-graph": 96,
  "packages/market": 100,
  "packages/semiring": 100,
  "packages/policy": 96,
  "packages/verify": 90,
  "packages/identity-file": 96,
  "packages/planner": 87,
  "packages/sync-engine": 82,
  "packages/runtime": 78,
  "packages/ai-core": 76,
  "packages/persistence": 80,
  "services/api": 69,
};

/** @type {Array<{name: string, statements: number, branches: number, functions: number, lines: number}>} */
const results = [];

for (const dir of ["packages", "services", "apps"]) {
  const dirPath = resolve(root, dir);
  if (!existsSync(dirPath)) continue;

  let entries;
  try {
    entries = readdirSync(dirPath);
  } catch {
    continue;
  }

  for (const entry of entries) {
    const summaryPath = resolve(root, dir, entry, "coverage", "coverage-summary.json");
    if (!existsSync(summaryPath)) continue;

    try {
      const data = JSON.parse(readFileSync(summaryPath, "utf8"));
      const total = data.total;
      if (!total) continue;

      results.push({
        name: `${dir}/${entry}`,
        statements: total.statements?.pct ?? 0,
        branches: total.branches?.pct ?? 0,
        functions: total.functions?.pct ?? 0,
        lines: total.lines?.pct ?? 0,
      });
    } catch {
      // Skip malformed files
    }
  }
}

results.sort((a, b) => a.name.localeCompare(b.name));

if (results.length === 0) {
  console.log("No coverage reports found.");
  process.exit(0);
}

console.log("## Coverage Summary\n");
console.log("| Package | Statements | Branches | Functions | Lines | Threshold | Status |");
console.log("|---------|-----------|----------|-----------|-------|-----------|--------|");

const RATCHET_GAP = 5;
const ratchetCandidates = [];

for (const r of results) {
  const threshold = thresholds[r.name];
  const thresholdStr = threshold != null ? `${threshold}%` : "—";
  const status =
    threshold != null
      ? r.statements >= threshold
        ? "✅"
        : "❌"
      : "—";
  console.log(
    `| ${r.name} | ${r.statements}% | ${r.branches}% | ${r.functions}% | ${r.lines}% | ${thresholdStr} | ${status} |`,
  );

  if (threshold != null && r.statements >= threshold + RATCHET_GAP) {
    ratchetCandidates.push({
      name: r.name,
      actual: r.statements,
      threshold,
      suggested: Math.floor(r.statements) - 3,
    });
  }
}

// Emit GitHub Actions warnings for ratchet candidates
for (const c of ratchetCandidates) {
  console.log(
    `\n::warning::${c.name} coverage ${c.actual}% is ${RATCHET_GAP}+ points above threshold ${c.threshold}%. Consider ratcheting to ${c.suggested}%.`,
  );
}
