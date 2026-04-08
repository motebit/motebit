/**
 * `motebit export` — bundle a motebit's identity, gradient, credentials,
 * presentation, OSSA manifest, and budget state into a directory for
 * sharing or migration.
 *
 * Extracted from the monolithic `subcommands.ts` as Target 2 of the CLI
 * extraction. The OSSA manifest generator is a private helper co-located
 * here because nothing else uses it. `fetchRelayJson` is imported from
 * the shared `_helpers.ts` module because federation/balance handlers
 * also use it.
 */

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { openMotebitDatabase } from "@motebit/persistence";
import { generate as generateIdentityFile } from "@motebit/identity-file";
import { hexPublicKeyToDidKey } from "@motebit/crypto";
import type { CliConfig } from "../args.js";
import { loadFullConfig, saveFullConfig } from "../config.js";
import {
  fromHex,
  promptPassphrase,
  encryptPrivateKey,
  decryptPrivateKey,
  bootstrapIdentity,
} from "../identity.js";
import { getDbPath } from "../runtime-factory.js";
import { fetchRelayJson, getRelayAuthHeaders } from "./_helpers.js";

export async function handleExport(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    escapeCodeTimeout: 50,
  });

  // Resolve passphrase
  const envPassphrase = process.env["MOTEBIT_PASSPHRASE"];
  let passphrase: string;

  if (fullConfig.cli_encrypted_key) {
    passphrase = envPassphrase ?? (await promptPassphrase(rl, "Passphrase: "));
    try {
      await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
    } catch {
      console.error("Error: incorrect passphrase.");
      console.error(
        "  Run `npm create motebit` to generate a new identity, or set MOTEBIT_PASSPHRASE env var.",
      );
      rl.close();
      process.exit(1);
    }
  } else if (fullConfig.cli_private_key != null && fullConfig.cli_private_key !== "") {
    passphrase =
      envPassphrase ?? (await promptPassphrase(rl, "Set a passphrase for key encryption: "));
    if (passphrase === "") {
      console.error("Error: passphrase cannot be empty.");
      rl.close();
      process.exit(1);
    }
    fullConfig.cli_encrypted_key = await encryptPrivateKey(fullConfig.cli_private_key, passphrase);
    delete fullConfig.cli_private_key;
    saveFullConfig(fullConfig);
  } else {
    passphrase =
      envPassphrase ?? (await promptPassphrase(rl, "Set a passphrase for your mote's key: "));
    if (!passphrase) {
      console.error("Error: passphrase cannot be empty.");
      rl.close();
      process.exit(1);
    }
  }

  // Bootstrap identity if needed
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  const { motebitId } = await bootstrapIdentity(moteDb, fullConfig, passphrase);

  // Reload config (may have been updated by bootstrap)
  const updatedConfig = loadFullConfig();

  // Decrypt private key
  if (!updatedConfig.cli_encrypted_key) {
    console.error("Error: no encrypted key found in config.");
    moteDb.close();
    rl.close();
    process.exit(1);
  }
  const privKeyHex = await decryptPrivateKey(updatedConfig.cli_encrypted_key, passphrase);
  const privateKey = fromHex(privKeyHex);
  const publicKeyHex = updatedConfig.device_public_key ?? "";

  // Collect device info
  const devices = [];
  if (
    updatedConfig.device_id != null &&
    updatedConfig.device_id !== "" &&
    updatedConfig.device_public_key != null &&
    updatedConfig.device_public_key !== ""
  ) {
    devices.push({
      device_id: updatedConfig.device_id,
      name: "cli",
      public_key: updatedConfig.device_public_key,
      registered_at: new Date().toISOString(),
    });
  }

  // Generate the identity file
  const identityContent = await generateIdentityFile(
    {
      motebitId,
      ownerId: motebitId,
      publicKeyHex,
      devices,
    },
    privateKey,
  );

  // Determine output directory
  const outputDir =
    config.output != null && config.output !== ""
      ? path.resolve(config.output)
      : path.resolve("motebit-export");

  fs.mkdirSync(outputDir, { recursive: true });

  // Track what was exported for the summary
  const exported: string[] = [];
  const skipped: string[] = [];

  // 1. Write identity file
  const identityPath = path.join(outputDir, "motebit.md");
  fs.writeFileSync(identityPath, identityContent, "utf-8");
  exported.push("identity");

  // 2. Gradient snapshot from local SQLite
  try {
    const latestGradient = moteDb.gradientStore.latest(motebitId);
    if (latestGradient) {
      const gradientPath = path.join(outputDir, "gradient.json");
      fs.writeFileSync(gradientPath, JSON.stringify(latestGradient, null, 2), "utf-8");
      exported.push("gradient snapshot");
    } else {
      skipped.push("gradient (no snapshots recorded)");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    skipped.push(`gradient (${msg})`);
  }

  // Done with local database
  moteDb.close();

  // Relay-dependent exports
  const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
  const headers = await getRelayAuthHeaders(config);
  const baseUrl = syncUrl ? syncUrl.replace(/\/$/, "") : null;

  if (!baseUrl) {
    skipped.push("credentials (no relay URL)");
    skipped.push("presentation (no relay URL)");
    skipped.push("budget (no relay URL)");
  } else {
    // 3. Credentials
    const credResult = await fetchRelayJson(
      `${baseUrl}/api/v1/agents/${motebitId}/credentials`,
      headers,
    );
    if (credResult.ok) {
      const credBody = credResult.data as {
        credentials?: Array<Record<string, unknown>>;
      };
      const creds = credBody.credentials ?? [];
      const credPath = path.join(outputDir, "credentials.json");
      fs.writeFileSync(credPath, JSON.stringify(creds, null, 2), "utf-8");
      exported.push(`${creds.length} credential${creds.length !== 1 ? "s" : ""}`);
    } else {
      skipped.push(`credentials (${credResult.error})`);
    }

    // 4. Presentation (signed VP bundle)
    const vpResult = await fetchRelayJson(
      `${baseUrl}/api/v1/agents/${motebitId}/presentation`,
      headers,
      "POST",
    );
    if (vpResult.ok) {
      const vpBody = vpResult.data as {
        presentation?: Record<string, unknown>;
        credential_count?: number;
      };
      const vpPath = path.join(outputDir, "presentation.json");
      fs.writeFileSync(vpPath, JSON.stringify(vpBody.presentation ?? vpBody, null, 2), "utf-8");
      const credCount = vpBody.credential_count ?? 0;
      exported.push(`presentation (${credCount} credential${credCount !== 1 ? "s" : ""})`);
    } else {
      skipped.push(`presentation (${vpResult.error})`);
    }

    // 5. OSSA manifest (derived from identity for cross-platform compatibility)
    try {
      const ossaManifest = generateOssaManifest(motebitId, publicKeyHex);
      const ossaPath = path.join(outputDir, "ossa-manifest.yaml");
      fs.writeFileSync(ossaPath, ossaManifest, "utf-8");
      exported.push("OSSA manifest");
    } catch {
      skipped.push("OSSA manifest (generation failed)");
    }

    // 6. Budget summary
    const budgetResult = await fetchRelayJson(`${baseUrl}/agent/${motebitId}/budget`, headers);
    if (budgetResult.ok) {
      const budgetPath = path.join(outputDir, "budget.json");
      fs.writeFileSync(budgetPath, JSON.stringify(budgetResult.data, null, 2), "utf-8");
      const budgetData = budgetResult.data as {
        allocations?: Array<Record<string, unknown>>;
      };
      const allocCount = budgetData.allocations?.length ?? 0;
      exported.push(`budget (${allocCount} allocation${allocCount !== 1 ? "s" : ""})`);
    } else {
      skipped.push(`budget (${budgetResult.error})`);
    }
  }

  // Print summary
  console.log(`\nExport complete: ${outputDir}\n`);
  if (exported.length > 0) {
    console.log(`  Exported: ${exported.join(", ")}`);
  }
  if (skipped.length > 0) {
    console.log(`  Skipped:  ${skipped.join(", ")}`);
  }
  if (updatedConfig.device_public_key) {
    try {
      console.log(`  DID:      ${hexPublicKeyToDidKey(updatedConfig.device_public_key)}`);
    } catch {
      // Non-fatal
    }
  }
  console.log();
  rl.close();
}

