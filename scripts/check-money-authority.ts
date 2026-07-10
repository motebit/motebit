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

// === 4. The deterministic granted-spend path re-composes the R4 AND =====
// `MotebitRuntime.executeGrantedDelegation` is the human-absent money path
// (the Clerk archetype). It inherits ONLY the rail-seam meter — which
// fail-OPENS on a null grant (money-meter.ts) — so it MUST re-add the layers
// the AI loop composes: fail-CLOSED grant verification, a scope check, and a
// meter-wrapped builder (never the raw wallet method). This assertion locks
// all three so a refactor cannot quietly turn the sharpest money path into a
// bypass. Doctrine: docs/doctrine/agent-archetypes.md §6.
{
  const source = readFile("packages/runtime/src/motebit-runtime.ts");
  if (source === null) {
    fail("could not read packages/runtime/src/motebit-runtime.ts");
  } else {
    const startIdx = source.indexOf("async executeGrantedDelegation(");
    if (startIdx === -1) {
      fail(
        "motebit-runtime.ts no longer defines `executeGrantedDelegation` — the deterministic " +
          "granted-spend path. If it was renamed, update this gate to match; if removed, remove " +
          "the Clerk archetype's spend seam too. docs/doctrine/agent-archetypes.md §6.",
      );
    } else {
      // Bound the scan to the method body — the next 2-space-indented method
      // boundary after the signature (arrow callbacks inside are deeper-indented,
      // so `\n  name(` matches only a sibling method). Robust to reordering: a
      // fixed-anchor slice could run to EOF and wrongly count another method's
      // raw wallet reference.
      const afterSig = startIdx + "async executeGrantedDelegation(".length;
      const rel = source.slice(afterSig).search(/\n {2}[A-Za-z_$][\w$]*\(/);
      const body =
        rel === -1
          ? source.slice(startIdx, startIdx + 12000)
          : source.slice(startIdx, afterSig + rel);
      const requirements: Array<{ re: RegExp; miss: string }> = [
        {
          re: /const presentedGrant = await verifyGrantForTurn\(/,
          miss: "must verify the grant via the sole producer verifyGrantForTurn",
        },
        {
          re: /if \(presentedGrant == null\) return \{ ok: false, code: "requires_verified_grant" \}/,
          miss: 'must FAIL CLOSED on a null grant (`return { ok: false, code: "requires_verified_grant" }`) — the meter fail-opens on null, so this path cannot',
        },
        {
          re: /this\.policy\.validate\(/,
          miss: "must re-run the policy gate's scope check via this.policy.validate (the meter never checks scope)",
        },
        {
          re: /return \{ ok: false, code: "missing_scope" \}/,
          miss: 'must refuse an out-of-scope grant (`return { ok: false, code: "missing_scope" }`)',
        },
        {
          re: /const buildP2pPayment = wrapP2pPaymentWithMeter\(/,
          miss: "must route the live broadcast through a meter-wrapped builder (wrapP2pPaymentWithMeter), never the raw wallet method",
        },
      ];
      for (const { re, miss } of requirements) {
        if (!re.test(body)) {
          fail(
            `executeGrantedDelegation ${miss}. This is the human-absent R4 path; dropping any ` +
              "layer of the gate ∧ presence ∧ meter AND is a money-safety regression. " +
              "docs/doctrine/agent-archetypes.md §6, docs/doctrine/memory-never-confers-authority.md.",
          );
        }
      }
      // The raw wallet method may appear ONLY as the first argument of the
      // meter wrapper (bound into rawBuild). Any other pass-through of
      // `_solanaWallet.buildP2pPayment` in this method would bypass metering.
      const rawRefs = (body.match(/_solanaWallet\??\.buildP2pPayment/g) ?? []).length;
      if (rawRefs > 1) {
        fail(
          "executeGrantedDelegation references the raw `_solanaWallet.buildP2pPayment` more than " +
            "once — the only sanctioned use is binding it INTO wrapP2pPaymentWithMeter. A second " +
            "reference risks a metering bypass. check-ceiling-from-grant is the sibling guard.",
        );
      }
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log(
  "✓ check-money-authority: R4 standing-authority block present + ordered after the trust switch; " +
    "delegate_to_agent declares explicit riskHint (R4 on payment rail); verifiedGrant has a single " +
    "audited producer; executeGrantedDelegation re-composes the R4 AND (fail-closed verify + scope + meter-wrapped builder).",
);
