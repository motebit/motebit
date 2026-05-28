#!/usr/bin/env tsx
/**
 * check-credential-input-autofill — drift defense for "credential input ↔
 * autofill-suppression contract" drift in the HTML surfaces.
 *
 * Surfaced 2026-05-27: visitors with the macOS iCloud Passwords browser
 * extension were hit, on every load/refresh of the live web app, with an
 * "Enable Password AutoFill" prompt anchored dead-center over the creature's
 * face. Root cause: the operator-PIN field (`#pin-input`, `type="password"`)
 * lived in a centered overlay (`#pin-backdrop`) hidden only with `opacity:0`,
 * so the password field stayed laid out at viewport center even when closed —
 * and it carried none of the autofill-suppression attributes. iCloud Passwords
 * scanned the DOM, found a real password field with a layout box at center, and
 * anchored its onboarding bubble there.
 *
 * The chat composer (`#chat-input`) already carried the canonical suppression
 * contract — `autocomplete="off"`, `data-1p-ignore`, `data-lpignore` — but the
 * ~12 credential fields (operator PIN, BYOK API keys, restore recovery seed)
 * had silently drifted away from it. Classic synchronization-invariant shape:
 * canonical pattern on one element, siblings drifted, no enforcement.
 *
 * What this probe enforces:
 *
 *   Every `<input … type="password" …>` in a non-dist `*.html` under `apps/`
 *   carries ALL of:
 *     - `autocomplete="off"` (or `autocomplete="new-password"`)
 *     - `data-1p-ignore`      (1Password)
 *     - `data-lpignore`       (LastPass / generic)
 *
 * These secrets (a local numeric operator PIN, BYOK provider keys, a recovery
 * seed) are never website logins; a password manager should neither offer to
 * save them as a motebit.com credential nor anchor an AutoFill prompt to them.
 *
 * The companion layout invariant — credential overlays must hide via
 * `visibility:hidden` / `display:none`, never `opacity:0` alone, so closed
 * fields leave the layout + autofill tree — is documented at each overlay's CSS
 * site (`#pin-backdrop`, `#restore-backdrop`, `#settings-modal`). It is not
 * mechanically gated here: it requires CSS cascade analysis, and the attribute
 * contract below already neutralizes the autofill surface defense-in-depth.
 *
 * Out of scope: password inputs created at runtime via `document.createElement`
 * (no static tag to scan). If a future incident demands it, this script is the
 * natural home — the runtime sites would assert the same three properties.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".next",
  ".turbo",
  ".motebit",
]);

interface Finding {
  readonly file: string;
  readonly tag: string;
  readonly missing: string[];
}

function findFiles(dir: string, predicate: (p: string) => boolean): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (predicate(full)) out.push(full);
    }
  }
  walk(dir);
  return out;
}

/** True iff the input tag declares it should not be autofilled/saved. */
function hasAutocompleteOff(tag: string): boolean {
  return /autocomplete\s*=\s*"(off|new-password)"/.test(tag);
}

function scanHtml(file: string): Finding[] {
  const text = fs.readFileSync(file, "utf8");
  const rel = file.replace(REPO_ROOT + "/", "");
  const findings: Finding[] = [];

  // `[^>]` matches newlines too, so this captures multi-line <input …> tags.
  // Input attribute values never contain a literal `>`, so this is safe.
  for (const m of text.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    if (!/type\s*=\s*"password"/.test(tag)) continue;

    const missing: string[] = [];
    if (!hasAutocompleteOff(tag)) missing.push('autocomplete="off"');
    if (!/\bdata-1p-ignore\b/.test(tag)) missing.push("data-1p-ignore");
    if (!/\bdata-lpignore\b/.test(tag)) missing.push("data-lpignore");

    if (missing.length > 0) {
      // Collapse whitespace so the reported tag is a single readable line.
      findings.push({ file: rel, tag: tag.replace(/\s+/g, " ").trim(), missing });
    }
  }

  return findings;
}

function main(): void {
  const htmlFiles = findFiles(path.join(REPO_ROOT, "apps"), (p) => p.endsWith(".html"));

  const allFindings: Finding[] = [];
  let passwordInputCount = 0;
  for (const file of htmlFiles) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/<input\b[^>]*>/g)) {
      if (/type\s*=\s*"password"/.test(m[0])) passwordInputCount++;
    }
    allFindings.push(...scanHtml(file));
  }

  console.log(
    '▸ check-credential-input-autofill — drift defense against credential inputs that drop the autofill-suppression contract (`autocomplete="off"` + `data-1p-ignore` + `data-lpignore`). Surfaced 2026-05-27 when a centered, opacity-hidden operator-PIN field made iCloud Passwords anchor an "Enable AutoFill" prompt over the creature\'s face. Scans every non-dist `apps/**/*.html` and asserts each `type="password"` input carries all three attributes.',
  );

  if (allFindings.length === 0) {
    console.log(
      `✓ check-credential-input-autofill: ${htmlFiles.length} HTML file(s) scanned; all ${passwordInputCount} password input(s) carry the autofill-suppression contract.`,
    );
    return;
  }

  console.log(
    `✗ check-credential-input-autofill: ${allFindings.length} credential input(s) missing suppression:\n`,
  );
  for (const f of allFindings) {
    console.log(`  ${f.file}`);
    console.log(`    missing ${f.missing.join(", ")}`);
    console.log(`    ${f.tag}\n`);
  }
  console.log(
    'Fix: add `autocomplete="off" data-1p-ignore data-lpignore="true"` to the input — mirror the `#chat-input` element. These secrets are never website logins; password managers must not anchor to them or offer to save them.',
  );
  process.exit(1);
}

main();
