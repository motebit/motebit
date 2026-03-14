/**
 * Architectural dependency enforcement for the Motebit monorepo.
 *
 * Five checks:
 *   1. No circular dependencies between @motebit/* packages
 *   2. No imports from internal paths (@motebit/foo/src/* or /dist/*)
 *   3. Layer ordering — lower layers cannot depend on higher layers
 *   4. Export surface — every package with src/ must have src/index.ts
 *   5. Undeclared dependencies — every @motebit/* import must be in package.json
 *
 * Exit code 1 on any violation. Designed to run in CI before typecheck.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Layer map ──────────────────────────────────────────────────────────
// Layer N may depend on layers 0..N-1 (production) or 0..N (devDependencies).
// Apps/services are Layer 5 and may depend on anything.

const LAYER: Record<string, number> = {
  // Layer 0 — Foundation (zero internal deps)
  "@motebit/sdk": 0,
  "@motebit/verify": 0,
  "@motebit/voice": 0,

  // Layer 1 — Primitives (depend only on Layer 0)
  "@motebit/crypto": 1,
  "@motebit/event-log": 1,
  "@motebit/policy": 1,
  "@motebit/tools": 1,
  "@motebit/semiring": 1,
  "@motebit/policy-invariants": 1,

  // Layer 2 — Engines (depend on Layer 0–1)
  "@motebit/market": 2,
  "@motebit/behavior-engine": 2,
  "@motebit/state-vector": 2,
  "@motebit/render-engine": 2,
  "@motebit/memory-graph": 2,
  "@motebit/core-identity": 2,
  "@motebit/sync-engine": 2,
  "@motebit/mcp-client": 2,
  "@motebit/identity-file": 2,

  // Layer 3 — Lower composites (depend on Layer 0–2)
  "@motebit/privacy-layer": 3,
  "@motebit/ai-core": 3,
  "@motebit/mcp-server": 3,

  // Layer 4 — Upper composites (depend on Layer 0–3)
  "@motebit/persistence": 4,
  "@motebit/planner": 4,

  // Layer 5 — Orchestrator
  "@motebit/runtime": 5,
  "@motebit/browser-persistence": 5,

  // Layer 6 — Applications (apps/*, services/*, create-motebit)
  "create-motebit": 6,
};

const APP_LAYER = 6;

// ── Types ──────────────────────────────────────────────────────────────

interface PkgInfo {
  name: string;
  dir: string;
  deps: string[]; // @motebit/* production dependencies
  devDeps: string[]; // @motebit/* dev dependencies
  exports: Record<string, unknown> | undefined;
}

// ── Helpers ────────────────────────────────────────────────────────────

function discoverPackages(): PkgInfo[] {
  const dirs = ["packages", "apps", "services"];
  const result: PkgInfo[] = [];

  for (const base of dirs) {
    const absBase = join(ROOT, base);
    if (!existsSync(absBase)) continue;
    for (const entry of readdirSync(absBase)) {
      const pkgJson = join(absBase, entry, "package.json");
      if (!existsSync(pkgJson)) continue;
      const pkg = JSON.parse(readFileSync(pkgJson, "utf-8")) as Record<string, unknown>;
      const name = pkg.name as string | undefined;
      if (!name) continue;

      const allDeps = pkg.dependencies as Record<string, string> | undefined;
      const allDevDeps = pkg.devDependencies as Record<string, string> | undefined;

      result.push({
        name,
        dir: join(absBase, entry),
        deps: Object.keys(allDeps ?? {}).filter(
          (d) => d.startsWith("@motebit/") || d === "create-motebit",
        ),
        devDeps: Object.keys(allDevDeps ?? {}).filter(
          (d) => d.startsWith("@motebit/") || d === "create-motebit",
        ),
        exports: pkg.exports as Record<string, unknown> | undefined,
      });
    }
  }
  return result;
}

/** Extract @motebit/* package name from an import specifier. */
function extractPkgName(specifier: string): string | null {
  if (specifier === "create-motebit") return "create-motebit";
  const m = /^(@motebit\/[^/]+)/.exec(specifier);
  return m ? m[1] : null;
}

/** Extract sub-path from an import specifier (e.g., "browser" from "@motebit/ai-core/browser"). */
function extractSubPath(specifier: string): string | null {
  if (specifier === "create-motebit") return null;
  const m = /^@motebit\/[^/]+\/(.+)$/.exec(specifier);
  return m ? m[1] : null;
}

