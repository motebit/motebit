/**
 * Panel-controller boundary check.
 *
 * Multi-surface UI panels (Sovereign, Agents, …) have their state-derivation
 * and relay-I/O layer lifted into @motebit/panels controllers; each surface
 * renders DOM or RN from controller state. The Sovereign controller landed
 * 2026-04-19 after three files had carried ~3054 LOC of identical state
 * logic. The Agents controller followed the same day.
 *
 * This gate defends those extractions and future ones. Any surface file
 * under apps/ * /src/ui/ or apps/ * /src/components/ whose name matches a
 * registered panel pattern — /sovereign/i, /agents/i — and contains direct
 * fetches to the relay endpoints that panel canonicalizes must also import
 * from @motebit/panels. Re-implementing the fetch path inline reopens the
 * drift window the extraction closed: desktop/web/mobile could diverge on
 * endpoint shape, response type, or state-transition semantics without any
 * single source of truth to correct against.
 *
 * Exempt: test files (allowed to reach in for assertion), packages/panels
 * itself (the canonical source), and apps/web/src/ui/wallet-balance.ts
 * (Stripe-onramp helper, not part of any panel controller).
 *
 * This is the 33rd synchronization invariant defense.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Scope ─────────────────────────────────────────────────────────────

const APPS = ["admin", "cli", "desktop", "docs", "identity", "mobile", "spatial", "web"];

/**
 * A registered panel family. Each entry maps a file-name pattern to
 * substrings whose presence indicates the file is doing the panel's
 * canonical I/O — relay endpoints for sovereign/agents, runtime API calls
 * for memory. A file that matches the name pattern AND contains any of the
 * signatures must import from `@motebit/panels` — or the gate fails.
 *
 * Each family's name pattern also matches `gated-panels` (the web surface's
 * multi-panel host file, which legitimately hosts sovereign/agents/memory
 * side-by-side). Without that alias, a drift that inlined panel state back
 * into gated-panels.ts would slip through.
 *
 * ⚠ Don't collapse these into one flat list. A sovereign file hitting
 * `/api/v1/agents/{id}/discover` is impossible (wrong shape, wrong intent);
 * collapsing would allow `sovereign-panels.ts` to pass the gate by hitting
 * only the discover endpoint, defeating the point.
 */
interface PanelFamily {
  name: string;
  namePattern: RegExp;
  signatures: ReadonlyArray<string>;
}

const PANEL_FAMILIES: ReadonlyArray<PanelFamily> = [
  {
    name: "sovereign",
    namePattern: /sovereign|gated-panels/i,
    signatures: [
      "/api/v1/agents/", // credentials, balance, succession, sweep-config
      "/api/v1/credentials/", // verify, batch-status, presentation
      // note: "/agent/" alone is too broad (matches /api/v1/agents/); the
      // sovereign-only paths are enough to trip the check on a rogue file.
    ],
  },
  {
    name: "agents",
    namePattern: /agents|gated-panels/i,
    signatures: [
      "/api/v1/agents/discover", // discover endpoint — only canonical hit for the agents panel
    ],
  },
  {
    name: "memory",
    namePattern: /memory|gated-panels/i,
    signatures: [
      // Memory panel canonicalizes around the runtime's memory API calls;
      // the gate scans for these substrings rather than relay endpoints.
      "runtime.memory.exportAll",
      "runtime.memory.deleteMemory",
      "app.listMemories(",
    ],
  },
];

/**
 * The fingerprint of consuming @motebit/panels — any import (default, named,
 * namespace, type-only). If this substring is present anywhere in the file,
 * it's considered a consumer and the gate is satisfied.
 */
const PANELS_IMPORT_SIGNATURE = '"@motebit/panels"';

interface Violation {
  app: string;
  family: string;
  file: string;
  reason: string;
}

function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      out.push(...walkTypeScript(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

function hitsSignature(src: string, family: PanelFamily): boolean {
  return family.signatures.some((sig) => src.includes(sig));
}

function consumesPanelsPackage(src: string): boolean {
  return src.includes(PANELS_IMPORT_SIGNATURE);
}

function scanApp(app: string): Violation[] {
  const violations: Violation[] = [];
  const appDir = join(ROOT, "apps", app);
  try {
    statSync(appDir);
  } catch {
    return violations;
  }

  const scanDirs = [join(appDir, "src", "ui"), join(appDir, "src", "components")];
  const files: string[] = [];
  for (const dir of scanDirs) {
    try {
      statSync(dir);
    } catch {
      continue;
    }
    files.push(...walkTypeScript(dir));
  }

  // A file may match multiple families (gated-panels.ts hosts sovereign +
  // agents + memory). Each family is checked independently; one missing
  // import trips every unsatisfied family.
  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    const hasPanelsImport = consumesPanelsPackage(src);
    for (const family of PANEL_FAMILIES) {
      if (!family.namePattern.test(file.split("/").pop() ?? "")) continue;
      if (!hitsSignature(src, family)) continue;
      if (hasPanelsImport) continue;

      violations.push({
        app,
        family: family.name,
        file: relative(ROOT, file),
        reason:
          `file matches /${family.namePattern.source}/i and hits ${family.name}-panel I/O, ` +
          'but does not import from "@motebit/panels". Route fetching/state through ' +
          `the ${family.name} controller (create${family.name[0]!.toUpperCase()}${family.name.slice(1)}Controller) instead of re-implementing the fetch + state machine.`,
      });
    }
  }

  return violations;
}

/**
 * Remove the old single-family matcher now that the family loop above
 * handles every family per file. Kept as a no-op to avoid a dead export
 * surface while this refactor settles.
 */

function main(): void {
  const violations: Violation[] = [];
  for (const app of APPS) {
    violations.push(...scanApp(app));
  }

  if (violations.length === 0) {
    process.stderr.write(
      `✓ check-panel-controllers: every panel surface (${PANEL_FAMILIES.map((f) => f.name).join(", ")}) routes state through @motebit/panels.\n`,
    );
    return;
  }

  process.stderr.write(
    `\n✗ check-panel-controllers: ${violations.length} surface(s) re-implement panel state instead of consuming @motebit/panels.\n\n`,
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.file}  (app: ${v.app}, family: ${v.family})\n    ${v.reason}\n\n`);
  }
  process.stderr.write(
    `Panel state/fetch was extracted into packages/panels so surfaces cannot drift.\n` +
      `Add the @motebit/panels import and route fetching through the appropriate controller.\n` +
      `See packages/panels/CLAUDE.md.\n`,
  );
  process.exit(1);
}

main();
