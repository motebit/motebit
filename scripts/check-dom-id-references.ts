#!/usr/bin/env tsx
/**
 * check-dom-id-references — drift defense for surface app HTML / TS pairs.
 *
 * Every surface app (apps/desktop, apps/web, apps/inspector, apps/operator) renders DOM from
 * TypeScript that queries elements declared in `index.html` — the classic
 * `document.getElementById("foo")` lookup paired with an `<div id="foo">`
 * somewhere in the markup. The pair has no compiler enforcement: TS sees
 * the string literal as a string, not a DOM identity claim. When the two
 * drift — a TS rename that misses the HTML, an HTML id typo, a
 * copy-paste from another app's markup — the mismatch is a `null`
 * returned at runtime from `getElementById`, and whatever code chained
 * off it explodes mid-init.
 *
 * The specific incident that motivated this gate:
 *
 *   Commit 6f682fcd (2026-03-17) shipped "Key rotation UI across all
 *   surfaces." Desktop's `settings.ts` queried `rotate-key-reason`,
 *   `rotate-key-error`, `rotate-key-result`, `rotate-key-cancel`,
 *   `rotate-key-confirm` — but the same commit wrote `rotate-reason`,
 *   `rotate-error`, `rotate-result`, `rotate-cancel-btn`,
 *   `rotate-confirm-btn` into `index.html`. Five id mismatches, zero
 *   compiler errors, zero tests exercising `initSettings()`. The
 *   crash sat dormant for 37 days until an unrelated fix (the Buffer
 *   polyfill drift, 2026-04-23) allowed execution to reach the
 *   rotate-key block — at which point the null-addEventListener threw
 *   and killed the entire render bootstrap before `app.init(canvas)`.
 *
 * What this probe enforces:
 *
 *   Every `document.getElementById("<literal>")` and
 *   `document.querySelector("#<literal>")` call in every surface app's
 *   TS sources must resolve against an id declared in either:
 *     - the same app's `index.html` via `id="..."` or `id='...'`, OR
 *     - the same app's TS source via `.id = "..."` or
 *       `setAttribute("id", "...")` (dynamically-created elements).
 *
 *   Non-literal arguments (variables, template literals with
 *   interpolations) are skipped — not statically analyzable. Tests
 *   under `__tests__` are skipped — they construct test DOM.
 *
 *   A `scripts/check-dom-id-references.allow.json` escape hatch accepts
 *   a `{ appDir: { id: "reason" } }` allowlist for genuinely dynamic
 *   cases the regex can't see and for intentional-residual TS-only
 *   lookups after an element was removed with null-guard contracts.
 *   Each entry MUST carry a reason string so waivers self-document in
 *   CI output.
 *
 * This is the thirty-eighth synchronization invariant defense.
 *
 * Usage:
 *   tsx scripts/check-dom-id-references.ts        # exit 1 on drift
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Apps whose TS ↔ HTML pairs are in scope. Native surfaces (mobile RN,
// spatial canvas-primary) have no index.html and no getElementById
// lookups to validate. Docs surface is Next.js-rendered — its DOM
// comes from React components, not static markup.
const APPS_WITH_HTML: readonly string[] = [
  "apps/desktop",
  "apps/web",
  "apps/inspector",
  "apps/operator",
];

const ALLOWLIST_PATH = join(ROOT, "scripts", "check-dom-id-references.allow.json");

const SKIP_SRC_DIRS = new Set(["__tests__", "dist", "node_modules", ".turbo", "coverage"]);

interface Finding {
  loc: string;
  message: string;
}

interface IdRef {
  file: string;
  line: number;
  id: string;
  kind: "getElementById" | "querySelector";
}

// ── Source discovery ──────────────────────────────────────────────────

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_SRC_DIRS.has(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out;
}

// ── HTML id extraction ────────────────────────────────────────────────

const HTML_ID_RE = /\bid\s*=\s*["']([^"']+)["']/g;

function collectHtmlIds(htmlPath: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(htmlPath)) return ids;
  const src = readFileSync(htmlPath, "utf-8");
  let m: RegExpExecArray | null;
  while ((m = HTML_ID_RE.exec(src)) !== null) {
    ids.add(m[1]!);
  }
  return ids;
}

// ── TS id-assignment extraction ───────────────────────────────────────

// Three patterns count as "declared" when found in TS source:
//
//   elem.id = "foo"                          — direct property assignment
//   elem.setAttribute("id", "foo")           — attribute setter
//   innerHTML = `<div id="foo">...`          — template-string HTML
//
// The third catches ids created inside `innerHTML`/`insertAdjacentHTML`/
// `outerHTML` string construction, which is common in surface apps that
// build dynamic chrome (billing buttons, confirm dialogs, popovers). The
// regex reuses the HTML id attribute pattern and just lets it loose on
// the TS source — any `id="..."` substring, regardless of whether it's
// inside a template literal or a plain string, counts.
//
// Dynamic / computed ids (template literals with ${expr}, variables)
// are skipped by design — not statically analyzable.
const TS_ID_ASSIGN_RE = /\.id\s*=\s*["']([^"']+)["']/g;
const TS_SET_ATTR_ID_RE = /\.setAttribute\s*\(\s*["']id["']\s*,\s*["']([^"']+)["']\s*\)/g;
const TS_INNER_HTML_ID_RE = /\bid\s*=\s*["']([^"'${}]+)["']/g;

function collectTsDeclaredIds(files: string[]): Set<string> {
  const ids = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, "utf-8");
    let m: RegExpExecArray | null;
    TS_ID_ASSIGN_RE.lastIndex = 0;
    while ((m = TS_ID_ASSIGN_RE.exec(src)) !== null) {
      ids.add(m[1]!);
    }
    TS_SET_ATTR_ID_RE.lastIndex = 0;
    while ((m = TS_SET_ATTR_ID_RE.exec(src)) !== null) {
      ids.add(m[1]!);
    }
    TS_INNER_HTML_ID_RE.lastIndex = 0;
    while ((m = TS_INNER_HTML_ID_RE.exec(src)) !== null) {
      ids.add(m[1]!);
    }
  }
  return ids;
}

// ── TS id-lookup extraction ───────────────────────────────────────────

// getElementById("literal") — the primary drift surface. The regex
// requires a string-literal argument; variable arguments are skipped
// (can't statically resolve).
const TS_GET_BY_ID_RE = /\bgetElementById\s*\(\s*["']([^"']+)["']\s*\)/g;

// querySelector("#literal") — only the simple "#id" selector form, no
// compound selectors. This is the drift surface for querySelector, but
// compound selectors (".class > #id", "#id.active") are intentionally
// ignored — they're harder to validate and drift there is rarer.
const TS_QS_SHARP_RE = /\bquerySelector\s*\(\s*["']#([a-zA-Z][\w-]*)["']\s*\)/g;

function collectTsLookups(files: string[]): IdRef[] {
  const refs: IdRef[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf-8");
    const lines = src.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      TS_GET_BY_ID_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TS_GET_BY_ID_RE.exec(line)) !== null) {
        refs.push({ file: f, line: i + 1, id: m[1]!, kind: "getElementById" });
      }

      TS_QS_SHARP_RE.lastIndex = 0;
      while ((m = TS_QS_SHARP_RE.exec(line)) !== null) {
        refs.push({ file: f, line: i + 1, id: m[1]!, kind: "querySelector" });
      }
    }
  }
  return refs;
}

// ── Allowlist ─────────────────────────────────────────────────────────

interface Allowlist {
  [appDir: string]: { [id: string]: string };
}

/**
 * Parse `scripts/check-dom-id-references.allow.json` into a structured
 * allowlist. Shape: `{ appDir: { id: "reason" } }` — each waiver entry
 * carries a reason string so waivers are self-documenting when the
 * gate prints its summary. An empty reason is rejected at load time,
 * not silently accepted — waivers without a reason rot faster than
 * the gate can catch them.
 */
