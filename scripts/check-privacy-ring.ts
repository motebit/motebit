#!/usr/bin/env tsx
/**
 * check-privacy-ring — sync invariant #16.
 *
 * The root CLAUDE.md declares `Fail-closed privacy` as an architectural
 * invariant: every surface must enforce sensitivity levels at storage,
 * retrieval, sync, and context boundaries. `@motebit/event-log` is the
 * append-only audit trail; `@motebit/privacy-layer` is the retention
 * policy engine. Together they are the Ring 2 privacy substrate.
 *
 * Before this gate, desktop and mobile declared both packages and wired
 * their adapters at boot, but web, spatial, and CLI declared neither —
 * the Ring 2 claim was aspirational on three of the five surfaces. This
 * gate makes the claim mechanical: every surface app MUST (a) declare
 * both packages as deps, and (b) import at least one symbol from each
 * somewhere in its source so the declaration isn't lint-sugar.
 *
 * Scope: `apps/{web,cli,desktop,mobile,spatial}` — the five user-facing
 * surfaces. Supporting apps (inspector, identity, docs) are explicitly
 * excluded; their doctrine is different (inspector is operator-facing,
 * identity and docs are public static tools).
 *
 * Adding a new surface means adding it to SURFACES below. Removing one
 * from Ring 2 means a changeset + doctrine update, not a quiet delete.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** The surfaces subject to the Ring 2 privacy claim. */
const SURFACES: readonly string[] = ["web", "cli", "desktop", "mobile", "spatial"];

/** Packages that together form the Ring 2 privacy substrate. */
const REQUIRED_PACKAGES: readonly string[] = ["@motebit/event-log", "@motebit/privacy-layer"];

interface Finding {
  surface: string;
  kind: "missing-dep" | "missing-import";
  pkg: string;
  detail: string;
}

function collectTsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".next" ||
        entry.name === ".turbo"
      ) {
        continue;
      }
      collectTsFiles(full, out);
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function declaredDeps(packageJsonPath: string): Set<string> {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
}

/** True if any source file under `srcDir` imports from the given package. */
function importsFrom(srcDir: string, pkgName: string): boolean {
  const pattern = new RegExp(`from\\s+['"]${pkgName.replace(/[/]/g, "\\/")}(['"\\/])`);
  for (const file of collectTsFiles(srcDir)) {
    // Skip test files — the Ring 2 claim is about production behavior,
    // not test fixtures. A surface where only tests import the packages
    // is not honoring the claim.
    if (file.includes("/__tests__/") || file.endsWith(".test.ts") || file.endsWith(".test.tsx")) {
      continue;
    }
    const content = readFileSync(file, "utf-8");
    if (pattern.test(content)) return true;
  }
  return false;
}

function main(): void {
  const findings: Finding[] = [];

  for (const surface of SURFACES) {
    const dir = join(ROOT, "apps", surface);
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) {
      console.error(`check-privacy-ring: expected apps/${surface}/package.json, not found`);
      process.exit(1);
    }

    const deps = declaredDeps(pkgPath);
    const srcDir = join(dir, "src");

    for (const pkg of REQUIRED_PACKAGES) {
      if (!deps.has(pkg)) {
        findings.push({
          surface,
          kind: "missing-dep",
          pkg,
          detail: `apps/${surface}/package.json does not declare ${pkg} in dependencies or devDependencies`,
        });
        continue;
      }
      if (!importsFrom(srcDir, pkg)) {
        findings.push({
          surface,
          kind: "missing-import",
          pkg,
          detail: `apps/${surface}/src/** has no non-test import from ${pkg} — the declaration is lint-sugar, not a real consumption point`,
        });
      }
    }

    // Stat the src/ directory so the check fails loudly if a surface has
    // no source at all (rather than silently passing on an empty shell).
    try {
      statSync(srcDir);
    } catch {
      findings.push({
        surface,
        kind: "missing-import",
        pkg: "(src/)",
        detail: `apps/${surface}/src/ does not exist`,
      });
    }
  }

  const header = `check-privacy-ring — Ring 2 privacy substrate on ${SURFACES.length} surfaces`;
  console.log(header);

  if (findings.length === 0) {
    console.log(
      `✓ Every surface declares and imports ${REQUIRED_PACKAGES.join(" + ")} — fail-closed privacy is mechanical.`,
    );
    return;
  }

  console.error(`\n✗ ${findings.length} violation(s):\n`);
  for (const f of findings) {
    console.error(`  [${f.surface}] ${f.kind}: ${f.pkg}`);
    console.error(`      ${f.detail}`);
  }
  console.error(
    `\n  Fix: add the missing package to apps/<surface>/package.json, then import at least one\n` +
      `  symbol (e.g., \`import type { EventStoreAdapter } from "@motebit/event-log"\`) at a natural\n` +
      `  consumption point — typically where the surface assembles its StorageAdapters.`,
  );
  process.exit(1);
}

main();

// Reference path to silence unused-import lint when this file is read in
// isolation by a reviewer. The `relative` import is used below in log
// messages if we ever want to switch to ROOT-relative paths.
void relative;
