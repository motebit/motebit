/**
 * `motebit credentials` — list accumulated peer-issued credentials and
 * optionally generate a signed Verifiable Presentation bundle.
 *
 * Extracted from `subcommands.ts` as Target 7 of the CLI extraction.
 * Reads locally-persisted credentials from SQLite first, then merges
 * with any relay-held credentials (if a sync URL is configured), then
 * batch-queries the relay for revocation status before display.
 */

import { openMotebitDatabase } from "@motebit/persistence";
import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";
import { getDbPath } from "../runtime-factory.js";

export async function handleCredentials(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
  const syncToken = config.syncToken ?? process.env["MOTEBIT_SYNC_TOKEN"];

  const headers: Record<string, string> = {};
  if (syncToken) {
    headers["Authorization"] = `Bearer ${syncToken}`;
  }

  // Read locally-persisted peer-issued credentials from SQLite
  type CredRow = {
    credential_id: string;
    credential_type: string;
    credential: { issuer: string; credentialSubject: { id: string }; validFrom: string };
    issued_at: number;
  };
  let localCreds: CredRow[] = [];
  try {
    const dbPath = getDbPath(config.dbPath);
    const moteDb = await openMotebitDatabase(dbPath);
    const stored = moteDb.credentialStore.list(motebitId, undefined, 200);
    localCreds = stored.map((sc) => ({
      credential_id: sc.credential_id,
      credential_type: sc.credential_type,
      credential: JSON.parse(sc.credential_json) as CredRow["credential"],
      issued_at: sc.issued_at,
    }));
    moteDb.close();
  } catch {
    // Local store unavailable — continue with relay only
  }

  // If --presentation, fetch a bundled VP (relay required)
  if (config.presentation) {
    if (!syncUrl) {
      console.error(
        "Error: --sync-url or MOTEBIT_SYNC_URL is required for presentation generation.",
      );
      process.exit(1);
    }
    const url = `${syncUrl.replace(/\/$/, "")}/api/v1/agents/${motebitId}/presentation`;
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers });
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

    const vpBody = (await res.json()) as {
      presentation: Record<string, unknown>;
      credential_count: number;
      relay_did: string;
    };

    if (config.json) {
      console.log(JSON.stringify(vpBody, null, 2));
    } else {
      console.log();
      console.log(`  Verifiable Presentation`);
      console.log(`  ${"─".repeat(50)}`);
      console.log(`  holder          ${(vpBody.presentation.holder as string) ?? "—"}`);
      console.log(`  credentials     ${vpBody.credential_count}`);
      console.log(`  relay_did       ${vpBody.relay_did}`);
      console.log();
    }
    return;
  }

  // Default: list credentials — merge local + relay
  let relayCreds: CredRow[] = [];
  if (syncUrl) {
    const url = `${syncUrl.replace(/\/$/, "")}/api/v1/agents/${motebitId}/credentials`;
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        const credBody = (await res.json()) as { credentials: CredRow[] };
        relayCreds = credBody.credentials ?? [];
      }
    } catch {
      // Relay unreachable — local credentials still display
    }
  }

  // Deduplicate by credential_id
  const seen = new Set<string>();
  const allCreds: CredRow[] = [];
  for (const c of [...localCreds, ...relayCreds].sort((a, b) => b.issued_at - a.issued_at)) {
    if (!seen.has(c.credential_id)) {
      seen.add(c.credential_id);
      allCreds.push(c);
    }
  }

  if (config.json) {
    console.log(JSON.stringify({ motebit_id: motebitId, credentials: allCreds }, null, 2));
    return;
  }

  if (allCreds.length === 0) {
    console.log("No credentials found.");
    return;
  }

  const localCount = localCreds.length;
  const relayCount = relayCreds.length;
  const source =
    localCount > 0 && relayCount > 0
      ? `${localCount} local + ${relayCount} relay`
      : localCount > 0
        ? `${localCount} local`
        : `${relayCount} relay`;
  // Check revocation status via batch endpoint
  const revokedSet = new Set<string>();
  if (syncUrl && allCreds.length > 0) {
    try {
      const batchRes = await fetch(
        `${syncUrl.replace(/\/$/, "")}/api/v1/credentials/batch-status`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ credential_ids: allCreds.map((c) => c.credential_id) }),
        },
      );
      if (batchRes.ok) {
        const batchData = (await batchRes.json()) as {
          results: Array<{ credential_id: string; revoked: boolean }>;
        };
        for (const r of batchData.results) {
          if (r.revoked) revokedSet.add(r.credential_id);
        }
      }
    } catch {
      /* batch check failed — display without revocation status */
    }
  }

  console.log(`\nCredentials (${allCreds.length} — ${source}):\n`);
  console.log(
    "  ID        Type                         Issuer           Issued At           Status",
  );
  console.log("  " + "-".repeat(95));
  for (const cred of allCreds) {
    const id = cred.credential_id.slice(0, 8);
    const type = cred.credential_type.slice(0, 28).padEnd(28);
    const issuer = cred.credential.issuer.slice(0, 16);
    const issuedAt = new Date(cred.issued_at).toISOString().slice(0, 19);
    const status = revokedSet.has(cred.credential_id) ? "REVOKED" : "active";
    console.log(`  ${id}  ${type} ${issuer} ${issuedAt}  ${status}`);
  }
  console.log();
}
