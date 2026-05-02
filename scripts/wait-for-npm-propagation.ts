#!/usr/bin/env tsx
/**
 * wait-for-npm-propagation — poll npm until every publishable workspace
 * package's `package.json` version is visible on the registry.
 *
 * Used in release.yml between the publish step and the post-publish
 * smoke test. Replaces a fixed `sleep 10` that lost the race twice
 * during the v1.2 cut: smoke ran before npm's metadata index showed
 * the just-published version, so `npx create-motebit@latest` →
 * `npm install` resolved to the previous (broken) version of
 * `@motebit/crypto`.
 *
 * Per package: poll `npm view <name>@<version> version` every 3 seconds
 * for up to 90 seconds, exit when the registry confirms the local
 * version is published. Packages run sequentially — when the first is
 * visible, the others are usually within a few seconds, so total wall
 * time is bounded by the slowest single package, not the sum.
 *
 * Already-published packages (those that didn't bump in the most
 * recent run) return immediately because `npm view <pkg>@<old-version>`
 * resolves on the first attempt.
 *
 * Exit 1 if any package fails to propagate within its per-package
 * timeout — the publish either didn't happen, or npm registry is
 * broken at the metadata layer.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const POLL_INTERVAL_MS = 3000;
const PER_PACKAGE_ATTEMPTS = 30; // 30 × 3s = 90s

interface Pkg {
  name: string;
  version: string;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function getPublishablePackages(): Pkg[] {
  const config = readJson(join(REPO_ROOT, ".changeset", "config.json"));
  const ignore = new Set<string>(Array.isArray(config.ignore) ? config.ignore : []);
  const result: Pkg[] = [];
  for (const top of ["packages", "apps", "services"]) {
    const dir = join(REPO_ROOT, top);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pkgPath = join(dir, name, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = readJson(pkgPath);
      if (pkg.private === true) continue;
      if (ignore.has(pkg.name)) continue;
      if (typeof pkg.name !== "string" || typeof pkg.version !== "string") continue;
      result.push({ name: pkg.name, version: pkg.version });
    }
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function npmViewVersion(name: string, version: string): string | null {
  try {
    const out = execSync(`npm view ${name}@${version} version`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    // `npm view <pkg>@<unpublished-version>` exits non-zero — not yet
    // propagated, or never published.
    return null;
  }
}

async function waitForOne({ name, version }: Pkg): Promise<boolean> {
  for (let attempt = 0; attempt < PER_PACKAGE_ATTEMPTS; attempt++) {
    const live = npmViewVersion(name, version);
    if (live === version) {
      const elapsedSec = Math.round((attempt * POLL_INTERVAL_MS) / 1000);
      console.log(`  ✓ ${name}@${version} visible after ~${elapsedSec}s`);
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const timeoutSec = (PER_PACKAGE_ATTEMPTS * POLL_INTERVAL_MS) / 1000;
  console.error(`  ✗ ${name}@${version} NOT visible after ${timeoutSec}s`);
  return false;
}

async function main(): Promise<void> {
  const packages = getPublishablePackages();
  console.log(`Polling npm for ${packages.length} publishable package(s)...`);
  let allOk = true;
  for (const pkg of packages) {
    const ok = await waitForOne(pkg);
    if (!ok) allOk = false;
  }
  if (!allOk) {
    console.error(
      "\nOne or more packages failed to propagate within the per-package timeout.\n" +
        "Either the publish didn't happen, or npm's metadata index is broken.",
    );
    process.exit(1);
  }
  console.log(`\nAll ${packages.length} packages propagated.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
