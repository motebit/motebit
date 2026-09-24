#!/usr/bin/env tsx
/**
 * measure-gate-aperture — when a gate says "clean", how much did it look at?
 *
 * A green gate makes a claim, and the claim is only as wide as its aperture.
 * `check-affordance-routing` enforced surface determinism while scanning 57 of
 * 322 app source files — six of nine apps saw ZERO — and printed "9 apps clean"
 * (#545). It was not wrong about what it examined; it was silent about how
 * little that was.
 *
 * That shape surfaced SEVEN times in one day: `check-deps` exempting every
 * layer-6 package, a service with no vitest config measuring only the files its
 * tests imported, a conformance probe blind to the cause, a threshold parser
 * reading the wrong numbers, and so on. The common property is not a bug in the
 * predicate — every one of those gates was correct about what it saw. The bug
 * is that nothing forced the aperture into the open.
 *
 * `check-gates-effective` already proves every gate BITES (and, since the
 * repair-instruction arc, that it explains itself when it does). It drives each
 * gate into FAILURE. This is the inverse surface: run each gate in its normal
 * PASSING state and ask whether the success output states what was examined.
 *
 * A REPORT, not a gate — deliberately, and this is the whole point of running
 * it before mandating anything. Making disclosure a hard requirement across 152
 * gates without first knowing how many already comply would be exactly the
 * "plan the work before measuring it" mistake the coverage-graduation
 * post-mortem records. Measure, then decide.
 *
 * Not every gate scans a set — some validate a single manifest, where a count is
 * noise. Those are reported separately rather than counted as violations; no
 * mechanical check can tell a scanning gate from a singleton one, and pretending
 * otherwise would manufacture false precision.
 *
 * Usage:
 *   npx tsx scripts/measure-gate-aperture.ts
 *   … --verbose     # show each gate's first success line
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hasApertureDisclosure } from "./lib/gate-report.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const VERBOSE = process.argv.includes("--verbose");

/** Gate script names, read from the canonical GATES array in check.ts. */
function gateScripts(): string[] {
  const src = readFileSync(resolve(REPO_ROOT, "scripts", "check.ts"), "utf-8");
  return [...src.matchAll(/script:\s*["'`](check-[a-z0-9-]+)["'`]/g)].map((m) => m[1]!);
}

interface Result {
  script: string;
  passed: boolean;
  discloses: boolean;
  firstLine: string;
}

function run(script: string): Result | null {
  const r = spawnSync("npx", ["tsx", resolve(REPO_ROOT, "scripts", `${script}.ts`)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 180_000,
  });
  if (r.error != null) return null;
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const passed = r.status === 0;
  // Only the PASSING output is in scope. A failing gate is `check-gates-
  // effective`'s surface, and its failure text is governed by the repair
  // contract instead.
  if (!passed) return { script, passed, discloses: false, firstLine: "(gate not passing)" };
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("▸"));
  return {
    script,
    passed,
    discloses: hasApertureDisclosure(output).ok,
    firstLine: lines.find((l) => l.includes("✓")) ?? lines[lines.length - 1] ?? "",
  };
}

function main(): void {
  const scripts = gateScripts();
  console.log(`measure-gate-aperture — ${scripts.length} gate(s) from scripts/check.ts\n`);

  const results: Result[] = [];
  for (const script of scripts) {
    const r = run(script);
    if (r != null) results.push(r);
  }

  const passing = results.filter((r) => r.passed);
  const disclosing = passing.filter((r) => r.discloses);
  const silent = passing.filter((r) => !r.discloses);
  const notPassing = results.filter((r) => !r.passed);

  if (passing.length === 0) {
    console.log(
      `MEASURED NOTHING — no gate ran to a passing state, so no conclusion about\n` +
        `aperture disclosure follows. Check that \`pnpm check\` is green first.`,
    );
    process.exit(0);
  }

  const pct = ((disclosing.length / passing.length) * 100).toFixed(0);
  console.log(
    `${disclosing.length}/${passing.length} passing gate(s) state their aperture (${pct}%)\n`,
  );

  if (VERBOSE) {
    for (const r of disclosing)
      console.log(`  ✓ ${r.script.padEnd(44)} ${r.firstLine.slice(0, 90)}`);
    console.log("");
  }

  if (silent.length > 0) {
    console.log(`${silent.length} gate(s) pass without stating what they examined:\n`);
    for (const r of silent) {
      console.log(`  ${r.script.padEnd(44)} ${r.firstLine.slice(0, 88)}`);
    }
    console.log(
      `\n  → Not automatically a defect: a gate validating a SINGLE manifest has no\n` +
        `    meaningful count, and a number there would be noise. But for any gate that\n` +
        `    walks a candidate set, silence is the failure mode that hid #545 — a narrow\n` +
        `    aperture never goes red, so nothing prompts anyone to check it.\n` +
        `    Ask of each: what fraction of the candidate set does this actually see?`,
    );
  }

  if (notPassing.length > 0) {
    console.log(
      `\n${notPassing.length} gate(s) were not in a passing state and were skipped: ` +
        `${notPassing.map((r) => r.script).join(", ")}`,
    );
  }
}

const invokedDirectly =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

export { gateScripts };
