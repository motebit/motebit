/**
 * Panel-controller boundary check.
 *
 * The Sovereign panel ships on desktop (DOM), web (DOM), and mobile (React
 * Native). The state-derivation and relay-I/O layer — credential dedup,
 * revocation batch-check, sovereign balance resolution, sweep-config state
 * machine, credentials/ledger/budget/succession fetching — was triplicated
 * across three surfaces. In Apr 2026 it was lifted into @motebit/panels as a
 * single controller; each surface now renders DOM or RN from controller state.
 *
 * This gate defends the extraction. Any surface file under apps/* / src/ui/
 * or apps/ * /src/components/ whose name matches /sovereign/i and contains
 * direct fetches to the relay's sovereign endpoints must also import from
 * @motebit/panels. Re-implementing the fetch path inline reopens the same
 * drift window the extraction closed: desktop/web/mobile could diverge on
 * endpoint shape, response type, or sweep-commit micro-conversion without any
 * single source of truth to correct against.
 *
 * Exempt: test files (which are allowed to reach in for assertion),
 * packages/panels itself (the canonical source), and the one Stripe-onramp
 * helper apps/web/src/ui/wallet-balance.ts (not part of the sovereign
 * controller; explicitly named).
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
 * File-name patterns that declare themselves as panel-surface consumers.
 * Matches case-insensitively; a file named `Sovereign.tsx` or
 * `sovereign-panels.ts` or `SovereignPanel.tsx` all qualify.
 */
const PANEL_NAME_PATTERNS: ReadonlyArray<RegExp> = [/sovereign/i];

/**
 * Relay endpoint substrings whose presence in a panel file indicates the
 * file is doing its own sovereign-panel fetching — exactly the work the
 * controller owns. One hit is enough; we don't need to enumerate every path.
 */
const SOVEREIGN_ENDPOINT_SIGNATURES: ReadonlyArray<string> = [
  "/api/v1/agents/", // credentials, balance, succession, sweep-config
  "/agent/", // budget, ledger/{goal_id}
  "/api/v1/credentials/", // verify, batch-status, presentation
];

/**
 * The fingerprint of consuming @motebit/panels — any import (default, named,
 * namespace, type-only). If this substring is present anywhere in the file,
 * it's considered a consumer and the gate is satisfied.
 */
const PANELS_IMPORT_SIGNATURE = '"@motebit/panels"';

interface Violation {
  app: string;
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

function looksLikePanel(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? "";
  return PANEL_NAME_PATTERNS.some((re) => re.test(base));
}

function hitsSovereignEndpoint(src: string): boolean {
  return SOVEREIGN_ENDPOINT_SIGNATURES.some((sig) => src.includes(sig));
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

  for (const file of files) {
    if (!looksLikePanel(file)) continue;
    const src = readFileSync(file, "utf-8");
    if (!hitsSovereignEndpoint(src)) continue;
    if (consumesPanelsPackage(src)) continue;

    violations.push({
      app,
      file: relative(ROOT, file),
      reason:
        "file name matches /sovereign/i and hits relay sovereign endpoints directly, " +
        'but does not import from "@motebit/panels". Route fetching/state through ' +
        "createSovereignController instead of re-implementing the fetch + dedup + sweep " +
        "state machine.",
    });
  }

  return violations;
}

function main(): void {
  const violations: Violation[] = [];
  for (const app of APPS) {
    violations.push(...scanApp(app));
  }

  if (violations.length === 0) {
    process.stderr.write(
      `✓ check-panel-controllers: every sovereign-panel surface routes state through @motebit/panels.\n`,
    );
    return;
  }

  process.stderr.write(
    `\n✗ check-panel-controllers: ${violations.length} surface(s) re-implement sovereign-panel state instead of consuming @motebit/panels.\n\n`,
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.file}  (app: ${v.app})\n    ${v.reason}\n\n`);
  }
  process.stderr.write(
    `The sovereign-panel state layer was extracted into packages/panels so the three surfaces\n` +
      `could not drift. Add \`import { createSovereignController } from "@motebit/panels";\` and route\n` +
      `fetching through the controller. See packages/panels/CLAUDE.md.\n`,
  );
  process.exit(1);
}

main();
