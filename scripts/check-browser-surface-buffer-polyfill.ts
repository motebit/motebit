#!/usr/bin/env tsx
/**
 * check-browser-surface-buffer-polyfill — invariant #129.
 *
 * Every Vite browser surface that reaches the Solana wallet stack
 * (`@motebit/wallet-solana` → `@solana/web3.js` + `@solana/spl-token`) MUST
 * carry the Buffer polyfill. Those libraries reference Node's `Buffer` global at
 * module-eval time; without the polyfill the wallet import throws
 * `Buffer is not defined` at load, kills the module graph, and the surface boots
 * to a blank canvas in the browser — dev AND production.
 *
 * The drift this prevents was real and silent: apps/web and apps/desktop both
 * shipped the three-part polyfill; apps/spatial reached the same Solana graph but
 * shipped NONE of it, so spatial crashed at load in any browser and nobody
 * noticed (no test loaded it). A textbook sibling-boundary miss
 * (`feedback_engineering_patterns`): fix one boundary, audit all siblings.
 *
 * Trigger: an app with BOTH a `vite.config.ts` (Vite browser surface — excludes
 * the Node CLI and the Metro-bundled mobile app, which polyfill differently) AND
 * `@motebit/wallet-solana` in dependencies. Each such app must have all three
 * parts (the canonical shape, from apps/web + apps/desktop):
 *   1. `buffer` in package.json dependencies (the npm polyfill package).
 *   2. vite.config.ts: `define: { global: "globalThis" }` + a `buffer:` resolve
 *      alias (so Rollup bundles the polyfill instead of externalizing it).
 *   3. a runtime `globalThis.Buffer = Buffer` assignment in src/ (imported first,
 *      before any Solana-touching module).
 *
 * Synchronization-invariant defense; see docs/drift-defenses.md.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { failWithRepair } from "./lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const APPS = join(ROOT, "apps");

function read(p: string): string {
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

const BUFFER_ASSIGN = /globalThis\.Buffer\s*=\s*Buffer/;

/**
 * Does the app carry the runtime `globalThis.Buffer = Buffer` assignment? Two
 * canonical placements: web puts it in an inline module script in index.html;
 * desktop + spatial put it in a src/ module imported first. Either satisfies the
 * invariant.
 */
function hasRuntimeAssignment(appDir: string): boolean {
  if (BUFFER_ASSIGN.test(read(join(appDir, "index.html")))) return true;
  return hasSrcAssignment(join(appDir, "src"));
}

/** Recursively scan an app's src/ for the runtime Buffer assignment. */
function hasSrcAssignment(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      if (hasSrcAssignment(full)) return true;
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      if (BUFFER_ASSIGN.test(read(full))) return true;
    }
  }
  return false;
}

interface Finding {
  readonly app: string;
  readonly missing: string[];
}

/**
 * Scan a directory of app folders (real `apps/` or a fixture root) and return
 * one finding per triggered-but-non-compliant surface. Pure of process exit —
 * the caller decides how to report, so the same logic backs both the gate and
 * the fixture round-trip test.
 */
function scan(rootDir: string): Finding[] {
  let appNames: string[] = [];
  try {
    appNames = readdirSync(rootDir).filter((n) => {
      try {
        return statSync(join(rootDir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }

  const findings: Finding[] = [];
  for (const app of appNames) {
    const appDir = join(rootDir, app);
    const viteConfig = join(appDir, "vite.config.ts");
    const pkgPath = join(appDir, "package.json");
    // Trigger: a Vite browser surface (has vite.config.ts) reaching wallet-solana.
    if (!existsSync(viteConfig) || !existsSync(pkgPath)) continue;
    let deps: Record<string, string> = {};
    try {
      deps = (JSON.parse(read(pkgPath)).dependencies ?? {}) as Record<string, string>;
    } catch {
      continue;
    }
    if (!("@motebit/wallet-solana" in deps)) continue;

    const missing: string[] = [];
    if (!("buffer" in deps)) {
      missing.push("the `buffer` npm dependency in package.json");
    }
    const vite = read(viteConfig);
    const hasGlobalDefine = /global:\s*["']globalThis["']/.test(vite);
    const hasBufferAlias = /buffer:\s*resolve\(/.test(vite);
    if (!hasGlobalDefine || !hasBufferAlias) {
      missing.push(
        'the vite.config.ts polyfill block (`define: { global: "globalThis" }` + a `buffer:` resolve alias)',
      );
    }
    if (!hasRuntimeAssignment(appDir)) {
      missing.push(
        "a runtime `globalThis.Buffer = Buffer` assignment (in index.html or a src/ module imported first)",
      );
    }
    if (missing.length > 0) findings.push({ app, missing });
  }
  return findings;
}

// `--fixture` mode: scan the test fixture tree, print machine-readable JSON, and
// always exit 0. Lets the round-trip test assert BOTH axes — that the violation
// fixtures are flagged (the gate bites) AND that each canonical-correct fixture
// is NOT flagged (no false positive — the exact axis the first cut got wrong,
// which `check-gates-effective` does not cover). Mirrors check-affordance-routing.
if (process.argv.includes("--fixture")) {
  const fixtureRoot = resolve(__dirname, "__tests__", "buffer-polyfill-fixture");
  console.log(JSON.stringify({ flagged: scan(fixtureRoot) }));
  process.exit(0);
}

const findings = scan(APPS).map(
  (f) => `apps/${f.app} reaches @motebit/wallet-solana but is missing: ${f.missing.join("; ")}.`,
);

if (findings.length > 0) {
  failWithRepair({
    invariant: `check-browser-surface-buffer-polyfill: ${findings.length} browser surface(s) reach the Solana wallet stack without the Buffer polyfill`,
    canonical:
      "apps/web (vite.config.ts define+alias, index.html Buffer import) + apps/desktop (src/buffer-polyfill.ts imported first in main.ts) — the reference shape",
    fix: 'Add all three parts to the offending app: the `buffer` dep, the vite.config.ts `define: { global: "globalThis" }` + `buffer:` resolve alias (+ optimizeDeps.esbuildOptions.define for dev), and a `globalThis.Buffer = Buffer` module imported as the FIRST side-effect import of the entry. Mirror apps/desktop\'s buffer-polyfill.ts exactly.',
    sites: findings,
    doctrine: "docs/drift-defenses.md #129 (sibling-boundary rule)",
  });
}

console.log(
  `✓ check-browser-surface-buffer-polyfill: every Vite browser surface reaching @motebit/wallet-solana carries the Buffer polyfill.`,
);
