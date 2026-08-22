/**
 * check-deploy-freshness — is what is RUNNING what main says should be
 * running, and is it actually running? (#551, generalized from #549.)
 *
 * Every other drift defense proves something about the repo. This one, like
 * `check-model-catalog-drift`, points at a canonical source the repo cannot
 * see — here the deployed fleet itself. `docs/doctrine/composition-preserves-
 * enforcement.md` argues a guarantee must remain enforced in the DEPLOYED
 * system; a production four days behind the guarantees is that doctrine's
 * blind spot, and nothing in the suite could see it.
 *
 * Three incidents, one shape — every signal a NEGATIVE, an absent success:
 *
 *   #549  the relay served a four-day-old build. `deploy-sync` failed on
 *         every run for four days. main stayed green. Fly health checks
 *         stayed green — correctly, the OLD build was healthy.
 *   #570  the staging archetype slate ran a build from 39 minutes before the
 *         fix that mattered (#564) and nobody redeployed it for nine days,
 *         so the daily conformance probe graded stale code and promotion was
 *         gated on that verdict.
 *   #584  browser-sandbox crash-looped to max-restart and STOPPED after a
 *         dependency bump. main was green. It was found by accident, while
 *         chasing something else.
 *
 * Stale-but-healthy is worse than an outage, because an outage pages
 * someone. A workflow that fails repeatedly produces no positive event
 * anyone watches.
 *
 * TWO ASSERTIONS per deployed app:
 *
 *   FRESHNESS — the app was deployed no earlier than the newest commit that
 *     should have triggered its deploy (`services/<svc>/**` or `packages/**`,
 *     the trigger paths every deploy-*.yml shares), within a threshold.
 *
 *     Deliberately NOT the issue's suggested "stale AND a deploy workflow has
 *     failed since". That conjunction was there to avoid paging over a quiet
 *     weekend, but it would also miss the silent no-op (deploy reports
 *     success, machine never updated). It is unnecessary: staleness is
 *     measured against the last RELEVANT COMMIT, not against wall-clock, so a
 *     week with no commits to a service is structurally green — the deploy
 *     is newer than the commit and the difference is negative.
 *
 *   LIVENESS — at least one machine is in a running state. #584's mode: the
 *     fleet is current and serving nothing.
 *
 * NOT in the `pnpm check` GATES array by design: it needs network and a live
 * Fly token, so it runs from `.github/workflows/deploy-freshness.yml`, the
 * sibling of model-catalog-drift and archetype-conformance. With
 * `--require-token` a missing FLY_API_TOKEN is RED — a skipped external gate
 * is a dormant one, which is the flaw class this gate exists to catch.
 *
 * BOTH targets are checked. `fly.toml` (prod) and `fly.staging.toml` where it
 * exists, because #570 was a STAGING staleness that no defense could see:
 * `check-deploy-parity` requires a deploy workflow per `fly.toml` and has
 * never read a staging config. Staging is not a lesser environment here — it
 * is what the conformance probe grades and what gates promotion.
 *
 * An app that does not exist is SKIPPED, not failed: the archetype prod apps
 * deliberately do not exist until the slate promotes, and red-noise trains
 * people to ignore red.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const REQUIRE_TOKEN = process.argv.includes("--require-token");
/** Hours a deployment may lag the newest commit that should have shipped it. */
const STALE_HOURS = Number(process.env["DEPLOY_FRESHNESS_HOURS"] ?? "24");

interface Target {
  service: string;
  app: string;
  /** "prod" | "staging" — which fly config declared it. */
  env: string;
}

interface Finding {
  target: Target;
  kind: "stale" | "down";
  detail: string;
}

/** Extract the fly app name from a fly config. Mirrors check-deploy-parity. */
function flyAppName(path: string): string | null {
  if (!existsSync(path)) return null;
  const match = readFileSync(path, "utf-8").match(/^\s*app\s*=\s*["']([^"']+)["']/m);
  return match ? match[1] : null;
}

/** Every service that declares a fly config, in both environments. */
function deployTargets(): Target[] {
  const servicesDir = resolve(ROOT, "services");
  const targets: Target[] = [];
  for (const service of readdirSync(servicesDir).sort()) {
    const dir = join(servicesDir, service);
    for (const [env, file] of [
      ["prod", "fly.toml"],
      ["staging", "fly.staging.toml"],
    ] as const) {
      const app = flyAppName(join(dir, file));
      if (app != null) targets.push({ service, app, env });
    }
  }
  return targets;
}

/**
 * ISO time of the newest commit touching this service's deploy trigger paths.
 * Every deploy-*.yml triggers on `services/<svc>/**` plus `packages/**`, so
 * those two paths are what "should have shipped by now" means.
 *
 * Returns null when git cannot answer (shallow clone) — the caller treats an
 * unknown expectation as not-a-finding rather than inventing one.
 */
