#!/usr/bin/env tsx
/**
 * check-token-mint-canonical — audience-bound auth tokens are minted through
 * the ONE canonical seam, `mintAudienceToken` (@motebit/crypto).
 *
 * `createSignedToken` deliberately fills no defaults, so before the seam
 * existed every mint site restated `iat` / `exp` / `jti` / TTL — 23
 * independent copies of the same security-relevant boilerplate as of
 * 2026-07-23 (grown from ~9 a month earlier; the debt compounded as new
 * services landed). Each copy is a place for the freshness window or the
 * replay nonce to silently drift — the identity→authz link's instance of the
 * shadow-the-constant class (composition-preserves-enforcement: reduce the
 * seams where enforcement can disappear). One seam means one place where
 * `iat`/`exp`/`jti` assembly can be right or wrong.
 *
 * ## Detection
 *
 *   1. Walk non-test .ts sources under `packages/`, `services/`, `apps/`.
 *   2. Flag every `createSignedToken(` CALL outside the owner,
 *      `packages/crypto/src/signing.ts` (the definition plus the helper's
 *      internal call). Import lists and re-export lines don't parenthesize
 *      the name, so they are not flagged.
 *   3. Test files (`__tests__/`, `*.test.ts`) are exempt by design:
 *      adversarial fixtures need exact payload control (expired tokens,
 *      missing `jti`/`aud`, wrong audience) that the canonical seam
 *      structurally refuses to produce.
 *
 * Static text parse — no execution. Known limitation: an aliased import
 * (`import { createSignedToken as x }`) evades the textual match — the same
 * accepted blind spot as the suite's other call-site scans; zero aliased
 * imports exist today and one appearing in review is itself the signal.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { failWithRepair } from "./lib/gate-report.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const SCAN_ROOTS = ["packages", "services", "apps"];

/** The one file allowed to call the raw primitive. */
const OWNER = "packages/crypto/src/signing.ts";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  "build",
  ".next",
  // native app shells — generated trees with dangling symlinks
  "ios",
  "android",
  "Pods",
]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // dangling symlink
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts") &&
      !full.includes("__tests__")
    ) {
      out.push(full);
    }
  }
}

const files: string[] = [];
for (const root of SCAN_ROOTS) {
  walk(resolve(REPO_ROOT, root), files);
}

const violations: string[] = [];
for (const file of files) {
  const rel = relative(REPO_ROOT, file);
  if (rel === OWNER) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("createSignedToken(")) continue;
    // Comments narrating the primitive are not calls.
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    violations.push(`${rel}:${i + 1}  ${line.trim()}`);
  }
}

if (violations.length > 0) {
  failWithRepair({
    invariant:
      `${violations.length} raw createSignedToken call(s) outside the canonical mint seam — ` +
      "each restates iat/exp/jti/TTL, the boilerplate whose per-site drift the seam exists to end",
    canonical: "packages/crypto/src/signing.ts (mintAudienceToken)",
    fix:
      "route the mint through `mintAudienceToken({ mid, did, aud[, ttlMs, nowMs] }, privateKey)` " +
      "(exported from @motebit/crypto and re-exported by @motebit/encryption) and use `.token` " +
      "(and `.payload.exp` if the site surfaces expiry). Raw createSignedToken is for " +
      "adversarial test fixtures only (__tests__ / *.test.ts are exempt).",
    sites: violations,
    doctrine: "docs/doctrine/composition-preserves-enforcement.md (reduce the seams)",
  });
}

console.log(
  `✓ check-token-mint-canonical — ${files.length} source file(s) scanned; ` +
    "every audience-token mint routes through mintAudienceToken",
);