function loadAllowlist(): Allowlist {
  if (!existsSync(ALLOWLIST_PATH)) return {};
  try {
    const raw = readFileSync(ALLOWLIST_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("allowlist root must be an object");
    }
    for (const [appDir, waivers] of Object.entries(parsed)) {
      if (waivers == null || typeof waivers !== "object" || Array.isArray(waivers)) {
        throw new Error(`allowlist["${appDir}"] must be an object of { id: reason }`);
      }
      for (const [id, reason] of Object.entries(waivers as Record<string, unknown>)) {
        if (typeof reason !== "string" || reason.trim() === "") {
          throw new Error(
            `allowlist["${appDir}"]["${id}"] must be a non-empty reason string ` +
              `— waivers without a reason rot faster than the gate can catch them`,
          );
        }
      }
    }
    return parsed as Allowlist;
  } catch (err) {
    process.stderr.write(`error: malformed ${relative(ROOT, ALLOWLIST_PATH)}: ${String(err)}\n`);
    process.exit(2);
  }
}

// ── Main ──────────────────────────────────────────────────────────────

function main(): void {
  const allowlist = loadAllowlist();
  const findings: Finding[] = [];
  let scannedApps = 0;
  let scannedRefs = 0;

  for (const appDir of APPS_WITH_HTML) {
    const appPath = join(ROOT, appDir);
    const htmlPath = join(appPath, "index.html");
    const srcPath = join(appPath, "src");

    if (!existsSync(htmlPath)) continue;
    if (!existsSync(srcPath) || !statSync(srcPath).isDirectory()) continue;

    scannedApps++;
    const htmlIds = collectHtmlIds(htmlPath);
    const tsFiles = walkTsFiles(srcPath);
    const tsAssignedIds = collectTsDeclaredIds(tsFiles);
    const waivers = allowlist[appDir] ?? {};
    const allowedIds = new Set(Object.keys(waivers));

    const declared = new Set<string>([...htmlIds, ...tsAssignedIds, ...allowedIds]);
    const refs = collectTsLookups(tsFiles);
    scannedRefs += refs.length;

    for (const ref of refs) {
      if (!declared.has(ref.id)) {
        findings.push({
          loc: `${relative(ROOT, ref.file)}:${ref.line}`,
          message:
            `${ref.kind}("${ref.id}") in ${appDir} has no matching id. ` +
            `Expected an \`id="${ref.id}"\` attribute in ${appDir}/index.html, ` +
            `or a \`.id = "${ref.id}"\` / \`setAttribute("id", "${ref.id}")\` ` +
            `assignment in ${appDir}/src. If the id is constructed dynamically ` +
            `in a way this probe can't see, add it to ` +
            `scripts/check-dom-id-references.allow.json under "${appDir}".`,
        });
      }
    }
  }

  if (findings.length === 0) {
    process.stderr.write(
      `✓ check-dom-id-references: ${scannedRefs} lookup(s) across ${scannedApps} app(s) all resolve.\n`,
    );
    return;
  }

  process.stderr.write(`\n✗ check-dom-id-references: ${findings.length} drift(s) detected.\n\n`);
  for (const f of findings) {
    process.stderr.write(`  ${f.loc}\n    ${f.message}\n\n`);
  }
  process.exit(1);
}

main();