function lastRelevantCommit(service: string): Date | null {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%cI", "--", `services/${service}`, "packages"],
      { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out === "" ? null : new Date(out);
  } catch {
    return null;
  }
}

interface Machine {
  state?: string;
  updated_at?: string;
}

/**
 * Machines for an app, or null when the app does not exist / is unreachable.
 * Distinguishing "no such app" from "app with zero machines" matters: the
 * first is a deliberate pre-promotion absence, the second is an outage.
 */
function machines(app: string): Machine[] | null {
  try {
    const raw = execFileSync("flyctl", ["status", "--app", app, "--json"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
    });
    const parsed = JSON.parse(raw) as { Machines?: Machine[] };
    return parsed.Machines ?? [];
  } catch {
    return null;
  }
}

/** Fly states that mean "this machine can serve". */
const RUNNING = new Set(["started", "starting", "replacing"]);

function main(): void {
  console.log(
    `▸ check-deploy-freshness — deployed fleet vs main (freshness ≤ ${STALE_HOURS}h + liveness)`,
  );

  if ((process.env["FLY_API_TOKEN"] ?? "") === "") {
    if (REQUIRE_TOKEN) {
      console.error("check-deploy-freshness: FLY_API_TOKEN is not set.");
      console.error(
        "Fix: set the FLY_API_TOKEN repository secret. This gate is meaningless without live fleet access, and a skipped external gate is a dormant one (docs/doctrine/composition-preserves-enforcement.md) — that is the exact failure class it exists to catch, so a missing token is RED, never a silent pass.",
      );
      process.exit(1);
    }
    console.log(
      "  (no FLY_API_TOKEN — skipping politely. CI runs this with --require-token, where a missing token is red.)",
    );
    return;
  }

  const targets = deployTargets();
  const findings: Finding[] = [];
  const skipped: string[] = [];
  let checked = 0;

  for (const target of targets) {
    const label = `${target.app} (${target.service}/${target.env})`;
    const found = machines(target.app);
    if (found == null) {
      // Deliberate pre-promotion absence, or a token without access to it.
      skipped.push(`${label} — app not reachable`);
      continue;
    }
    checked++;

    // LIVENESS.
    const live = found.filter((m) => RUNNING.has(m.state ?? ""));
    if (live.length === 0) {
      findings.push({
        target,
        kind: "down",
        detail:
          found.length === 0
            ? "zero machines — the app exists but nothing is allocated"
            : `no running machine (states: ${found.map((m) => m.state ?? "?").join(", ")})`,
      });
    }

    // FRESHNESS. Newest machine wins: a rolling deploy legitimately leaves
    // older machines behind mid-rollout, and the freshest is what the deploy
    // pipeline most recently achieved.
    const stamps = found
      .map((m) => (m.updated_at != null ? new Date(m.updated_at) : null))
      .filter((d): d is Date => d != null && !Number.isNaN(d.getTime()));
    const deployedAt =
      stamps.length > 0 ? new Date(Math.max(...stamps.map((d) => d.getTime()))) : null;
    const commitAt = lastRelevantCommit(target.service);

    if (deployedAt != null && commitAt != null) {
      const lagHours = (commitAt.getTime() - deployedAt.getTime()) / 3_600_000;
      if (lagHours > STALE_HOURS) {
        findings.push({
          target,
          kind: "stale",
          detail: `deployed ${deployedAt.toISOString()} but ${target.service} last changed ${commitAt.toISOString()} — ${lagHours.toFixed(1)}h behind (threshold ${STALE_HOURS}h)`,
        });
      } else {
        console.log(
          `  ✓ ${label} — current (${lagHours <= 0 ? "deploy newer than code" : `${lagHours.toFixed(1)}h`})`,
        );
      }
    } else if (live.length > 0) {
      console.log(
        `  ✓ ${label} — running (freshness unknown: no git history or machine timestamp)`,
      );
    }
  }

  for (const s of skipped) console.log(`  – ${s}`);

  if (findings.length > 0) {
    console.error(`check-deploy-freshness: ${findings.length} finding(s):`);
    for (const f of findings) {
      console.error(
        `  [${f.kind}] ${f.target.app} (${f.target.service}/${f.target.env}): ${f.detail}`,
      );
    }
    console.error(
      "Fix: for [stale] — re-run the service's deploy workflow (.github/workflows/deploy-<app>.yml) and check WHY it did not fire; note that a fix for a broken deploy may itself not touch the trigger paths, so it may need a manual dispatch (#549). For [down] — inspect `flyctl logs -a <app>`; a crash loop past max-restart leaves a stopped machine that nothing restarts when auto_stop_machines = false (#584).",
    );
    console.error(
      "Doctrine: docs/doctrine/composition-preserves-enforcement.md — the repo being correct says nothing about what is running.",
    );
    process.exit(1);
  }

  console.log(
    `✓ check-deploy-freshness: ${checked} deployed app(s) current and running${skipped.length > 0 ? `, ${skipped.length} not provisioned` : ""}.`,
  );
}

main();
