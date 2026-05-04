/**
 * Browser-entry purity check.
 *
 * Every workspace package's top-level entry (`packages/<pkg>/src/index.ts`)
 * MUST NOT directly re-export from a sibling file that eagerly imports
 * `node:*` at module top. Eager destructuring (`const { closeSync } =
 * require("node:fs")` or `import { closeSync } from "node:fs"`) of
 * vite's browser-externalized `node:*` stub crashes at module-evaluation
 * time — the stub throws on property access. The crash bypasses any
 * `try/catch` in caller code because it fires during the import-graph
 * walk, before any user code runs.
 *
 * `@motebit/skills` had this exact bug for one commit cycle (Commit 2 of
 * the cross-surface skills arc, 2026-05-04): `index.ts` re-exported
 * `NodeFsSkillStorageAdapter` from `fs-adapter.ts` which destructures
 * `node:fs`. The web bundle had never imported `@motebit/skills` before;
 * Commit 2 added the first import for `SkillRegistry`. The re-export
 * dragged `fs-adapter.ts` into the module graph, vite served the
 * `node:fs` stub, the destructure threw, `app.bootstrap()` never ran,
 * the renderer's animation loop never started — HUD chips mounted (sync
 * code) but the canvas stayed empty. `"sideEffects": false` only helps
 * production builds; vite dev mode evaluates ES modules eagerly.
 *
 * The hot-fix split the entry point: `@motebit/skills` (browser-safe)
 * for `SkillRegistry` + `SkillSelector`, `@motebit/skills/node-fs` for
 * `NodeFsSkillStorageAdapter`. Other packages already followed this
 * convention — `@motebit/core-identity` has a `node.ts` sub-entry,
 * `@motebit/ai-core`'s top-level `index.ts` carries an explicit comment
 * naming `loadConfig` as Node-only and reachable via direct file path.
 * Skills was the exception that broke discipline.
 *
 * Defense: walk every `packages/<pkg>/src/index.ts`, extract its direct
 * `export ... from "./X.js"` and `import ... from "./X.js"` references,
 * read each referenced file, and reject any that imports `node:*` at
 * module top. One-level deep is sufficient for the actual bug shape (the
 * problem is direct re-export; transitive imports through internal
 * boundaries are the package author's structural choice). Sub-entries
 * (e.g. `node.ts`, `node-fs.ts`) and `bin/*.ts` files are exempt by
 * convention — they're explicitly Node-only and consumers opt in via
 * subpath.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");

/**
 * Browser surfaces — apps whose bundle runs in a Chromium-class
 * environment. The renderer of `apps/desktop` is also a Chromium webview
 * (architecture_tauri_webview_not_node), so its imports cross the same
 * boundary. Only packages reachable from these apps' dep closure need
 * to keep their top-level entry browser-safe; CLI bins (e.g.
 * `create-motebit`, `motebit-verify`), server frameworks
 * (`@motebit/mcp-server`), and Node-only data stores
 * (`@motebit/persistence`) are exempt by audience.
 */
const BROWSER_APPS = ["web", "desktop"];

interface Violation {
  pkg: string;
  entry: string;
  reExportedFile: string;
  nodeImports: string[];
}

/**
 * Extract relative-path re-exports and side-effecting imports from an
 * `index.ts`. Captures any `from "./..."` (including `from "./X/Y.js"`)
 * — drops bare imports like `from "@motebit/foo"` and `from "node:fs"`
 * (the gate only inspects same-package siblings; cross-package boundaries
 * are governed by check-deps).
 */
function extractRelativeReExports(src: string): string[] {
  const out: string[] = [];
  const reExportRegex = /^\s*(?:export|import)(?:\s+[\s\S]*?)?\s+from\s+["'](\.\.?\/[^"']+)["']/gm;
  let match;
  while ((match = reExportRegex.exec(src)) !== null) {
    out.push(match[1]!);
  }
  return out;
}

/**
 * Extract top-level `node:*` imports. Top-level meaning: not inside a
 * function body, not inside dynamic `import("node:fs")`. Heuristic
 * check on a line-prefixed regex — the dynamic-import case uses
 * parentheses and isn't matched by the bare `from "node:..."` form.
 */
function findTopLevelNodeImports(src: string): string[] {
  const out: string[] = [];
  // Match `import ... from "node:X"` and `import "node:X"` at column 0.
  const regex = /^\s*import\b[^"';]*["'](node:[^"']+)["']/gm;
  let match;
  while ((match = regex.exec(src)) !== null) {
    out.push(match[1]!);
  }
  return out;
}

