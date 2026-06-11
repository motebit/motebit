/**
 * check-changeset-required — a published-package SOURCE change MUST carry a changeset.
 *
 * The release flow (changesets → "Version Packages" PR → publish) only bumps a
 * package when a changeset names it. A PR that edits a PUBLISHED package's source
 * without adding a changeset silently ships an unreleased change: the fix lands on
 * `main` but never reaches npm until something else happens to bump that package
 * via the patch cascade. This is the PRESENCE half of changeset hygiene; the
 * companions are `check-changeset-discipline` (quality: non-empty body, migration
 * section, no mixed bumps) and `check-api-surface` (a public API change needs a
 * `major`). This gate adds: an internal, non-API published change still needs SOME
 * changeset.
 *
 * Scope is deliberately narrow so it never fires on legitimately changeset-free
 * PRs (docs, tests, CI, services — none of which publish):
 *
 *   A changed file requires a changeset IFF it lives under a PUBLISHED package's
 *   `src/` tree and is not itself a test. "Published" = a workspace `package.json`
 *   without `private: true` (the same definition `check-doc-counts` derives) — so
 *   the set stays correct as packages are added or flipped private, no hardcoded
 *   list to drift.
 *
 * An empty changeset (`---` / `---`) satisfies the gate, so a deliberate
 * no-release change (e.g. a comment-only edit) is always expressible — the gate
 * forces the DECISION to be explicit, never the release.
 *
 * PR-only (needs a diff against the base), so it runs in the `changeset` CI job,
 * NOT in `pnpm check`. The base ref defaults to `origin/main` and can be
 * overridden with `CHANGESET_BASE_REF`.
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_REF = process.env.CHANGESET_BASE_REF ?? "origin/main";

/** Directories (relative to ROOT) of every published — non-private — workspace package. */
function publishedPackageDirs(): string[] {
  const dirs: string[] = [];
  for (const parent of ["packages", "apps", "services"]) {
    let entries: string[];
    try {
      entries = readdirSync(resolve(ROOT, parent));
    } catch {
      continue;
    }
    for (const sub of entries) {
      if (sub.startsWith(".")) continue;
      try {
        const pkg = JSON.parse(
          readFileSync(resolve(ROOT, parent, sub, "package.json"), "utf-8"),
        ) as { private?: boolean };
        if (pkg.private !== true) dirs.push(`${parent}/${sub}`);
      } catch {
        // no package.json (e.g. packages/github-action) → not a publishable package
      }
    }
  }
  return dirs;
}

function changedFiles(): string[] {
  const out = execSync(`git diff --name-only ${BASE_REF}...HEAD`, { cwd: ROOT, encoding: "utf-8" });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function hasChangeset(files: string[]): boolean {
  return files.some(
    (f) => f.startsWith(".changeset/") && f.endsWith(".md") && !f.endsWith("README.md"),
  );
}

/** A published-package source file that warrants a release. Excludes tests. */
function isPublishedSource(file: string, publishedDirs: string[]): boolean {
  const dir = publishedDirs.find((d) => file.startsWith(`${d}/src/`));
  if (!dir) return false;
  if (file.includes("/__tests__/")) return false;
  if (/\.test\.tsx?$/.test(file)) return false;
  return /\.(ts|tsx|js|jsx)$/.test(file);
}

function main(): void {
  let files: string[];
  try {
    files = changedFiles();
  } catch (err) {
    process.stdout.write(
      `check-changeset-required: could not diff against ${BASE_REF} ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Ensure the base ref is fetched (CI uses fetch-depth: 0).\n`,
    );
    process.exit(1);
  }

  const publishedDirs = publishedPackageDirs();
  const publishedSrcChanges = files.filter((f) => isPublishedSource(f, publishedDirs));

  if (publishedSrcChanges.length === 0) {
    process.stdout.write(
      "✓ check-changeset-required: no published-package source changed; a changeset is not required.\n",
    );
    return;
  }

  if (hasChangeset(files)) {
    process.stdout.write(
      `✓ check-changeset-required: ${publishedSrcChanges.length} published-package source file(s) changed and a changeset is present.\n`,
    );
    return;
  }

  const touchedPkgs = [
    ...new Set(
      publishedSrcChanges.map((f) => publishedDirs.find((d) => f.startsWith(`${d}/src/`))!),
    ),
  ].sort();
  process.stdout.write(
    "✗ check-changeset-required: published-package source changed without a changeset.\n\n" +
      `  Published packages touched:\n${touchedPkgs.map((p) => `    - ${p}`).join("\n")}\n\n` +
      `  Source files:\n${publishedSrcChanges.map((f) => `    - ${f}`).join("\n")}\n\n` +
      "  Run `pnpm changeset` and commit the result so the change reaches npm.\n" +
      "  For a deliberate no-release change, add an empty changeset (`---` / `---`).\n",
  );
  process.exit(1);
}

main();
