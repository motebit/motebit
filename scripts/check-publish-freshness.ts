/**
 * check-publish-freshness — is what npm SERVES what main says it should
 * serve? (#161, the fourth EXTERNAL drift gate.)
 *
 * `check-deploy-freshness` asks whether the repo is what is RUNNING;
 * `check-image-provenance` asks whether it is what is DISTRIBUTED as an
 * image. This one asks whether it is what is INSTALLED: for every public
 * workspace package, the registry's `dist-tags.latest` must equal the
 * version main's manifest declares.
 *
 * The incident (2026-09-23): the npm granular token expired on Aug 21. Every
 * Release run between Aug 11 and Sep 23 was GREEN, because each took the
 * "update the Version Packages PR" path and never tried to publish. The
 * first real publish attempt — the Tuesday train merging #631 — failed
 * `E404 Not Found - PUT registry.npmjs.org/@motebit/...` on twelve packages
 * that exist (npm answers 404, not 403, to an unauthorized scoped PUT). Six
 * runs failed the same way; then a fresh changeset flipped the workflow back
 * to the PR-update path and it went green again with nothing published. Six
 * weeks of releases sat on main while `npm install motebit` served 1.13.2.
 * Nothing in the suite could see it: the workflow's success is a statement
 * about the workflow, not about the registry.
 *
 * One assertion per publishable package, with one grace: a manifest whose
 * version was bumped less than PUBLISH_FRESHNESS_HOURS ago is PENDING, not
 * behind — the train merges the version bump and publishes minutes later,
 * and a gate that reds in that window trains people to ignore red. Measured
 * against the commit that introduced the version string, never wall-clock,
 * so a quiet month is structurally green.
 *
 * Findings, each a different repair:
 *   behind       registry older than main — a publish that did not happen.
 *   unpublished  public manifest the registry has never seen.
 *   ahead        registry NEWER than main — something published outside CI.
 *   unreachable  the registry did not answer (red only with --require-registry).
 *
 * NOT in the `pnpm check` GATES array by design: it needs the network, so it
 * runs daily from `.github/workflows/publish-freshness.yml` with
 * `--require-registry` — an unreachable registry is RED there, because a
 * skipped external gate is a dormant one. No secret: reading dist-tags needs
 * none.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parsePendingHours,
  runPublishFreshness,
  type Bump,
  type PublishablePackage,
} from "./lib/publish-freshness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The commit that gave the manifest its current version, and the version the
 * manifest carried before it. Null when git cannot answer (shallow clone, or
 * a version that was never committed) — and an unknown bump is no grace.
 */
function versionBumpedAt(pkg: PublishablePackage): Bump | null {
  const path = `${pkg.dir}/package.json`;
  const sha = git(["log", "-1", "--format=%H", `-S"version": "${pkg.version}"`, "--", path]);
  if (sha === null || sha === "") return null;
  const when = git(["show", "-s", "--format=%cI", sha]);
  if (when === null) return null;
  const at = new Date(when);
  if (Number.isNaN(at.getTime())) return null;
  const before = git(["show", `${sha}^:${path}`]);
  let previous: string | null = null;
  if (before !== null) {
    try {
      const v = (JSON.parse(before) as { version?: unknown }).version;
      previous = typeof v === "string" ? v : null;
    } catch {
      previous = null;
    }
  }
  return { at, previous };
}

const hours = parsePendingHours(process.env["PUBLISH_FRESHNESS_HOURS"]);
if (!hours.ok) {
  console.error(`check-publish-freshness: ${hours.reason}.`);
  console.error(
    "Fix: set PUBLISH_FRESHNESS_HOURS to a plain number of hours (e.g. `6`, or `0` for no grace) in .github/workflows/publish-freshness.yml or the shell; scripts/lib/publish-freshness.ts `parsePendingHours` is the reader.",
  );
  process.exit(1);
}

runPublishFreshness({
  root: ROOT,
  registry: process.env["PUBLISH_FRESHNESS_REGISTRY"] ?? "https://registry.npmjs.org",
  requireRegistry: process.argv.includes("--require-registry"),
  pendingHours: hours.hours,
  fetch: (url, init) => fetch(url, init),
  versionBumpedAt,
  now: () => Date.now(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
})
  .then((r) => process.exit(r.code))
  .catch((err: unknown) => {
    console.error(`check-publish-freshness: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