/** Get declared sub-path export keys from a package's exports field. */
function getDeclaredSubPaths(exports: Record<string, unknown> | undefined): Set<string> {
  const paths = new Set<string>();
  if (!exports) return paths;
  for (const key of Object.keys(exports)) {
    if (key === ".") continue;
    // "./browser" → "browser", "./dist/*" → wildcard (skip)
    const sub = key.replace(/^\.\//, "");
    if (sub.includes("*")) continue; // wildcards are not allowed — they undermine boundary enforcement
    paths.add(sub);
  }
  return paths;
}

/** Recursively collect all .ts/.tsx files under a directory, excluding node_modules and dist. */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === ".turbo")
        continue;
      const full = join(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
        files.push(full);
      }
    }
  }
  walk(dir);
  return files;
}

/** Extract all @motebit/* import specifiers from a source file. */
function extractImports(
  filePath: string,
): Array<{ specifier: string; line: number; typeOnly: boolean }> {
  const content = readFileSync(filePath, "utf-8");
  const results: Array<{ specifier: string; line: number; typeOnly: boolean }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for "import type" or "import { type ... } from" patterns
    const isTypeImport = /^\s*import\s+type\s/.test(line);

    // Match: import ... from "@motebit/...", require("@motebit/..."), import("@motebit/...")
    const patterns = [
      /from\s+['"](@motebit\/[^'"]+)['"]/g,
      /from\s+['"](create-motebit)['"]/g,
      /require\(\s*['"](@motebit\/[^'"]+)['"]\s*\)/g,
      /import\(\s*['"](@motebit\/[^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(line)) !== null) {
        results.push({ specifier: match[1], line: i + 1, typeOnly: isTypeImport });
      }
    }
  }
  return results;
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes("__tests__") || filePath.endsWith(".test.ts") || filePath.endsWith(".spec.ts")
  );
}

// ── Checks ─────────────────────────────────────────────────────────────

const violations: string[] = [];

function fail(check: string, msg: string): void {
  violations.push(`[${check}] ${msg}`);
}

// Check 1: Circular dependencies (DFS)
function checkCircularDeps(packages: PkgInfo[]): void {
  const graph = new Map<string, string[]>();
  for (const pkg of packages) {
    graph.set(pkg.name, pkg.deps);
  }

  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart).concat(node);
      fail("circular", `Cycle detected: ${cycle.join(" → ")}`);
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);

    for (const dep of graph.get(node) ?? []) {
      if (graph.has(dep)) {
        dfs(dep, [...path, node]);
      }
    }

    stack.delete(node);
  }

  for (const name of graph.keys()) {
    dfs(name, []);
  }
}

// Check 2: No internal path imports
function checkInternalImports(packages: PkgInfo[]): void {
  // Build map of allowed sub-paths per package
  const allowedSubPaths = new Map<string, Set<string>>();
  for (const pkg of packages) {
    allowedSubPaths.set(pkg.name, getDeclaredSubPaths(pkg.exports));
  }

  for (const pkg of packages) {
    const srcDir = join(pkg.dir, "src");
    if (!existsSync(srcDir)) continue;

    for (const file of collectSourceFiles(srcDir)) {
      for (const imp of extractImports(file)) {
        const subPath = extractSubPath(imp.specifier);
        if (!subPath) continue;

        const targetPkg = extractPkgName(imp.specifier);
        if (!targetPkg) continue;

        // Check if this sub-path is declared in the target's exports
        const allowed = allowedSubPaths.get(targetPkg);
        if (!allowed || !allowed.has(subPath)) {
          const rel = relative(ROOT, file);
          fail(
            "internal-import",
            `${rel}:${imp.line} imports internal path "${imp.specifier}" — ` +
              `only root or declared sub-path exports are allowed`,
          );
        }
      }
    }
  }
}

