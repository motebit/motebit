#!/usr/bin/env tsx
/**
 * check-publishable-package-metadata — every publishable `package.json`
 * MUST carry the canonical metadata block npm + sigstore provenance
 * require: `repository.type === "git"`, `repository.url ===
 * "https://github.com/motebit/motebit"`, `repository.directory` matching
 * the package's path relative to repo root, and a `license` field.
 *
 * Pre-this-gate: the metadata block lived in 6+ shipping package.json
 * files as a copy-paste convention, with no structural enforcement.
 * `@motebit/state-export-client@0.2.0` shipped on 2026-05-13 without
 * `repository.url`; sigstore provenance refused to attest the publish
 * (`"could not resolve provenance metadata"`), the publish failed mid-
 * pipeline, and the fix was applied by hand to one file. Without this
 * gate, the next publishable package introduced (or the next time a
 * `repository` block gets accidentally dropped under an editor refactor)
 * fails the same way at the same point in the release pipeline.
 *
 * The gate has four failure modes, grouped in output:
 *   1. missing_repository — no `repository` block at all.
 *   2. malformed_repository — `repository` exists but `type` or `url`
 *      is wrong, or `directory` is missing.
 *   3. directory_mismatch — `repository.directory` value does NOT match
 *      the package's actual path relative to repo root.
 *   4. missing_license — no `license` field. (SPDX validity is the
 *      sibling gate `check-license-doc-sync`'s job; this gate just
 *      enforces presence.)
 *
 * Scope: every direct subdirectory of `packages/`, `apps/`, `services/`
 * that has a `package.json` where `private !== true` AND
 * `version !== "0.0.0-private"`. The set is derived from the filesystem
 * — no hardcoded list — so a new publishable package picks up the
 * enforcement automatically.
 *
 * Same closed-registry / structural-lock shape as `check-suite-declared`
 * (#10), `check-audience-canonical` (#46), `check-artifact-type-
 * canonical` (#85), `check-state-export-signed` (#86),
 * `check-transparency-processors-canonical` (#92): the gate asks role
 * questions (does this publishable package have the metadata sigstore
 * needs?), not instance questions.
 *
 * Doctrine: `docs/doctrine/promoting-private-to-public.md` (publishable-
 * package contract); `docs/doctrine/release-versioning.md` (versions are
 * promises — publish metadata is part of the promise).
 *
 * Usage:
 *   tsx scripts/check-publishable-package-metadata.ts        # exit 1 on violation
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

const SCAN_ROOTS = ["packages", "apps", "services"] as const;

const CANONICAL_REPOSITORY_URL = "https://github.com/motebit/motebit";
const CANONICAL_REPOSITORY_TYPE = "git";

interface PackageInfo {
  /** Absolute path to the package directory. */
  dir: string;
  /** Path relative to repo root (e.g. `packages/state-export-client`). */
  relativeDir: string;
  /** npm package name. */
  name: string;
  /** Version string. */
  version: string;
  /** Parsed `package.json` payload. */
  raw: Record<string, unknown>;
}

interface Finding {
  kind: "missing_repository" | "malformed_repository" | "directory_mismatch" | "missing_license";
  packageName: string;
  detail: string;
}

/**
 * Walk `packages/`, `apps/`, `services/` and return every package whose
 * `package.json` is neither `"private": true` nor `"0.0.0-private"`.
 */
