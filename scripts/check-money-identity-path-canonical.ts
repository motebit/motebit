#!/usr/bin/env tsx
/**
 * check-money-identity-path-canonical — the money/identity-path registry is
 * canonical and its membership is fail-closed.
 *
 * The registry (`scripts/money-identity-path.ts`) lists the packages that must
 * declare a coverage floor (enforced by `check-coverage-config-present`). This
 * gate guarantees the registry cannot be silently dodged:
 *
 *  1. Self-consistency: every MEMBERSHIP_TRIGGER is itself a registry member
 *     (triggers ⊊ registry), and every registry entry names a real workspace
 *     package (no stale entries).
 *
 *  2. Fail-closed membership (Amendment 2): any package UNDER packages/ whose
 *     DIRECT dependencies (`dependencies` or `peerDependencies` — NEVER
 *     `devDependencies`; a test fixture depending on a money primitive must not
 *     pull the package onto the path) include a MEMBERSHIP_TRIGGER MUST itself be
 *     a registry member. This is what stops "create a new money/attestation
 *     package and forget to register it" — membership derived from the dependency
 *     graph, not from a human remembering. No WAIVERS escape hatch (see the
 *     registry header for why a per-diff waiver list is the same fail-open).
 *
 *     Scoped to packages/ by design: services/ (relay) and apps/ (desktop) are
 *     consumer surfaces under integration-test conventions where a unit-coverage
 *     floor measures the wrong thing — directory is the structural filter.
 *
 *     Amendment-2 membership derivation is UNCONDITIONALLY ENFORCED (#110 closed
 *     2026-06-21). The one real over-fire — @motebit/runtime value-importing
 *     @motebit/wallet-solana (the sovereign-rail adapter boundary) — was removed
 *     by the runtime sovereign-rail refactor (PR #114): default rail construction
 *     routes through the SDK, and runtime consumes the `SovereignWalletRail` port
 *     + `base58Encode` codec from @motebit/protocol. runtime now declares
 *     wallet-solana only as a devDep, so the deps/peerDeps-scoped derivation no
 *     longer flags it — the flip needed no waiver.
 *
 * Usage: tsx scripts/check-money-identity-path-canonical.ts   # exit 1 on violation
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MONEY_IDENTITY_PATH, MEMBERSHIP_TRIGGERS } from "./money-identity-path.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const WORKSPACE_ROOTS = ["packages", "services", "apps"];

interface Pkg {
  name: string;
  /** Workspace root: "packages" | "services" | "apps". */
  root: string;
  /** Direct runtime deps: `dependencies` + `peerDependencies` (NOT devDependencies). */
  directDeps: string[];
}

function discoverPackages(): Pkg[] {
  const out: Pkg[] = [];
  for (const base of WORKSPACE_ROOTS) {
    const absBase = join(REPO_ROOT, base);
    if (!existsSync(absBase)) continue;
    for (const entry of readdirSync(absBase)) {
      const dir = join(absBase, entry);
      if (!statSync(dir).isDirectory()) continue;
      const pj = join(dir, "package.json");
      if (!existsSync(pj)) continue;
      const pkg = JSON.parse(readFileSync(pj, "utf-8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      if (!pkg.name) continue;
      out.push({
        name: pkg.name,
        root: base,
        directDeps: [
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.peerDependencies ?? {}),
        ],
      });
    }
  }
  return out;
}

function main(): void {
  const errors: string[] = [];
  const registry = new Set(MONEY_IDENTITY_PATH.keys());
  const packages = discoverPackages();
  const realNames = new Set(packages.map((p) => p.name));

  // 1a. triggers ⊊ registry
  for (const trigger of MEMBERSHIP_TRIGGERS) {
    if (!registry.has(trigger)) {
      errors.push(
        `trigger ${trigger} is not a registry member (triggers must be a subset of the registry)`,
      );
    }
  }
  // 1b. no stale registry entries
  for (const member of registry) {
    if (!realNames.has(member)) {
      errors.push(
        `registry member ${member} does not name a real workspace package (stale entry?)`,
      );
    }
  }

  // 2. fail-closed membership (Amendment 2): a packages/ package depending on a
  //    trigger (deps/peerDeps) ⇒ must be on the registry. Unconditionally
  //    enforced since #110 removed the lone over-fire (runtime → wallet-solana).
  let checked = 0;
  for (const pkg of packages) {
    if (pkg.root !== "packages") continue; // structural filter: services/apps are consumers
    const hits = pkg.directDeps.filter((d) => MEMBERSHIP_TRIGGERS.has(d));
    if (hits.length === 0) continue;
    checked++;
    if (!registry.has(pkg.name)) {
      errors.push(
        `${pkg.name} has a direct (dependencies/peerDependencies) dependency on money/identity primitive(s) [${hits.join(", ")}] but is NOT a money/identity-path registry member.\n` +
          `      Add it to MONEY_IDENTITY_PATH in scripts/money-identity-path.ts (it handles money/attestation, so it must declare a tier floor).`,
      );
    }
  }

  console.log(
    `check-money-identity-path-canonical — ${registry.size} registry members, ${MEMBERSHIP_TRIGGERS.size} triggers; ` +
      `${checked} packages/ depend on a trigger (membership enforced)\n`,
  );

  if (errors.length === 0) {
    console.log(
      "✓ Registry is self-consistent and every trigger-dependent package is a registry member.",
    );
    return;
  }

  for (const e of errors) console.log(`  ✗ ${e}`);
  console.log(
    "\nFix: the canonical registry is MONEY_IDENTITY_PATH in scripts/money-identity-path.ts.\n" +
      "     • stale entry — remove the member from MONEY_IDENTITY_PATH (it names no real workspace package), or rename it to the real package.\n" +
      "     • missing member — add the trigger-dependent package to MONEY_IDENTITY_PATH (a package that value-imports a MEMBERSHIP_TRIGGER must be a registry member).\n" +
      "     Keep the registry and the trigger set in scripts/money-identity-path.ts in the same edit.",
  );
  process.exit(1);
}

main();
