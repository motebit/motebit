/**
 * An identity's registry row is delisted, never deleted (#703).
 *
 * `agent_registry` holds two facts with two lifetimes: discoverability
 * (endpoint, capabilities, the heartbeat lease), which rightly leaves when
 * the agent departs or falls silent, and identity key state (the current
 * key, the guardian, settlement configuration), which must leave only by
 * revocation — and revocation keeps the row too, marked. Until 2026-09-24
 * the shorter lifetime won: `DELETE /agents/deregister` and the 90-day
 * janitor both ran `DELETE FROM agent_registry`, and the CLI daemon
 * deregisters on every shutdown, so a routine restart discarded the
 * guardian and the key and produced the "relay holds no key" state that
 * #701 needed. `services/relay/src/registry-delist.ts` is now the one
 * writer for leaving the shelf, and every door calls it.
 *
 * Why a gate and not a review: nothing fails when a door deletes. The
 * request returns ok, discover is empty as expected, the tests pass, and
 * the only thing wrong is that the relay has forgotten who someone is —
 * which no unit test on that door measures until the guardian is needed.
 * Same permanent-structural-lock shape as `check-relay-frame-origin`.
 *
 * Rule: no `DELETE FROM agent_registry` in relay source. Tests are
 * excluded (they may clear fixtures). A statement assembled at runtime is
 * outside the aperture, and the summary says so.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { failWithRepair } from "./lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCAN_ROOT = "services/relay/src";
const FORBIDDEN = /\bDELETE\s+FROM\s+agent_registry\b/i;

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

function main(): void {
  let scanned = 0;
  const sites: string[] = [];
  for (const file of walk(join(ROOT, SCAN_ROOT))) {
    scanned++;
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((line, i) => {
      // A comment that names the forbidden statement is prose, not a write.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (FORBIDDEN.test(line)) sites.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  }

  if (sites.length > 0) {
    failWithRepair({
      invariant: `check-registry-never-deleted: ${sites.length} statement(s) DELETE an agent_registry row — a departed or silent identity must be DELISTED, never forgotten (#703)`,
      canonical: "services/relay/src/registry-delist.ts",
      fix: "Replace the DELETE with `delistRegistration(db, motebitId, now)` (one identity) or `delistExpired(db, now)` (the lease sweep) from services/relay/src/registry-delist.ts — they clear endpoint_url/capabilities and set delisted_at while keeping public_key, guardian_public_key and the settlement columns. A revocation door writes `revoked = 1` together with the same clause, spelled out so check-identity-authority-writers can see it. If the row truly must go (a test fixture, a migration scrub), put it under __tests__ or state the reason in the migration and name it here.",
      sites,
      doctrine:
        "docs/proposals/identity-key-state-v1.md §3 (two facts, two lifetimes) and docs/doctrine/identity-binding-verification.md",
    });
  }

  console.log(
    `✓ check-registry-never-deleted: ${scanned} file(s) scanned under ${SCAN_ROOT} (excluding __tests__/dist) — no DELETE FROM agent_registry. Blind to a statement assembled at runtime.`,
  );
}

main();