// ---------------------------------------------------------------------------
// OSSA manifest generation — maps motebit identity to OSSA contract layer.
// Private to this module; only handleExport uses it.
// ---------------------------------------------------------------------------

function generateOssaManifest(motebitId: string, publicKeyHex: string): string {
  const lines: string[] = [
    "# OSSA Agent Manifest — derived from motebit/identity@1.0",
    "# This is a compatibility view. The authoritative identity is motebit.md (signed).",
    "",
    "ossa_version: '1.0'",
    "",
    `name: motebit-${motebitId.slice(0, 8)}`,
    `description: Motebit sovereign agent ${motebitId.slice(0, 8)}`,
    "",
    "identity:",
    `  gaid: '${hexPublicKeyToDidKey(publicKeyHex)}'`,
    `  motebit_id: '${motebitId}'`,
    `  public_key: '${publicKeyHex}'`,
    "  verification:",
    "    method: Ed25519",
    "    spec: motebit/identity@1.0",
    "    verifier: '@motebit/verify'",
    "",
    "protocols:",
    "  mcp:",
    "    supported: true",
    "    transports: [stdio, http, streamable-http]",
    "  a2a:",
    "    supported: true",
    "    agent_card: '/.well-known/agent.json'",
    "  x402:",
    "    supported: true",
    "    settlement: USDC",
    "",
    "trust:",
    "  model: semiring",
    "  dimensions: [trust, cost, latency, reliability, regulatory_risk]",
    "  sybil_defense: 4-layer",
    "  credential_format: W3C VC 2.0 (eddsa-jcs-2022)",
    "",
    "governance:",
    "  source: motebit.md",
    "  enforcement: PolicyGate",
    "  privacy: fail-closed",
    "",
    "specs:",
    "  - motebit/identity@1.0",
    "  - motebit/execution-ledger@1.0",
    "  - motebit/relay-federation@1.0",
  ];
  return lines.join("\n") + "\n";
}