function resolveSibling(entryPath: string, relPath: string): string | null {
  // Strip query strings (`?worker`) and fragments before resolving.
  const cleaned = relPath.split(/[?#]/)[0]!;
  // Try `.ts`, `.tsx`, then the path as-is (already extensioned), then `/index.ts`.
  const base = resolve(dirname(entryPath), cleaned);
  const candidates = [
    base.endsWith(".js") ? base.replace(/\.js$/, ".ts") : base,
    base.endsWith(".js") ? base.replace(/\.js$/, ".tsx") : `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function listPackages(): string[] {
  return readdirSync(PACKAGES_DIR).filter((name) => {
    const indexPath = join(PACKAGES_DIR, name, "src", "index.ts");
    return existsSync(indexPath) && statSync(join(PACKAGES_DIR, name)).isDirectory();
  });
}

/**
 * Compute the actual import closure rooted at the given apps' source
 * trees. Walks `apps/<app>/src/**\/*.ts` for `from "@motebit/<X>"`
 * imports, then walks each referenced package's `src/index.ts` for
 * further `@motebit/<Y>` re-exports — recursively until fixed point.
 *
 * Why this and not the package.json dep closure: a package can declare
 * `@motebit/foo` as a dependency without ever actually importing from
 * it in source code reachable from the renderer (e.g. `@motebit/verify`
 * declares `@motebit/verifier` because its CLI bin uses the
 * file-reading library, but `@motebit/verify`'s exported `index.ts`
 * never touches `@motebit/verifier` — that import lives in `cli.ts`).
 * The dep closure overstates reachability; the source-walk closure
 * matches what actually ends up in the browser bundle.
 */
function browserReachablePackages(apps: ReadonlyArray<string>): Set<string> {
  const reachable = new Set<string>();

  /**
   * Extract `@motebit/<X>` package references from an arbitrary TS
   * source. Strip block comments and line comments first so JSDoc
   * `import { X } from "@motebit/Y"` examples don't count as real
   * imports — the verify→verifier "false positive" was exactly this:
   * `verify/src/index.ts` carries an example `import { verifyFile }
   * from "@motebit/verifier"` inside a `/** ... *\/` block, but no
   * actual code in `index.ts` reaches verifier (only `cli.ts` does).
   */
  function extractMotebitImports(src: string): string[] {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const out = new Set<string>();
    const regex = /from\s+["']@motebit\/([^"'/]+)(?:\/[^"']*)?["']/g;
    let match;
    while ((match = regex.exec(stripped)) !== null) {
      out.add(match[1]!);
    }
    return [...out];
  }

  /** Walk a directory's `.ts`/`.tsx` files (skip `.d.ts`, tests, `__tests__`). */
  function walkTsFiles(dir: string): string[] {
    const out: string[] = [];
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "__tests__" || entry.name === "__mocks__") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walkTsFiles(full));
      } else if (
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".d.ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test.tsx")
      ) {
        out.push(full);
      }
    }
    return out;
  }

  function visit(pkg: string): void {
    if (reachable.has(pkg)) return;
    reachable.add(pkg);
    const indexPath = join(PACKAGES_DIR, pkg, "src", "index.ts");
    if (!existsSync(indexPath)) return;
    const src = readFileSync(indexPath, "utf-8");
    for (const next of extractMotebitImports(src)) {
      visit(next);
    }
  }

  for (const app of apps) {
    const srcDir = join(ROOT, "apps", app, "src");
    for (const file of walkTsFiles(srcDir)) {
      const src = readFileSync(file, "utf-8");
      for (const pkg of extractMotebitImports(src)) {
        visit(pkg);
      }
    }
  }
  return reachable;
}

function checkPackage(pkg: string): Violation[] {
  const entry = join(PACKAGES_DIR, pkg, "src", "index.ts");
  const src = readFileSync(entry, "utf-8");
  const relRefs = extractRelativeReExports(src);
  const violations: Violation[] = [];
  for (const ref of relRefs) {
    const resolved = resolveSibling(entry, ref);
    if (resolved === null) continue;
    const refSrc = readFileSync(resolved, "utf-8");
    const nodeImports = findTopLevelNodeImports(refSrc);
    if (nodeImports.length === 0) continue;
    violations.push({
      pkg,
      entry: entry.replace(`${ROOT}/`, ""),
      reExportedFile: resolved.replace(`${ROOT}/`, ""),
      nodeImports,
    });
  }
  return violations;
}

function main(): void {
  const reachable = browserReachablePackages(BROWSER_APPS);
  // Deduplicate violations by (entry + reExportedFile) — a package that
  // both `import`s and `export`s from the same file appears twice in the
  // raw scan, but the underlying drift is one re-export shape.
  const seen = new Set<string>();
  const violations: Violation[] = [];
  for (const pkg of listPackages()) {
    if (!reachable.has(pkg)) continue;
    for (const v of checkPackage(pkg)) {
      const key = `${v.entry}::${v.reExportedFile}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push(v);
    }
  }

  if (violations.length === 0) {
    process.stderr.write(
      `✓ check-package-browser-entry: no browser-reachable package entry (apps/web + apps/desktop closure, ${reachable.size} packages) re-exports a sibling that eagerly imports node:*.\n`,
    );
    return;
  }

  process.stderr.write(
    `\n✗ check-package-browser-entry: ${violations.length} package entry re-export(s) drag node:* siblings into browser bundles.\n\n`,
  );
  for (const v of violations) {
    process.stderr.write(
      `  ${v.entry} → ${v.reExportedFile}\n` +
        `    pulls in: ${v.nodeImports.join(", ")}\n` +
        `    fix: move the Node-only export to a sub-entry (e.g. ${v.pkg}/src/node-fs.ts)\n` +
        `         and update consumers to import from "@motebit/${v.pkg}/node-fs" or similar.\n` +
        `    background: vite dev mode evaluates ES modules eagerly; the node:* stub\n` +
        `         throws on property access at module-evaluation time, crashing any\n` +
        `         browser surface that imports the package's top-level entry.\n\n`,
    );
  }
  process.stderr.write(
    `See packages/skills/src/index.ts + packages/skills/src/node-fs.ts for the\n` +
      `canonical split pattern (and the package.json exports map that gates the two\n` +
      `entry points). Background: docs/drift-defenses.md invariant #72.\n`,
  );
  process.exit(1);
}

main();
