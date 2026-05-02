#!/usr/bin/env tsx
/**
 * check-tsup-uses-emit-decl-only — synchronization invariant #70.
 *
 * Every workspace package whose `scripts.build` invokes `tsup` MUST pin
 * `emitDeclarationOnly: true` in its own `tsconfig.json` `compilerOptions`.
 *
 * ## Why this gate exists
 *
 * `tsconfig.base.json` sets `composite: true` so every workspace package
 * is a valid project-reference target. When ANY workspace package's
 * `scripts.build` runs `tsc -b`, tsc walks the project-reference graph
 * and recompiles referenced projects — emitting per-source `.js` files
 * into the referenced project's `outDir`. That emit respects the
 * REFERENCED project's tsconfig, NOT the caller's CLI flags.
 *
 * For tsup users, that's destructive. tsup writes ONE bundled
 * `dist/index.js` (and any subpath entries). A foreign `tsc -b` then
 * emits per-file `.js` into the same `dist/`, OVERWRITING the bundle
 * with multi-file tsc output. The published artifact ends up with
 * unbundled `import` statements for deps that are listed as
 * `noExternal` (intended-bundled) and not declared as runtime deps —
 * `npm install` of the standalone artifact then fails at import time.
 *
 * ## History
 *
 * `@motebit/crypto@1.2.0` shipped to npm 2026-05-02 07:41 UTC with
 * exactly this break: the published `dist/suite-dispatch.js` was 8.9 KB
 * with `import * as ed from "@noble/ed25519"`, instead of the expected
 * ~100 KB tsup bundle. Post-publish smoke caught it; hot-fix `1.2.1`
 * shipped 33 minutes later after pinning `emitDeclarationOnly: true` in
 * `packages/crypto/tsconfig.json`. This gate prevents recurrence.
 *
 * ## Mechanism
 *
 * Pinning `emitDeclarationOnly: true` in the package's OWN tsconfig means
 * every tsc invocation against that project — its own build, every
 * cross-package `tsc -b`, every `tsc --build` from anywhere — emits
 * `.d.ts` only, never `.js`. tsup's bundle in `dist/` is no longer at
 * risk of being clobbered.
 *
 * ## Detection
 *
 *   1. Walk every top-level subdirectory of `packages/` and `apps/`.
 *   2. For each, if `scripts.build` contains the word "tsup":
 *      - Read sibling `tsconfig.json`.
 *      - Fail if `compilerOptions.emitDeclarationOnly !== true`.
 *
 * Note: this is a literal-text check on the package's own tsconfig.
 * `extends` chains are not resolved — pinning must be explicit at the
 * package level, since the base `tsconfig.base.json` deliberately does
 * NOT set `emitDeclarationOnly` (most packages emit `.js` via tsc).
 *
 * Exit 1 on any violation.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

interface Violation {
  pkgPath: string;
  pkgName: string;
  buildScript: string;
  reason: string;
}

function listSubdirs(parent: string): string[] {
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .map((name) => join(parent, name))
    .filter((p) => statSync(p).isDirectory());
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function buildInvokesTsup(buildScript: string): boolean {
  // Match `tsup` as a standalone token in the build script string.
  // Examples that should match:
  //   "tsup"
  //   "tsup && tsc ..."
  //   "rimraf dist && tsup --watch"
  // Examples that should NOT match (defensive):
  //   "@motebit/some-tsup-helper"  (substring of another identifier)
  //   "echo 'no tsup here'"        (not invoking tsup)
  return /(^|[\s&;|])tsup($|[\s&;|])/.test(buildScript);
}

function checkPackage(pkgDir: string, violations: Violation[]): void {
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return;

  const pkg = readJson(pkgJsonPath) as {
    name?: string;
    scripts?: { build?: string };
  };
  const buildScript = pkg.scripts?.build;
  if (!buildScript) return;
  if (!buildInvokesTsup(buildScript)) return;

  const tsconfigPath = join(pkgDir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    violations.push({
      pkgPath: pkgDir,
      pkgName: pkg.name ?? "?",
      buildScript,
      reason:
        "package's `scripts.build` invokes tsup but no `tsconfig.json` exists at the package root — cross-package `tsc -b` cannot pin `emitDeclarationOnly: true` for this project",
    });
    return;
  }

  const tsconfig = readJson(tsconfigPath) as {
    compilerOptions?: { emitDeclarationOnly?: boolean };
  };
  const emitDeclarationOnly = tsconfig.compilerOptions?.emitDeclarationOnly;
  if (emitDeclarationOnly !== true) {
    violations.push({
      pkgPath: pkgDir,
      pkgName: pkg.name ?? "?",
      buildScript,
      reason: `\`tsconfig.json\` compilerOptions.emitDeclarationOnly = ${
        emitDeclarationOnly === undefined ? "<unset>" : JSON.stringify(emitDeclarationOnly)
      } — must be \`true\` to prevent foreign \`tsc -b\` from clobbering tsup's bundle`,
    });
  }
}

function main(): void {
  const violations: Violation[] = [];
  const candidates = [
    ...listSubdirs(join(REPO_ROOT, "packages")),
    ...listSubdirs(join(REPO_ROOT, "apps")),
  ];
  for (const dir of candidates) {
    checkPackage(dir, violations);
  }

  if (violations.length === 0) {
    console.log(
      `✓ check-tsup-uses-emit-decl-only — ${candidates.length} workspace package(s) scanned, all tsup users pin emitDeclarationOnly`,
    );
    return;
  }

  console.error(`✗ check-tsup-uses-emit-decl-only — ${violations.length} violation(s):\n`);
  for (const v of violations) {
    const rel = v.pkgPath.startsWith(REPO_ROOT + "/")
      ? v.pkgPath.slice(REPO_ROOT.length + 1)
      : v.pkgPath;
    console.error(`  ${v.pkgName} (${rel})`);
    console.error(`    build: ${v.buildScript}`);
    console.error(`    issue: ${v.reason}\n`);
  }
  console.error(
    'Fix: add `"emitDeclarationOnly": true` under `compilerOptions` in each violating tsconfig.json.\n' +
      "See docs/drift-defenses.md #70 for the @motebit/crypto@1.2.0 incident this gate was named after.",
  );
  process.exit(1);
}

main();
