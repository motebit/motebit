#!/usr/bin/env tsx
/**
 * `check-money-authority` — structural lock for the standing-authority
 * invariant: MEMORY NEVER CONFERS AUTHORITY.
 *
 * Doctrine: `docs/doctrine/memory-never-confers-authority.md`. Shape:
 * ordered source-marker scan, same family as `check-affordance-routing`.
 *
 * Three assertions:
 *
 *   1. **The gate step exists and is ordered.** `policy-gate.ts`
 *      contains the R4 standing-authority block (`profile.risk >=
 *      RiskLevel.R4_MONEY` + `ctx.verifiedGrant == null` →
 *      `needsApproval = true`) AFTER the caller-trust-level switch —
 *      ordering is load-bearing: the invariant must subordinate the
 *      Trusted bypass, so it must run after every approval-lowering
 *      adjustment. A refactor that moves the trust switch below the
 *      grant check silently re-opens "Trusted caller auto-executes
 *      money."
 *
 *   2. **`delegate_to_agent` declares its risk explicitly.** The
 *      registration in `interactive-delegation.ts` carries a
 *      `riskHint` — without one, the name/description patterns
 *      classify the money-capable delegation tool R0_READ (the exact
 *      hole the 2026-06-10 audit found) and it auto-executes as
 *      read-class.
 *
 *   3. **One producer.** No file outside the audited producer
 *      (`packages/runtime/src/grant-verifier.ts`) and test fixtures may
 *      CONSTRUCT a `verifiedGrant` object value. Pass-through
 *      threading (`verifiedGrant: options?.verifiedGrant` and the
 *      `ctx` spread) is permitted; minting the object literal anywhere
 *      else is an unverified authority claim.
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
  console.error(`check-money-authority: ${message}`);
  failed = true;
}

// === 1. Gate step present + ordered after the trust-level switch =====
{
  const source = readFile("packages/policy/src/policy-gate.ts");
  if (source === null) {
    fail("could not read packages/policy/src/policy-gate.ts");
  } else {
    const trustSwitchIdx = source.indexOf("ctx.callerTrustLevel");
    const grantCheckIdx = source.search(
      /profile\.risk >= RiskLevel\.R4_MONEY && !needsApproval && ctx\.verifiedGrant == null/,
    );
    if (grantCheckIdx === -1) {
      fail(
        "policy-gate.ts is missing the R4 standing-authority block " +
          "(`profile.risk >= RiskLevel.R4_MONEY && !needsApproval && ctx.verifiedGrant == null`). " +
          "An R4_MONEY tool call must never auto-execute without a verified grant — " +
          "docs/doctrine/memory-never-confers-authority.md.",
      );
    } else if (trustSwitchIdx === -1) {
      fail(
        "policy-gate.ts no longer references ctx.callerTrustLevel — the ordering assertion " +
          "(grant check AFTER the trust switch) can't be validated; update this gate alongside the refactor.",
      );
    } else if (grantCheckIdx < trustSwitchIdx) {
      fail(
        "the R4 standing-authority block runs BEFORE the caller-trust-level switch. " +
          "Ordering is load-bearing: the invariant must subordinate the Trusted bypass, " +
          "so it must run after every approval-lowering adjustment.",
      );
    }
  }
}

// === 2. delegate_to_agent declares an explicit riskHint ==============
{
  const source = readFile("packages/runtime/src/interactive-delegation.ts");
  if (source === null) {
    fail("could not read packages/runtime/src/interactive-delegation.ts");
  } else {
    const regIdx = source.indexOf("name: TOOL_NAME");
    const hintIdx = source.indexOf("riskHint:");
    if (regIdx === -1 || hintIdx === -1) {
      fail(
        "the delegate_to_agent registration in interactive-delegation.ts carries no explicit " +
          "`riskHint`. Without one, the risk-model patterns classify the money-capable " +
          "delegation tool R0_READ and it auto-executes as read-class.",
      );
    } else if (!/RiskLevel\.R4_MONEY/.test(source)) {
      fail(
        "interactive-delegation.ts's riskHint never references RiskLevel.R4_MONEY — a paid " +
          "delegation (payment rail configured) settles real money and must classify R4.",
      );
    }
  }
}

// === 3. One producer — no constructed verifiedGrant elsewhere ========
{
  const PRODUCER = "packages/runtime/src/grant-verifier.ts";
  const violations: string[] = [];
  for (const srcDir of workspaceSrcDirs()) {
    for (const rel of walkTsFiles(srcDir)) {
      if (rel === PRODUCER) continue;
      if (rel.includes("__tests__") || rel.endsWith(".test.ts")) continue;
      const content = readFile(rel);
      if (content === null) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        // A CONSTRUCTED grant value: `verifiedGrant: {` (object literal).
        // Pass-through threading (`verifiedGrant: options?.verifiedGrant`,
        // `verifiedGrant: x.verifiedGrant`) is permitted.
        if (/verifiedGrant\s*:\s*\{/.test(lines[i] as string)) {
          violations.push(`${rel}:${i + 1}`);
        }
      }
    }
  }
  if (violations.length > 0) {
    fail(
      "verifiedGrant object constructed outside the audited producer " +
        `(${PRODUCER}):\n` +
        violations.map((v) => `  - ${v}`).join("\n") +
        "\nOnly verifyGrantForTurn may mint the value — a constructed grant is an " +
        "unverified authority claim. docs/doctrine/memory-never-confers-authority.md.",
    );
  }
}

if (failed) {
  process.exit(1);
}
console.log(
  "✓ check-money-authority: R4 standing-authority block present + ordered after the trust switch; delegate_to_agent declares explicit riskHint (R4 on payment rail); verifiedGrant has a single audited producer.",
);
