#!/usr/bin/env tsx
/**
 * check-docs-script-claims — every package script a docs page tells the
 * reader to run must exist in the manifest it would run against.
 *
 * Found 2026-09-14 by a docs-vs-code cross-audit (#667): three of the five
 * app pages OPENED with a command that either did not exist
 * (`pnpm --filter motebit dev` — the CLI has `start`) or did something
 * other than the sentence around it claimed (`pnpm --filter @motebit/desktop
 * dev` starts Vite alone; the webview is `tauri:dev`), and the scaffold
 * pages showed `npm run` scripts without the `--env-file` flag that makes
 * them work. `check-docs-tree` enforces the directory listing and
 * `check-docs-cli-claims` enforces CLI subcommands, but nothing tied a
 * `pnpm --filter X <script>` in prose to X's package.json — so the first
 * command a new contributor types was the least-checked sentence on the site.
 *
 * What is checked (fenced code blocks and inline code spans only — prose
 * like "the pnpm monorepo" is not a command):
 *
 *   pnpm --filter <pkg> <script>   → <pkg> must be a workspace package
 *                                    (by manifest `name`) and <script> one
 *                                    of its `scripts`.
 *   pnpm run <script> / pnpm <script>
 *                                  → resolved against the manifest of the
 *                                    most recent `cd <workspace-dir>` in the
 *                                    same fenced block, else the repo root.
 *                                    pnpm builtins (install, add, tsx, dlx,
 *                                    exec, …) are skipped.
 *   npm run <script>               → resolved against the scripts the
 *                                    create-motebit scaffold generates
 *                                    (parsed from its generator source), the
 *                                    only place the docs tell a reader to
 *                                    `npm run` anything.
 *
 * Aperture: prints how many pages and how many command claims of each kind
 * were resolved, so a green run states what it examined.
 *
 * Exit codes: 0 all claims resolve; 1 one or more do not.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DOCS_DIR = join(ROOT, "apps/docs/content/docs");
const SCAFFOLD_SOURCE = join(ROOT, "packages/create-motebit/src/index.ts");

/** pnpm subcommands that are not package scripts. */
const PNPM_BUILTINS = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "update",
  "up",
  "tsx",
  "dlx",
  "exec",
  "create",
  "init",
  "link",
  "unlink",
  "why",
  "list",
  "ls",
  "outdated",
  "audit",
  "publish",
  "pack",
  "store",
  "setup",
  "env",
  "run",
  "test",
  "start",
  "build",
]);

interface Manifest {
  dir: string; // repo-relative
  name: string;
  scripts: Set<string>;
}

function readManifest(dir: string): Manifest | null {
  const p = join(ROOT, dir, "package.json");
  if (!existsSync(p)) return null;
  const json = JSON.parse(readFileSync(p, "utf-8")) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  return { dir, name: json.name ?? dir, scripts: new Set(Object.keys(json.scripts ?? {})) };
}

function workspaceManifests(): { byName: Map<string, Manifest>; byDir: Map<string, Manifest> } {
  const byName = new Map<string, Manifest>();
  const byDir = new Map<string, Manifest>();
  const root = readManifest(".");
  if (root) {
    byDir.set(".", root);
    byName.set(root.name, root);
  }
  for (const group of ["packages", "apps", "services"]) {
    const groupDir = join(ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const dir = `${group}/${entry}`;
      if (!statSync(join(ROOT, dir)).isDirectory()) continue;
      const m = readManifest(dir);
      if (!m) continue;
      byName.set(m.name, m);
      byDir.set(dir, m);
    }
  }
  return { byName, byDir };
}

/** Script names the create-motebit generator writes into a scaffolded package.json. */
function scaffoldScripts(): Set<string> {
  const src = readFileSync(SCAFFOLD_SOURCE, "utf-8");
  const out = new Set<string>();
  // Every `scripts: { … }` object literal in the generator; keys may be bare
  // identifiers or quoted (e.g. "self-test").
  const blockRe = /scripts:\s*\{([\s\S]*?)\n\s*\}/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(src)) !== null) {
    const keyRe = /^\s*(?:"([^"]+)"|([A-Za-z_][\w:-]*))\s*:/gm;
    let key: RegExpExecArray | null;
    while ((key = keyRe.exec(block[1]!)) !== null) out.add(key[1] ?? key[2]!);
  }
  return out;
}

function listScripts(scripts: Set<string>): string {
  const all = [...scripts].sort();
  return all.length > 12
    ? `${all.slice(0, 12).join(", ")}, … ${all.length - 12} more`
    : all.join(", ");
}

function walkMdx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkMdx(full));
    else if (entry.endsWith(".mdx")) out.push(full);
  }
  return out.sort();
}

interface Claim {
  file: string;
  line: number;
  text: string;
  kind: "filter" | "pnpm" | "npm";
  pkg?: string; // manifest name (filter) or cwd dir (pnpm)
  script: string;
}

interface Violation extends Claim {
  reason: string;
}

/**
 * Extract command claims from one page: fenced blocks (tracking `cd` for
 * cwd) and inline code spans (cwd = root).
 */
