#!/usr/bin/env tsx
/**
 * `check-ceiling-from-grant` — structural lock for spec
 * `standing-delegation-v1.md` §3.3 rule 2: THE ENFORCER'S CEILING COMES
 * ONLY FROM A VERIFIED GRANT — never local config, never a hand-built
 * literal, never model output. The produced-not-authored discipline
 * applied to money; sibling of `check-money-authority` (which locks WHO
 * may mint authority; this locks WHERE the HOW-MUCH may come from).
 *
 * Three assertions:
 *
 *   1. **The sanctioned producer exists.** `packages/policy/src/
 *      grant-blast-radius.ts` exports `spendCeilingFromGrant` (the only
 *      wire→enforcer ceiling mapping) and `evaluateBlastRadius`.
 *
 *   2. **The sanctioned composition uses it.** `packages/runtime/src/
 *      money-meter.ts` (the R4 AND-composition) derives its ceiling via
 *      `spendCeilingFromGrant(` — so every metered spend provably
 *      enforces the DELEGATOR'S signed commitment.
 *
 *   3. **No unsanctioned enforcement call sites.** Outside the enforcer
 *      module itself, the persistent store, the meter, and tests, no
 *      production file may call `evaluateBlastRadius(` or a spend-store
 *      `tryConsume(` — a new consumer must route through
 *      `createMoneyMeter` (or extend the allowlist under review),
 *      because an ad-hoc call site is exactly where a config-sourced or
 *      hand-built ceiling would slip in.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(resolve(ROOT, dir));
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".turbo") continue;
    const rel = join(dir, entry);
    const full = resolve(ROOT, rel);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // broken symlink (e.g. mobile iOS Pods) — skip
    }
    if (st.isDirectory()) {
      out.push(...walkTsFiles(rel));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(rel);
    }
  }
  return out;
}

/** Every `<root>/<pkg>/src` tree under the workspace roots. */
function workspaceSrcDirs(): string[] {
  const dirs: string[] = [];
  for (const root of ["packages", "apps", "services"]) {
    let entries: string[];
    try {
      entries = readdirSync(resolve(ROOT, root));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const srcRel = join(root, entry, "src");
      try {
        if (statSync(resolve(ROOT, srcRel)).isDirectory()) dirs.push(srcRel);
      } catch {
        continue;
      }
    }
  }
  return dirs;
}

let failed = false;
function fail(message: string): void {
  console.error(`check-ceiling-from-grant: ${message}`);
  failed = true;
}

const PRODUCER = "packages/policy/src/grant-blast-radius.ts";
const METER = "packages/runtime/src/money-meter.ts";
const STORE = "packages/persistence/src/index.ts";
/** Files sanctioned to call the enforcer directly (reviewed compositions). */
const ALLOWED_CALLERS = new Set([PRODUCER, METER, STORE]);

// === 1. The sanctioned producer exists ===============================
{
  const source = readFile(PRODUCER);
  if (source === null) {
    fail(`could not read ${PRODUCER} — the sanctioned ceiling producer moved; update this gate`);
  } else {
    if (!source.includes("export function spendCeilingFromGrant")) {
      fail(
        `${PRODUCER} no longer exports spendCeilingFromGrant — the only sanctioned ` +
          `wire→enforcer ceiling mapping (spec/standing-delegation-v1.md §3.3 rule 2). ` +
          `Restore the export or update this gate alongside the doctrine.`,
      );
    }
    if (!source.includes("export function evaluateBlastRadius")) {
      fail(`${PRODUCER} no longer exports evaluateBlastRadius — update this gate if it moved.`);
    }
  }
}

// === 2. The sanctioned composition derives its ceiling from the grant =
{
  const source = readFile(METER);
  if (source === null) {
    fail(`could not read ${METER} — the money meter moved; update this gate`);
  } else if (!source.includes("spendCeilingFromGrant(")) {
    fail(
      `${METER} no longer derives its ceiling via spendCeilingFromGrant( — the meter must ` +
        `take the ceiling from the VERIFIED grant's signed spend_ceiling, never local config ` +
        `(spec/standing-delegation-v1.md §3.3 rule 2). Route the ceiling through ` +
        `spendCeilingFromGrant in packages/policy/src/grant-blast-radius.ts.`,
    );
  }
}

// === 3. No unsanctioned enforcement call sites ========================
{
  const violations: string[] = [];
  for (const srcDir of workspaceSrcDirs()) {
    for (const rel of walkTsFiles(srcDir)) {
      if (rel.includes("__tests__") || rel.endsWith(".test.ts")) continue;
      if (ALLOWED_CALLERS.has(rel)) continue;
      const source = readFile(rel);
      if (source === null) continue;
      const lines = source.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/\bevaluateBlastRadius\s*\(/.test(lines[i]!) || /\.tryConsume\s*\(/.test(lines[i]!)) {
          violations.push(`${rel}:${i + 1}`);
        }
      }
    }
  }
  if (violations.length > 0) {
    fail(
      `unsanctioned blast-radius enforcement call site(s):\n  ${violations.join("\n  ")}\n` +
        `Fix: route autonomous-money metering through createMoneyMeter in ` +
        `packages/runtime/src/money-meter.ts (which derives the ceiling from the verified ` +
        `grant via spendCeilingFromGrant — spec/standing-delegation-v1.md §3.3 rule 2). ` +
        `A genuinely new reviewed composition may be added to ALLOWED_CALLERS in ` +
        `scripts/check-ceiling-from-grant.ts with justification.`,
    );
  }
}

if (failed) {
  process.exit(1);
}
console.log("check-ceiling-from-grant: ceiling provenance invariants hold");
