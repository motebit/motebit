#!/usr/bin/env tsx
/**
 * `check-home-seed-basis` — "the seed cannot lie", enforced.
 *
 * The slab home register's resting body is a DERIVED capability-seed
 * (`docs/doctrine/motebit-computer.md` §home: "Derive the seed; never
 * author it … so the N=0 surface cannot lie about what the motebit can
 * do — a mirror, not a brochure"). This gate locks the derivation's
 * honesty at four seams:
 *
 *   1. CLOSED REGISTRY — `HOME_CONFIG_KEYS` in
 *      `apps/web/src/ui/slab-home-model.ts` must agree exactly with this
 *      gate's reference (the check-settlement-mode-canonical shape,
 *      registry-pattern-canonical.md — deliberately NOT the eight-artifact
 *      treatment: this is a per-surface UI config vocabulary, not protocol
 *      wire vocabulary).
 *
 *   2. LIVE-ACCESSOR COUPLING — the assembly site
 *      (`apps/web/src/web-app.ts` `buildHomeSeedInputs`) must answer each
 *      key from its named live runtime accessor (the check-money-authority
 *      textual-anchor style). A key answered by a constant, a cached
 *      boolean, or a hand-authored bit is the claimed-vs-enforced hazard
 *      this repo gates against.
 *
 *   3. RECEDE TESTS — each key carries a `recede: <key>` test (wired ⇒ its
 *      affordance recedes structurally). A config axis without a recede
 *      test can silently become a nag (setup chip that survives wiring) or
 *      a lie (launchpad that survives unwiring).
 *
 *   4. NO STRAY PRODUCERS — `deriveHomeSeed` is the only `HomeTile`
 *      producer: no `basis:` object literals outside the model and its
 *      tests (tests excluded, like check-eval-kind-canonical — fixtures
 *      legitimately construct shapes).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const MODEL = "apps/web/src/ui/slab-home-model.ts";
const ASSEMBLY = "apps/web/src/web-app.ts";
const RECEDE_TESTS = "apps/web/src/ui/__tests__/slab-home-model.test.ts";

/** Mirror of HOME_CONFIG_KEYS — the closed reference this gate defends. */
const HOME_CONFIG_KEYS_REFERENCE = ["mind", "relay", "computer"] as const;

/**
 * The live accessor each key MUST be answered from at the assembly site.
 * These anchors are the honesty coupling: `mind` is real iff the loop
 * deps are wired; `relay` iff the sync status says connected NOW;
 * `computer` iff the env-gated registration exists.
 */
const LIVE_ACCESSOR_ANCHORS: Record<(typeof HOME_CONFIG_KEYS_REFERENCE)[number], RegExp> = {
  mind: /mind:\s*this\.runtime\?\.isAIReady/,
  relay: /relay:\s*this\._syncStatus\s*===\s*"connected"/,
  computer: /computer:\s*this\.computerRegistration\s*!=\s*null/,
};

function read(path: string): string {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    console.error(`check-home-seed-basis: cannot read ${path}.`);
    console.error(
      "Fix: the home-seed honesty surface is apps/web/src/ui/slab-home-model.ts (registry + derivation), apps/web/src/web-app.ts buildHomeSeedInputs (live-accessor assembly), and the model's recede tests — all three must exist.",
    );
    process.exit(1);
  }
}

function extractQuoted(body: string): string[] {
  const values: string[] = [];
  const pattern = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) values.push(m[1] as string);
  return values;
}

function main(): void {
  console.log(
    "▸ check-home-seed-basis — the derived capability-seed cannot lie: registry lock × live-accessor coupling × recede tests × single-producer scan",
  );
  const violations: string[] = [];

  // === 1. Closed registry lock ===
  const model = read(MODEL);
  const arrMatch = model.match(/HOME_CONFIG_KEYS\s*=\s*\[([^\]]*)\]/);
  const modelKeys = arrMatch ? extractQuoted(arrMatch[1] ?? "") : [];
  if (modelKeys.length === 0) {
    violations.push(`  ${MODEL}: could not parse HOME_CONFIG_KEYS — keep it a literal const array`);
  } else {
    const ref = new Set(HOME_CONFIG_KEYS_REFERENCE);
    const got = new Set(modelKeys);
    for (const k of got)
      if (!ref.has(k as never))
        violations.push(`  registry drift: "${k}" in model but not in the gate reference`);
    for (const k of ref)
      if (!got.has(k))
        violations.push(`  registry drift: "${k}" in the gate reference but not in the model`);
  }

  // === 2. Live-accessor coupling at the assembly site ===
  const assembly = read(ASSEMBLY);
  for (const [key, anchor] of Object.entries(LIVE_ACCESSOR_ANCHORS)) {
    if (!anchor.test(assembly)) {
      violations.push(
        `  ${ASSEMBLY}: config key "${key}" is not answered by its live accessor (expected pattern: ${anchor})`,
      );
    }
  }

  // === 3. Recede tests per key ===
  const tests = read(RECEDE_TESTS);
  for (const key of HOME_CONFIG_KEYS_REFERENCE) {
    if (!tests.includes(`recede: ${key}`)) {
      violations.push(
        `  ${RECEDE_TESTS}: missing the "recede: ${key}" test (wired ⇒ its affordance is structurally absent)`,
      );
    }
  }

  // === 4. Single-producer scan — no HomeTile basis literals outside the model ===
  const files: string[] = [];
  (function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry === "node_modules" ||
        entry === "dist" ||
        entry === ".turbo" ||
        entry === "coverage" ||
        entry === "__tests__"
      )
        continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(full);
    }
  })(join(ROOT, "apps/web/src"));

  const basisLiteral = /basis:\s*\{\s*kind:\s*"(identity|config|audit)"/;
  for (const file of files) {
    if (relative(ROOT, file) === MODEL) continue;
    const src = readFileSync(file, "utf8");
    if (basisLiteral.test(src)) {
      violations.push(
        `  ${relative(ROOT, file)}: constructs a HomeTile basis literal — deriveHomeSeed (${MODEL}) is the only producer`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(`check-home-seed-basis: ${violations.length} violation(s):`);
    for (const v of violations) console.error(v);
    console.error(
      "Fix: the seed derives from live state — adding a config axis means updating HOME_CONFIG_KEYS (model), the gate's HOME_CONFIG_KEYS_REFERENCE + LIVE_ACCESSOR_ANCHORS, the buildHomeSeedInputs live read, and a `recede: <key>` test, all in the same commit. Tiles are minted ONLY by deriveHomeSeed.",
    );
    console.error(
      "Doctrine: docs/doctrine/motebit-computer.md §home (derive the seed; never author it).",
    );
    process.exit(1);
  }

  console.log(
    `✓ check-home-seed-basis: ${HOME_CONFIG_KEYS_REFERENCE.length} config key(s) locked (registry × live accessor × recede test); ${files.length} files scanned, single producer holds.`,
  );
}

main();
