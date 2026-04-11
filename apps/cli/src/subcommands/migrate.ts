/**
 * `motebit migrate --to <relay-url>` — migrate this agent to another relay.
 *
 * Drives the full migration lifecycle (migration-v1.md):
 *   1. Initiate migration → receive MigrationToken
 *   2. Fetch DepartureAttestation from source relay
 *   3. Export CredentialBundle from source relay
 *   4. Submit MigrationPresentation to destination relay
 *   5. Confirm departure on source relay
 *
 * Also supports:
 *   `motebit migrate cancel` — cancel an in-progress migration
 *   `motebit migrate status` — check migration state
 */

import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";
import { getRelayUrl, getRelayAuthHeaders, requireMotebitId } from "./_helpers.js";

export async function handleMigrate(config: CliConfig): Promise<void> {
  const subCmd = config.positionals[1];

  if (subCmd === "cancel") {
    await handleMigrateCancel(config);
    return;
  }

  if (subCmd === "status") {
    await handleMigrateStatus(config);
    return;
  }

  // Main migration flow
  const destinationUrl = config.destination;
  if (!destinationUrl) {
    console.error("Usage: motebit migrate --destination <relay-url>");
    console.error("       motebit migrate cancel");
    console.error("       motebit migrate status");
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = requireMotebitId(fullConfig);
  const sourceRelayUrl = getRelayUrl(config);
  const sourceHeaders = await getRelayAuthHeaders(config, { json: true });

  console.log(`\nMigrating ${motebitId}`);
  console.log(`  From: ${sourceRelayUrl}`);
  console.log(`  To:   ${destinationUrl}`);

  // === Step 1: Initiate migration on source relay ===
  console.log("\n[1/5] Initiating migration...");
  const initiateRes = await fetch(`${sourceRelayUrl}/api/v1/agents/${motebitId}/migrate`, {
    method: "POST",
    headers: { ...sourceHeaders, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      destination_relay: destinationUrl,
      reason: config.reason ?? "CLI migration",
    }),
  });

  if (!initiateRes.ok) {
    const text = await initiateRes.text();
    console.error(`Failed to initiate migration (${initiateRes.status}): ${text.slice(0, 200)}`);
    process.exit(1);
  }

  const { migration_token } = (await initiateRes.json()) as {
    migration_token: {
      token_id: string;
      motebit_id: string;
      source_relay_id: string;
      source_relay_url: string;
      expires_at: number;
      signature: string;
    };
  };
  console.log(`  Token: ${migration_token.token_id}`);
  console.log(`  Expires: ${new Date(migration_token.expires_at).toISOString()}`);

  // === Step 2: Fetch departure attestation ===
  console.log("\n[2/5] Fetching departure attestation...");
  const attestRes = await fetch(
    `${sourceRelayUrl}/api/v1/agents/${motebitId}/migration/attestation`,
    { headers: sourceHeaders },
  );

  if (!attestRes.ok) {
    const text = await attestRes.text();
    console.error(`Failed to get attestation (${attestRes.status}): ${text.slice(0, 200)}`);
    process.exit(1);
  }

  const { departure_attestation } = (await attestRes.json()) as {
    departure_attestation: {
      motebit_id: string;
      trust_level: string;
      successful_tasks: number;
      failed_tasks: number;
      credentials_issued: number;
      balance_at_departure: number;
      signature: string;
    };
  };
  console.log(`  Trust:       ${departure_attestation.trust_level}`);
  console.log(
    `  Tasks:       ${departure_attestation.successful_tasks} ok / ${departure_attestation.failed_tasks} failed`,
  );
  console.log(`  Credentials: ${departure_attestation.credentials_issued}`);

  // === Step 3: Export credential bundle ===
  console.log("\n[3/5] Exporting credentials...");
  const exportRes = await fetch(`${sourceRelayUrl}/api/v1/agents/${motebitId}/migration/export`, {
    headers: sourceHeaders,
  });

  if (!exportRes.ok) {
    const text = await exportRes.text();
    console.error(`Failed to export credentials (${exportRes.status}): ${text.slice(0, 200)}`);
    process.exit(1);
  }

  const { credential_bundle } = (await exportRes.json()) as {
    credential_bundle: {
      motebit_id: string;
      credentials: unknown[];
      anchor_proofs: unknown[];
      key_succession: unknown[];
    };
  };
  console.log(`  Credentials:   ${credential_bundle.credentials.length}`);
  console.log(`  Anchor proofs: ${credential_bundle.anchor_proofs.length}`);
  console.log(`  Key history:   ${credential_bundle.key_succession.length}`);

  // === Step 4: Submit to destination relay ===
  console.log("\n[4/5] Submitting to destination relay...");

  // Read the agent's public key from the source relay
  const agentRes = await fetch(`${sourceRelayUrl}/api/v1/agents/${motebitId}`, {
    headers: sourceHeaders,
  });
  let publicKey = "";
  if (agentRes.ok) {
    const agentData = (await agentRes.json()) as { public_key?: string };
    publicKey = agentData.public_key ?? "";
  }

  const acceptRes = await fetch(`${destinationUrl}/api/v1/agents/accept-migration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      migration_token,
      departure_attestation,
      credential_bundle: {
        ...credential_bundle,
        bundle_hash: "",
        signature: "",
      },
      motebit_id: motebitId,
      public_key: publicKey,
    }),
  });

  if (!acceptRes.ok) {
    const text = await acceptRes.text();
    console.error(
      `Destination relay rejected migration (${acceptRes.status}): ${text.slice(0, 200)}`,
    );
    console.error("\nMigration token is still valid. You can retry or cancel:");
    console.error("  motebit migrate cancel");
    process.exit(1);
  }

  const acceptData = (await acceptRes.json()) as {
    motebit_id: string;
    trust_level: string;
  };
  console.log(`  Accepted as: ${acceptData.motebit_id}`);
  console.log(`  Trust seed:  ${acceptData.trust_level}`);

  // === Step 5: Confirm departure on source relay ===
  console.log("\n[5/5] Confirming departure...");
  const departRes = await fetch(`${sourceRelayUrl}/api/v1/agents/${motebitId}/migrate/depart`, {
    method: "POST",
    headers: sourceHeaders,
  });

  if (!departRes.ok) {
    const text = await departRes.text();
    console.error(
      `Warning: departure confirmation failed (${departRes.status}): ${text.slice(0, 200)}`,
    );
    console.error("Migration completed on destination but source may still list you as active.");
  } else {
    console.log("  Departed from source relay.");
  }

  console.log(`\nMigration complete.`);
  console.log(`Update your config to point to the new relay:`);
  console.log(`  motebit config set sync_url ${destinationUrl}`);
  console.log();
}

async function handleMigrateCancel(config: CliConfig): Promise<void> {
  const motebitId = requireMotebitId(loadFullConfig());
  const relayUrl = getRelayUrl(config);
  const headers = await getRelayAuthHeaders(config, { json: true });

  const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/migrate/cancel`, {
    method: "POST",
    headers,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Failed to cancel migration (${res.status}): ${text.slice(0, 200)}`);
    process.exit(1);
  }

  console.log("Migration cancelled.");
}

async function handleMigrateStatus(config: CliConfig): Promise<void> {
  const motebitId = requireMotebitId(loadFullConfig());
  const relayUrl = getRelayUrl(config);
  const headers = await getRelayAuthHeaders(config);

  // Check for active migration token by trying to get attestation
  const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/migration/attestation`, {
    headers,
  });

  if (res.status === 404) {
    console.log("No active migration.");
    return;
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(`Failed to check migration status (${res.status}): ${text.slice(0, 200)}`);
    process.exit(1);
  }

  const { departure_attestation } = (await res.json()) as {
    departure_attestation: {
      motebit_id: string;
      trust_level: string;
      successful_tasks: number;
      failed_tasks: number;
      credentials_issued: number;
      balance_at_departure: number;
    };
  };

  console.log(`\nActive migration for ${motebitId}`);
  console.log(`  Trust:       ${departure_attestation.trust_level}`);
  console.log(
    `  Tasks:       ${departure_attestation.successful_tasks} ok / ${departure_attestation.failed_tasks} failed`,
  );
  console.log(`  Credentials: ${departure_attestation.credentials_issued}`);
  console.log(`  Balance:     ${departure_attestation.balance_at_departure}`);
  console.log(`\nTo complete: motebit migrate --destination <relay-url>`);
  console.log(`To cancel:   motebit migrate cancel`);
  console.log();
}
