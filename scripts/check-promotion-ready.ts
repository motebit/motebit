#!/usr/bin/env tsx
/**
 * check-promotion-ready — is the archetype slate ready for staging → prod?
 *
 * The promotion state IS the conformance workflow's own scheduled-run
 * history (docs/doctrine/agent-archetypes.md §4: accept-on-proof): ready
 * when the last N (default 5) SCHEDULED runs of archetype-conformance.yml
 * all concluded success. Manual dispatches don't count — the discipline is
 * that the slate passes unattended, on the daily cadence, not when someone
 * is watching.
 *
 * Fail-closed on thin history: fewer than N scheduled runs on record (new
 * workflow, 90-day retention horizon, a rename) reads NOT READY — never
 * "probably fine".
 *
 * NOT a CI gate — an operator pre-flight for the human-dispatched promote
 * step. Requires `gh` authenticated.
 *
 *   npx tsx scripts/check-promotion-ready.ts        # N=5
 *   REQUIRED=3 npx tsx scripts/check-promotion-ready.ts
 */

import { execFileSync } from "node:child_process";

const REQUIRED = Number(process.env["REQUIRED"] ?? "5");
const WORKFLOW = "archetype-conformance.yml";

interface RunRow {
  conclusion: string | null;
  createdAt: string;
  event: string;
  url: string;
}

function main(): void {
  let raw: string;
  try {
    raw = execFileSync(
      "gh",
      [
        "run",
        "list",
        "--workflow",
        WORKFLOW,
        "--event",
        "schedule",
        "--limit",
        String(REQUIRED),
        "--json",
        "conclusion,createdAt,event,url",
      ],
      { encoding: "utf8" },
    );
  } catch (err) {
    console.error(
      `check-promotion-ready: could not read ${WORKFLOW} run history via gh (${err instanceof Error ? err.message : String(err)}).`,
    );
    console.error("NOT READY — unknown history is not green history.");
    process.exit(1);
  }

  const runs = JSON.parse(raw) as RunRow[];
  if (runs.length < REQUIRED) {
    console.error(
      `check-promotion-ready: only ${runs.length}/${REQUIRED} scheduled run(s) on record.`,
    );
    console.error(
      "NOT READY — thin history reads not-ready by design (new workflow / retention horizon / rename).",
    );
    process.exit(1);
  }

  const bad = runs.filter((r) => r.conclusion !== "success");
  if (bad.length > 0) {
    console.error(
      `check-promotion-ready: ${bad.length}/${runs.length} of the last scheduled runs did not succeed:`,
    );
    for (const r of bad) console.error(`  ${r.createdAt}  ${r.conclusion ?? "pending"}  ${r.url}`);
    console.error("NOT READY.");
    process.exit(1);
  }

  console.log(
    `✓ check-promotion-ready: last ${runs.length} scheduled conformance runs all green (${runs[runs.length - 1]!.createdAt} → ${runs[0]!.createdAt}).`,
  );
  console.log(
    "READY — promote with: RUN=1 TARGET=prod npx tsx scripts/deploy-archetype-slate.ts (production environment reviewers apply).",
  );
}

main();
