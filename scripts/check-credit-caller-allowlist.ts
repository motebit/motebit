#!/usr/bin/env tsx
/**
 * check-credit-caller-allowlist — only verified-funding modules may credit a
 * virtual-account balance.
 *
 * The permanent structural lock behind the 2026-07-01 treasury-drain fix. The
 * removed self-declared `POST /deposit` route credited spendable, withdrawable
 * balance from a client-supplied amount — a free-money vector (self-declare
 * balance → auto-settled withdrawal). Deleting the route closed it; this gate
 * makes re-introducing it CI-visible forever: crediting balance from a new,
 * unreviewed call site fails the build.
 *
 * The invariant is not "no route credits from client input" (hard to prove
 * statically) but the enforceable proxy: `creditAccount(...)` /
 * `accountStore.credit(...)` may be called ONLY from the allowlisted modules
 * below — each a verified funding source, a net-zero internal movement, or a
 * grant that is held non-withdrawable. Adding a credit call site therefore
 * requires a deliberate allowlist edit, which forces a reviewer to answer:
 * is this VERIFIED funding, or does the credited balance need a withdrawal
 * hold (the free-credit shape — see `AccountStore.getUnspentGrantHold`)?
 *
 * ## Detection
 *
 *   1. Walk `services/relay/src/**\/*.ts`, excluding `__tests__/`.
 *   2. Flag every `creditAccount(` and `.credit(` CALL outside an allowlisted
 *      file. (`debitSpendable`/`debit` are not matched; the `.credit(`
 *      method-call form matches the raw store call.)
 *   3. Whole-file allow, like check-loops-supervised's owner shape — the
 *      allowlisted modules are legitimately credit-authorized.
 *   4. Exit 1 on any call from a non-allowlisted file.
 *
 * Static text parse — no execution. Doctrine: services/relay/CLAUDE.md
 * (money model, transmitter-surface-zero) + docs/doctrine/off-ramp-as-user-action.md.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { failWithRepair } from "./lib/gate-report.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const RELAY_SRC = resolve(REPO_ROOT, "services", "relay", "src");

/**
 * Modules permitted to credit a virtual-account balance, each with the reason
 * the credit is safe. A new entry is a security decision: the credited balance
 * is either verified funding, a net-zero internal movement, or held from
 * withdrawal.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "accounts.ts",
    reason: "defines the creditAccount wrapper + the SqliteAccountStore shim",
  },
  { file: "account-store-sqlite.ts", reason: "defines the store credit() primitive" },
  { file: "deposit-detector.ts", reason: "onchain USDC deposit — verified by confirmation depth" },
  { file: "stripe-credit.ts", reason: "Stripe checkout — verified by server-side session read" },
  { file: "subscriptions.ts", reason: "Stripe webhook — signature-verified funding" },
  {
    file: "tasks.ts",
    reason: "task settlement — settlement_credit / allocation_release from already-funded balances",
  },
  {
    file: "federation-callbacks.ts",
    reason: "federated settlement_credit from a verified peer forward",
  },
  { file: "index.ts", reason: "allocation_release — net-zero refund of a prior funded hold" },
  {
    file: "free-credit.ts",
    reason:
      "promotional grant — held NON-WITHDRAWABLE by AccountStore.getUnspentGrantHold (inference-only)",
  },
];

const ALLOWED_FILES = new Set(ALLOWLIST.map((a) => a.file));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** A `creditAccount(` or `.credit(` call, ignoring comments and imports. */
function isCreditCall(line: string): boolean {
  const code = line.replace(/\/\/.*$/, "").trim();
  if (code.startsWith("*") || code.startsWith("/*")) return false;
  if (code.startsWith("import ") || code.startsWith("export {")) return false;
  return /\bcreditAccount\s*\(/.test(code) || /\.credit\s*\(/.test(code);
}

function main(): void {
  const violations: string[] = [];

  for (const file of walk(RELAY_SRC)) {
    const base = file.split("/").pop()!;
    if (ALLOWED_FILES.has(base)) continue;
    const rel = relative(REPO_ROOT, file);
    const lines = readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (isCreditCall(lines[i]!)) {
        violations.push(`${rel}:${i + 1} — ${lines[i]!.trim()}`);
      }
    }
  }

  if (violations.length > 0) {
    failWithRepair({
      invariant: `${violations.length} balance-credit call site(s) outside the verified-funding allowlist — a virtual-account balance may only be credited from a verified funding source`,
      sites: violations,
      canonical: "scripts/check-credit-caller-allowlist.ts (ALLOWLIST)",
      fix:
        "If this credit is genuinely safe — verified funding (onchain deposit-detector / " +
        "Stripe), a net-zero internal movement (allocation_release / settlement), or a grant " +
        "held non-withdrawable via AccountStore.getUnspentGrantHold — add the file to ALLOWLIST " +
        "in scripts/check-credit-caller-allowlist.ts with the reason. If the credit is from " +
        "client-supplied input and becomes withdrawable, it is the deleted /deposit " +
        "treasury-drain vector reborn — do not add it.",
      doctrine:
        "services/relay/CLAUDE.md (transmitter-surface-zero) + docs/doctrine/off-ramp-as-user-action.md",
    });
  }

  console.log(
    `check-credit-caller-allowlist: OK — every balance-credit call site is in a verified-funding ` +
      `module (${ALLOWLIST.length} allowlisted).`,
  );
}

main();