function discoverPublishablePackages(): ReadonlyArray<PackageInfo> {
  const out: PackageInfo[] = [];
  for (const top of SCAN_ROOTS) {
    const topDir = resolve(REPO_ROOT, top);
    if (!existsSync(topDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(topDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = resolve(topDir, entry);
      const pj = resolve(dir, "package.json");
      if (!existsSync(pj)) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const raw = JSON.parse(readFileSync(pj, "utf-8")) as Record<string, unknown>;
      const name = typeof raw.name === "string" ? raw.name : undefined;
      const version = typeof raw.version === "string" ? raw.version : undefined;
      if (!name || !version) continue;
      if (raw.private === true) continue;
      if (version === "0.0.0-private") continue;
      out.push({
        dir,
        relativeDir: relative(REPO_ROOT, dir),
        name,
        version,
        raw,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

interface RepositoryShape {
  type?: unknown;
  url?: unknown;
  directory?: unknown;
}

function isRepositoryObject(value: unknown): value is RepositoryShape {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function analyzePackage(pkg: PackageInfo): Finding[] {
  const findings: Finding[] = [];

  // 1. Repository block presence + shape.
  const repository = pkg.raw.repository;
  if (repository === undefined || repository === null) {
    findings.push({
      kind: "missing_repository",
      packageName: pkg.name,
      detail: `${pkg.relativeDir}/package.json — no \`repository\` block. Add: { "type": "${CANONICAL_REPOSITORY_TYPE}", "url": "${CANONICAL_REPOSITORY_URL}", "directory": "${pkg.relativeDir}" }`,
    });
  } else if (!isRepositoryObject(repository)) {
    findings.push({
      kind: "malformed_repository",
      packageName: pkg.name,
      detail: `${pkg.relativeDir}/package.json — \`repository\` must be an object, got ${typeof repository}.`,
    });
  } else {
    const problems: string[] = [];
    if (repository.type !== CANONICAL_REPOSITORY_TYPE) {
      problems.push(
        `\`repository.type\` is ${JSON.stringify(repository.type)}, must be "${CANONICAL_REPOSITORY_TYPE}"`,
      );
    }
    if (repository.url !== CANONICAL_REPOSITORY_URL) {
      problems.push(
        `\`repository.url\` is ${JSON.stringify(repository.url)}, must be "${CANONICAL_REPOSITORY_URL}" (sigstore provenance rejects publishes without the canonical URL — see state-export-client@0.2.0 incident 2026-05-13)`,
      );
    }
    if (repository.directory === undefined || repository.directory === null) {
      problems.push(
        `\`repository.directory\` is missing, must be "${pkg.relativeDir}" (npm uses this to render the per-package source link on the registry page)`,
      );
    } else if (typeof repository.directory !== "string") {
      problems.push(
        `\`repository.directory\` is ${typeof repository.directory}, must be a string equal to "${pkg.relativeDir}"`,
      );
    } else if (repository.directory !== pkg.relativeDir) {
      findings.push({
        kind: "directory_mismatch",
        packageName: pkg.name,
        detail: `${pkg.relativeDir}/package.json — \`repository.directory\` is "${repository.directory}" but the package lives at "${pkg.relativeDir}". Fix the field to match the path (the npm registry uses this to deep-link to source).`,
      });
    }
    if (problems.length > 0) {
      findings.push({
        kind: "malformed_repository",
        packageName: pkg.name,
        detail: `${pkg.relativeDir}/package.json — ${problems.join("; ")}.`,
      });
    }
  }

  // 2. License presence (any value — SPDX validity belongs to
  //    check-license-doc-sync).
  const license = pkg.raw.license;
  if (license === undefined || license === null || license === "") {
    findings.push({
      kind: "missing_license",
      packageName: pkg.name,
      detail: `${pkg.relativeDir}/package.json — no \`license\` field. Every publishable package MUST declare its license (Apache-2.0 for permissive-floor packages, BUSL-1.1 for accumulated-state packages).`,
    });
  }

  return findings;
}

function main(): void {
  const packages = discoverPublishablePackages();
  const findings: Finding[] = [];
  for (const pkg of packages) {
    findings.push(...analyzePackage(pkg));
  }

  console.log(
    `check-publishable-package-metadata — scanned ${SCAN_ROOTS.length} root(s)\n` +
      `  ${packages.length} publishable package(s) (private !== true AND version !== "0.0.0-private")\n`,
  );

  if (findings.length === 0) {
    console.log(
      `✓ Every publishable package declares the canonical metadata block:\n` +
        `    repository.type === "${CANONICAL_REPOSITORY_TYPE}"\n` +
        `    repository.url === "${CANONICAL_REPOSITORY_URL}"\n` +
        `    repository.directory matches the package path\n` +
        `    license field present\n` +
        `  Sigstore provenance has the metadata it needs to attest every publish.`,
    );
    return;
  }

  console.log(`✗ Publishable-package metadata drift:\n`);
  const byKind = findings.reduce<Record<string, Finding[]>>((acc, f) => {
    (acc[f.kind] ??= []).push(f);
    return acc;
  }, {});
  for (const kind of [
    "missing_repository",
    "malformed_repository",
    "directory_mismatch",
    "missing_license",
  ] as const) {
    const group = byKind[kind];
    if (!group || group.length === 0) continue;
    console.log(`  [${kind}] (${group.length})`);
    for (const f of group) console.log(`    - ${f.detail}`);
    console.log();
  }
  console.log(
    `  Doctrine: docs/doctrine/promoting-private-to-public.md (publishable-package contract);\n` +
      `  docs/doctrine/release-versioning.md (publish metadata is part of the version promise).\n` +
      `  Why this gate exists: state-export-client@0.2.0 (2026-05-13) shipped without\n` +
      `  \`repository.url\`; sigstore provenance refused to attest the publish. Fix the\n` +
      `  package.json files named above so the next publishable package never repeats it.\n`,
  );
  process.exit(1);
}

main();
