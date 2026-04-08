/**
 * `motebit ledger <goal_id>` — fetch and display a signed execution
 * ledger manifest from the relay.
 *
 * Extracted from `subcommands.ts` as Target 6 of the CLI extraction.
 * Uses a raw `fetch` rather than the shared `fetchRelayJson` helper
 * because it needs to handle the response body twice (structured JSON
 * for the happy path, raw text for the error path).
 */

import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";

export async function handleLedger(config: CliConfig): Promise<void> {
  const goalId = config.positionals[1];
  if (goalId == null || goalId === "") {
    console.error("Usage: motebit ledger <goal_id> [--json]");
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
  const syncToken = config.syncToken ?? process.env["MOTEBIT_SYNC_TOKEN"];
  if (syncUrl == null || syncUrl === "") {
    console.error(
      "Error: --sync-url or MOTEBIT_SYNC_URL is required to fetch ledger from the relay.",
    );
    process.exit(1);
  }

  const url = `${syncUrl.replace(/\/$/, "")}/agent/${motebitId}/ledger/${goalId}`;
  const headers: Record<string, string> = {};
  if (syncToken) {
    headers["Authorization"] = `Bearer ${syncToken}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: failed to reach relay: ${msg}`);
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`Error: relay returned ${res.status}: ${body}`);
    process.exit(1);
  }

  const manifest = (await res.json()) as Record<string, unknown>;

  if (config.json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  // Display formatted summary
  const timeline = Array.isArray(manifest.timeline) ? manifest.timeline : [];
  console.log();
  console.log(`  Execution Ledger`);
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  goal_id        ${String(manifest.goal_id)}`);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- plan_id is a string at runtime
  console.log(`  plan_id        ${String(manifest.plan_id ?? "—")}`);
  console.log(`  status         ${String(manifest.status)}`);
  console.log(
    `  started_at     ${manifest.started_at != null ? new Date(manifest.started_at as number).toISOString() : "—"}`,
  );
  console.log(
    `  completed_at   ${manifest.completed_at != null ? new Date(manifest.completed_at as number).toISOString() : "—"}`,
  );
  console.log(`  timeline       ${timeline.length} events`);
  console.log(
    `  content_hash   ${typeof manifest.content_hash === "string" ? manifest.content_hash.slice(0, 16) + "..." : "—"}`,
  );

  if (typeof manifest.signature === "string" && manifest.signature !== "") {
    console.log(`  signature      ${manifest.signature.slice(0, 16)}...`);
  } else {
    console.log(`  signature      (unsigned — relay-reconstructed)`);
  }
  console.log();
}
