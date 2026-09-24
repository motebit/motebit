/**
 * Playwright image ↔ dependency parity.
 *
 * Every Dockerfile that builds on `mcr.microsoft.com/playwright:v<X.Y.Z>-…`
 * must pin the SAME version that `pnpm-lock.yaml` resolves for that
 * service's `playwright-core` (or `playwright`) dependency — in every stage.
 *
 * Why this is a crash loop and not a version skew: Playwright resolves the
 * browser build by a revision baked into the client library. A client newer
 * than the image looks for a Chromium the image does not carry and exits 1 at
 * boot. `services/browser-sandbox/fly.toml` runs always-on with
 * `auto_stop_machines = false`, so a machine that crash-loops past its restart
 * budget STOPS AND STAYS STOPPED until someone deploys again.
 *
 * It has happened twice: 2026-07-25, and 2026-08-22 when a grouped dependabot
 * bump (#577) moved `playwright-core` 1.61.1 → 1.62.1 while both image tags
 * stayed at v1.61.1 (fixed by #584). Nothing in CI builds or boots the
 * container, so both halves were individually correct and the guarantee only
 * broke once composed in the deployed system — the
 * `composition-preserves-enforcement` class at the image boundary. Since
 * #647 every lockfile change redeploys every service automatically, which
 * makes this gate a prerequisite rather than a nicety: a dependabot bump now
 * reaches the Fly deploy without a human ever opening the Dockerfile.
 *
 * Direction of repair: the lockfile is the truth (it is what dependabot moves
 * and what the bundle actually runs); the Dockerfile follows it. Bumping the
 * dependency to meet a newer image is also legal — the invariant is equality,
 * landed in ONE change.
 *
 * Scope: every `Dockerfile*` under `services/`, `apps/`, `packages/`. A
 * Dockerfile that does not build on the Playwright image is out of scope. A
 * Dockerfile that DOES pin the image but whose package resolves no Playwright
 * client is a violation too — there is nothing for the tag to be disciplined
 * by, so the next bump has no anchor.
 *
 * Exit 1 on any violation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { failWithRepair } from "./lib/gate-report.js";

const ROOT = process.cwd();
const LOCKFILE = "pnpm-lock.yaml";
const IMAGE_RE =
  /^\s*FROM\s+(?:--platform=\S+\s+)?mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)(?:-\S+)?/;
const CLIENT_PACKAGES = ["playwright-core", "playwright"] as const;

interface ImagePin {
  dockerfile: string; // repo-relative
  line: number;
  version: string;
}

/** Every Dockerfile under the workspace groups, one level below each group root. */
function dockerfiles(): string[] {
  const found: string[] = [];
  for (const group of ["services", "apps", "packages"]) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const dir = join(base, entry);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) continue;
      for (const file of readdirSync(dir)) {
        if (/^Dockerfile(\..+)?$/.test(file)) found.push(relative(ROOT, join(dir, file)));
      }
    }
  }
  return found.sort();
}

function imagePins(dockerfile: string): ImagePin[] {
  const pins: ImagePin[] = [];
  const lines = readFileSync(join(ROOT, dockerfile), "utf8").split("\n");
  lines.forEach((text, i) => {
    const m = IMAGE_RE.exec(text);
    if (m?.[1]) pins.push({ dockerfile, line: i + 1, version: m[1] });
  });
  return pins;
}

/**
 * The version pnpm-lock.yaml resolves for a Playwright client inside ONE
 * importer (the service's own dependency block). Read from the `importers:`
 * section rather than the global `packages:` list so two services on
 * different Playwright versions are each held to their own truth.
 *
 *   importers:
 *     services/browser-sandbox:
 *       dependencies:
 *         playwright-core:
 *           specifier: ^1.62.1
 *           version: 1.62.1
 */
function resolvedClientVersion(
  lock: string,
  importerDir: string,
): { pkg: string; version: string } | null {
  const lines = lock.split("\n");
  const start = lines.findIndex((l) => l === `  ${importerDir}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i] ?? "") || /^\S/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  for (const pkg of CLIENT_PACKAGES) {
    for (let i = start + 1; i < end; i++) {
      if (lines[i] !== `      ${pkg}:`) continue;
      for (let j = i + 1; j < Math.min(i + 4, end); j++) {
        const m = /^\s+version:\s*(\d+\.\d+\.\d+)/.exec(lines[j] ?? "");
        if (m?.[1]) return { pkg, version: m[1] };
      }
    }
  }
  return null;
}

function main(): void {
  const lock = readFileSync(join(ROOT, LOCKFILE), "utf8");
  const files = dockerfiles();
  const violations: string[] = [];
  let pinnedFiles = 0;
  let pinCount = 0;
  const seen: string[] = [];

  for (const dockerfile of files) {
    const pins = imagePins(dockerfile);
    if (pins.length === 0) continue;
    pinnedFiles++;
    pinCount += pins.length;
    const importerDir = dockerfile.split("/").slice(0, 2).join("/");
    const resolved = resolvedClientVersion(lock, importerDir);
    if (resolved == null) {
      violations.push(
        `${dockerfile}: pins the Playwright image but ${LOCKFILE} resolves no ${CLIENT_PACKAGES.join("/")} for importer ${importerDir} — the tag has no anchor`,
      );
      continue;
    }
    seen.push(`${importerDir} → ${resolved.pkg}@${resolved.version}`);
    for (const pin of pins) {
      if (pin.version !== resolved.version) {
        violations.push(
          `${pin.dockerfile}:${pin.line}: image v${pin.version} ≠ ${resolved.pkg}@${resolved.version} resolved in ${LOCKFILE} (importer ${importerDir})`,
        );
      }
    }
  }

  if (violations.length > 0) {
    failWithRepair({
      invariant:
        "every `FROM mcr.microsoft.com/playwright:v<X.Y.Z>-…` stage must pin the exact version pnpm-lock.yaml resolves for that service's Playwright client — a newer client than the image exits 1 at boot, and browser-sandbox's always-on Fly machine then STOPS past its restart budget until the next deploy (2026-07-25, 2026-08-22)",
      sites: violations,
      canonical: `${LOCKFILE} (importers.<service>.dependencies.playwright-core.version — the version the bundle actually runs)`,
      fix: "Move every Playwright image tag in the listed Dockerfile to the lockfile's resolved version (both build AND runtime stages), or bump the service's playwright-core to match the image — and land both halves in ONE change. If a dependabot PR moved the lockfile, push the Dockerfile bump onto that PR before merging it.",
      doctrine: "docs/doctrine/composition-preserves-enforcement.md",
    });
  }

  console.log(
    `✓ Playwright image parity: ${files.length} Dockerfile(s) scanned, ${pinCount} image pin(s) in ${pinnedFiles} file(s) match their lockfile importers${seen.length > 0 ? ` (${seen.join("; ")})` : ""}.`,
  );
}

main();