// Check 3: Layer ordering
function checkLayerOrdering(packages: PkgInfo[]): void {
  for (const pkg of packages) {
    const pkgLayer = LAYER[pkg.name];

    // Apps and services are implicitly the application layer
    const isApp = pkg.dir.includes("/apps/") || pkg.dir.includes("/services/");
    const effectiveLayer = pkgLayer ?? (isApp ? APP_LAYER : undefined);

    if (effectiveLayer === undefined) {
      fail(
        "layer",
        `Package "${pkg.name}" is not registered in the layer map — add it to scripts/check-deps.ts`,
      );
      continue;
    }

    // Production deps must be strictly lower layer
    for (const dep of pkg.deps) {
      const depLayer = LAYER[dep];
      if (depLayer === undefined) continue; // external or unregistered (caught above)
      if (depLayer >= effectiveLayer && effectiveLayer !== APP_LAYER) {
        fail(
          "layer",
          `"${pkg.name}" (layer ${effectiveLayer}) depends on "${dep}" (layer ${depLayer}) — ` +
            `production dependencies must be in a strictly lower layer`,
        );
      }
    }

    // Dev deps may be same layer or lower (not higher)
    for (const dep of pkg.devDeps) {
      const depLayer = LAYER[dep];
      if (depLayer === undefined) continue;
      if (depLayer > effectiveLayer && effectiveLayer !== APP_LAYER) {
        fail(
          "layer",
          `"${pkg.name}" (layer ${effectiveLayer}) has devDependency on "${dep}" (layer ${depLayer}) — ` +
            `devDependencies must not be in a higher layer`,
        );
      }
    }
  }
}

// Check 4: Export surface
function checkExportSurface(packages: PkgInfo[]): void {
  for (const pkg of packages) {
    // Skip apps and services — they don't export
    if (pkg.dir.includes("/apps/") || pkg.dir.includes("/services/")) continue;

    const srcDir = join(pkg.dir, "src");
    if (!existsSync(srcDir)) continue;

    const indexTs = join(srcDir, "index.ts");
    if (!existsSync(indexTs)) {
      fail(
        "export-surface",
        `"${pkg.name}" has src/ but no src/index.ts — every package must export from src/index.ts`,
      );
    }
  }
}

// Packages that bundle workspace deps via tsup — devDependencies are inlined
// at build time, so importing them in production source is correct.
const BUNDLED_PACKAGES = new Set(["motebit"]);

// Check 5: Undeclared dependencies
function checkUndeclaredDeps(packages: PkgInfo[]): void {
  for (const pkg of packages) {
    const srcDir = join(pkg.dir, "src");
    if (!existsSync(srcDir)) continue;

    const declaredDeps = new Set([...pkg.deps, ...pkg.devDeps]);
    const prodDeps = new Set(pkg.deps);
    const isBundled = BUNDLED_PACKAGES.has(pkg.name);

    for (const file of collectSourceFiles(srcDir)) {
      for (const imp of extractImports(file)) {
        const depName = extractPkgName(imp.specifier);
        if (!depName) continue;
        if (depName === pkg.name) continue; // self-import

        if (!declaredDeps.has(depName)) {
          const rel = relative(ROOT, file);
          fail(
            "undeclared",
            `${rel}:${imp.line} imports "${depName}" but it is not in ${pkg.name}/package.json dependencies`,
          );
        } else if (!isTestFile(file) && !prodDeps.has(depName)) {
          // Non-test file importing a devDependency
          // Allowed cases:
          //   1. Type-only imports (erased at compile time)
          //   2. Bundled packages (tsup inlines devDeps)
          if (imp.typeOnly || isBundled) continue;

          const rel = relative(ROOT, file);
          fail(
            "undeclared",
            `${rel}:${imp.line} imports "${depName}" which is only a devDependency of ${pkg.name} — ` +
              `move it to dependencies or use "import type" if type-only`,
          );
        }
      }
    }
  }
}

// Check for wildcard exports (warnings, not errors)
function warnWildcardExports(packages: PkgInfo[]): void {
  for (const pkg of packages) {
    if (!pkg.exports) continue;
    for (const key of Object.keys(pkg.exports)) {
      if (key.includes("*")) {
        console.warn(
          `  WARN: "${pkg.name}" declares wildcard export "${key}" — ` +
            `this undermines boundary enforcement. Use explicit sub-path exports instead.`,
        );
      }
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────

console.log("Checking architectural dependencies...\n");

const packages = discoverPackages();
console.log(`  Found ${packages.length} workspace packages\n`);

warnWildcardExports(packages);

checkCircularDeps(packages);
checkInternalImports(packages);
checkLayerOrdering(packages);
checkExportSurface(packages);
checkUndeclaredDeps(packages);

if (violations.length === 0) {
  console.log("\n  All architectural checks passed.\n");
  process.exit(0);
} else {
  console.error(`\n  ${violations.length} violation(s) found:\n`);
  for (const v of violations) {
    console.error(`  ERROR ${v}`);
  }
  console.error("");
  process.exit(1);
}