function extractClaims(file: string, content: string): Claim[] {
  const claims: Claim[] = [];
  const lines = content.split("\n");
  let inFence = false;
  let cwd = ".";
  const push = (lineNo: number, text: string, currentCwd: string) => {
    for (const m of text.matchAll(/pnpm\s+--filter\s+(\S+)\s+(?:run\s+)?([\w][\w:-]*)/g)) {
      claims.push({ file, line: lineNo, text: m[0], kind: "filter", pkg: m[1]!, script: m[2]! });
    }
    for (const m of text.matchAll(/(?<![\w-])pnpm\s+(?!--)(?:run\s+)?([\w][\w:-]*)/g)) {
      const script = m[1]!;
      if (PNPM_BUILTINS.has(script) && !/^pnpm\s+run\s+/.test(m[0])) continue;
      if (script === "run") continue;
      claims.push({ file, line: lineNo, text: m[0], kind: "pnpm", pkg: currentCwd, script });
    }
    for (const m of text.matchAll(/(?<![\w-])npm\s+run\s+([\w][\w:-]*)/g)) {
      claims.push({ file, line: lineNo, text: m[0], kind: "npm", script: m[1]! });
    }
  };
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      cwd = "."; // a new block starts at the repo root unless it says otherwise
      return;
    }
    if (inFence) {
      const cd = /^\s*cd\s+([^\s&;|]+)/.exec(raw);
      if (cd) {
        const target = cd[1]!.replace(/\/$/, "");
        cwd = target === ".." || target.startsWith("/") ? "." : target;
        return;
      }
      push(lineNo, raw, cwd);
      return;
    }
    // Inline code spans in prose. A backticked workspace directory on the same
    // line ("run `pnpm run dev` in `services/relay/`") names the cwd.
    let proseCwd = ".";
    for (const dirSpan of raw.matchAll(/`((?:packages|apps|services)\/[\w.-]+)\/?`/g)) {
      proseCwd = dirSpan[1]!;
    }
    for (const span of raw.matchAll(/`([^`]+)`/g)) push(lineNo, span[1]!, proseCwd);
  });
  return claims;
}

function main(): void {
  const { byName, byDir } = workspaceManifests();
  const scaffold = scaffoldScripts();
  if (scaffold.size === 0) {
    console.error(
      "check-docs-script-claims: could not parse any `scripts: {…}` block from the create-motebit generator — retarget SCAFFOLD_SOURCE",
    );
    process.exit(1);
  }
  const files = walkMdx(DOCS_DIR);
  const counts = { filter: 0, pnpm: 0, npm: 0 };
  const violations: Violation[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    for (const claim of extractClaims(file, content)) {
      counts[claim.kind]++;
      if (claim.kind === "filter") {
        const m = byName.get(claim.pkg!);
        if (!m) {
          violations.push({ ...claim, reason: `no workspace package named \`${claim.pkg}\`` });
        } else if (!m.scripts.has(claim.script)) {
          violations.push({
            ...claim,
            reason: `\`${m.dir}/package.json\` has no script \`${claim.script}\` (has: ${listScripts(m.scripts)})`,
          });
        }
      } else if (claim.kind === "pnpm") {
        const cwd = claim.pkg!;
        const m = byDir.get(cwd);
        if (!m) {
          // A directory the repo does not contain (a scaffolded project,
          // `cd motebit` after a clone): resolve like the scaffold, then root.
          if (!scaffold.has(claim.script) && !byDir.get(".")!.scripts.has(claim.script)) {
            violations.push({
              ...claim,
              reason: `after \`cd ${cwd}\` — neither the create-motebit scaffold nor the repo root defines script \`${claim.script}\``,
            });
          }
        } else if (!m.scripts.has(claim.script)) {
          violations.push({
            ...claim,
            reason: `\`${m.dir}/package.json\` (cwd after \`cd ${cwd}\`) has no script \`${claim.script}\` (has: ${listScripts(m.scripts)})`,
          });
        }
      } else if (!scaffold.has(claim.script)) {
        violations.push({
          ...claim,
          reason: `the create-motebit scaffold generates no \`${claim.script}\` script (generates: ${listScripts(scaffold)})`,
        });
      }
    }
  }

  console.log("check-docs-script-claims:");
  console.log(`  ${files.length} MDX pages scanned`);
  console.log(`  ${byName.size} workspace manifests + ${scaffold.size} scaffold scripts loaded`);
  console.log(
    `  ${counts.filter} \`pnpm --filter\`, ${counts.pnpm} \`pnpm [run]\`, ${counts.npm} \`npm run\` command claims resolved`,
  );
  if (violations.length === 0) {
    console.log("✓ every documented package script exists in the manifest it runs against");
    return;
  }
  console.error(
    `\n✗ ${violations.length} documented command(s) name a script that does not exist:`,
  );
  for (const v of violations) {
    console.error(`  - ${relative(ROOT, v.file)}:${v.line}: \`${v.text}\` — ${v.reason}`);
  }
  console.error(
    "\nEither fix the docs to name a script that exists (the manifest is the canonical source),\n" +
      "or add the script to that package.json if the docs describe intended behaviour.\n" +
      "For `pnpm run <script>` inside a fenced block, put `cd <workspace-dir>` earlier in the same block\n" +
      "so the gate (and the reader) knows which package the command runs against.\n" +
      "See `docs/drift-defenses.md` invariant #157.",
  );
  process.exit(1);
}

main();
