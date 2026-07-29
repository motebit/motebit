/**
 * `motebit ledger <goal_id>` — fetch and display a signed execution
 * ledger manifest from the relay.
 *
 * Uses a raw `fetch` rather than the shared `fetchRelayJson` helper
 * because the error path reads the response body as text while the
 * happy path parses it as JSON.
 */

import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";
import { getRelayAuthHeaders, requireMotebitId } from "./_helpers.js";

export async function handleLedger(config: CliConfig): Promise<void> {
  const goalId = config.positionals[1];
  if (goalId == null || goalId === "") {
    console.error("Usage: motebit ledger <goal_id> [--json]");
    process.exit(1);
  }

  const motebitId = requireMotebitId(loadFullConfig());

  const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
  if (syncUrl == null || syncUrl === "") {
    console.error(
      "Error: --sync-url or MOTEBIT_SYNC_URL is required to fetch ledger from the relay.",
    );
    process.exit(1);
  }

  const url = `${syncUrl.replace(/\/$/, "")}/agent/${motebitId}/ledger/${goalId}`;
  const headers = await getRelayAuthHeaders(config);

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

  for (const line of renderLedgerSummary(manifest)) console.log(line);
}

/**
 * Pure render of a ledger manifest summary, shared by the shell
 * subcommand and the REPL's `/ledger` slash so the two surfaces show
 * the same execution record the same way.
 */
export function renderLedgerSummary(manifest: Record<string, unknown>): string[] {
  const timeline = Array.isArray(manifest.timeline) ? manifest.timeline : [];
  const lines: string[] = [""];
  lines.push(`  Execution Ledger`);
  lines.push(`  ${"─".repeat(50)}`);
  lines.push(`  goal_id        ${String(manifest.goal_id)}`);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- plan_id is a string at runtime
  lines.push(`  plan_id        ${String(manifest.plan_id ?? "—")}`);
  lines.push(`  status         ${String(manifest.status)}`);
  lines.push(
    `  started_at     ${manifest.started_at != null ? new Date(manifest.started_at as number).toISOString() : "—"}`,
  );
  lines.push(
    `  completed_at   ${manifest.completed_at != null ? new Date(manifest.completed_at as number).toISOString() : "—"}`,
  );
  lines.push(`  timeline       ${timeline.length} events`);
  lines.push(
    `  content_hash   ${typeof manifest.content_hash === "string" ? manifest.content_hash.slice(0, 16) + "..." : "—"}`,
  );

  if (typeof manifest.signature === "string" && manifest.signature !== "") {
    lines.push(`  signature      ${manifest.signature.slice(0, 16)}...`);
  } else {
    lines.push(`  signature      (unsigned — relay-reconstructed)`);
  }
  lines.push("");
  return lines;
}
