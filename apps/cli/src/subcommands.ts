// --- CLI subcommand handlers (non-REPL) ---
//
// This file is being progressively extracted into `./subcommands/{topic}.ts`
// files, following the same leaves-first pattern used for the desktop,
// mobile, spatial, and runtime extractions. Each extracted topic is
// re-exported from the block at the top of this file so the one
// importer (`./index.ts`) doesn't need to change. When extraction is
// complete this file becomes a ~30-line barrel.

// Extracted topics (re-export barrel)
export { handleDoctor } from "./subcommands/doctor.js";
export { handleExport } from "./subcommands/export.js";
export {
  handleGoalAdd,
  handleGoalList,
  handleGoalOutcomes,
  handleGoalRemove,
  handleGoalSetEnabled,
} from "./subcommands/goals.js";
export {
  handleApprovalList,
  handleApprovalShow,
  handleApprovalApprove,
  handleApprovalDeny,
} from "./subcommands/approvals.js";
export { handleId } from "./subcommands/id.js";
export { handleLedger } from "./subcommands/ledger.js";

// Shared helper still used by handlers that haven't been extracted yet
// (federation, balance). Will become unused once T10 + T12 land.
import { fetchRelayJson } from "./subcommands/_helpers.js";

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { openMotebitDatabase } from "@motebit/persistence";
import type { PlanStep, DelegatedStepResult, ExecutionReceipt } from "@motebit/sdk";
import type { StepDelegationAdapter } from "@motebit/planner";
import { verifyIdentityFile, rotate as rotateIdentityFile } from "@motebit/identity-file";
import { rotateIdentityKeys } from "@motebit/core-identity";
import {
  hexPublicKeyToDidKey,
  verifyVerifiableCredential,
  verifyVerifiablePresentation,
  createSignedToken,
  secureErase,
  bytesToHex,
} from "@motebit/crypto";
import type { VerifiableCredential, VerifiablePresentation } from "@motebit/crypto";
import type { CliConfig } from "./args.js";
import { CONFIG_DIR, loadFullConfig, saveFullConfig } from "./config.js";
import { fromHex, promptPassphrase, encryptPrivateKey, decryptPrivateKey } from "./identity.js";
import { getDbPath } from "./runtime-factory.js";
import { formatTimeAgo } from "./utils.js";

// ---------------------------------------------------------------------------
// motebit credentials — fetch and display credentials from the relay
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// motebit verify <path> — verify identity files, export bundles, or individual VCs/VPs
// ---------------------------------------------------------------------------

/** Try to parse JSON from a string, returning null on failure. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Read a JSON file from disk, returning { ok, data } or { ok: false, error }. */
function readJsonFile(
  filePath: string,
): { ok: true; data: unknown } | { ok: false; error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { ok: false, error: "file not found" };
  }
  const parsed = tryParseJson(raw);
  if (parsed == null) {
    return { ok: false, error: "invalid JSON" };
  }
  return { ok: true, data: parsed };
}

/** Check if a parsed object looks like a VerifiableCredential. */
function isVerifiableCredential(obj: unknown): obj is VerifiableCredential {
  if (typeof obj !== "object" || obj == null) return false;
  const rec = obj as Record<string, unknown>;
  return (
    Array.isArray(rec["type"]) &&
    (rec["type"] as unknown[]).includes("VerifiableCredential") &&
    rec["proof"] != null &&
    rec["credentialSubject"] != null
  );
}

/** Check if a parsed object looks like a VerifiablePresentation. */
function isVerifiablePresentation(obj: unknown): obj is VerifiablePresentation {
  if (typeof obj !== "object" || obj == null) return false;
  const rec = obj as Record<string, unknown>;
  return (
    Array.isArray(rec["type"]) &&
    (rec["type"] as unknown[]).includes("VerifiablePresentation") &&
    rec["proof"] != null &&
    Array.isArray(rec["verifiableCredential"])
  );
}

/** Get the human-readable credential type (last type in the array that isn't "VerifiableCredential"). */
function credentialTypeName(vc: VerifiableCredential): string {
  const types = vc.type.filter((t) => t !== "VerifiableCredential");
  return types.length > 0 ? types[types.length - 1]! : "VerifiableCredential";
}

/** Extract the motebit_id from a credential subject's id (strip did:key: prefix to get raw id, or use motebit_id field). */
function extractSubjectMotebitId(vc: VerifiableCredential): string | null {
  const subject = vc.credentialSubject;
  // Check for explicit motebit_id field
  const subjectRec = subject as Record<string, unknown>;
  if (typeof subjectRec["motebit_id"] === "string") {
    return subjectRec["motebit_id"];
  }
  // The subject id is typically a did:key — return as-is for cross-checking
  return typeof subject.id === "string" ? subject.id : null;
}

export async function handleVerify(filePath: string): Promise<void> {
  const resolved = path.resolve(filePath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    console.error(`Error: path does not exist: ${resolved}`);
    process.exit(1);
  }

  // --- Single file ---
  if (stat.isFile()) {
    if (resolved.endsWith(".md")) {
      await verifySingleIdentityFile(resolved);
    } else if (resolved.endsWith(".json")) {
      await verifySingleJsonFile(resolved);
    } else {
      console.error(`Error: unsupported file type. Expected .md or .json`);
      process.exit(1);
    }
    return;
  }

  // --- Directory (export bundle) ---
  if (!stat.isDirectory()) {
    console.error(`Error: path is not a file or directory: ${resolved}`);
    process.exit(1);
  }

  await verifyBundle(resolved);
}

async function verifySingleIdentityFile(filePath: string): Promise<void> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    console.error(`Error: cannot read file: ${filePath}`);
    process.exit(1);
  }

  const result = await verifyIdentityFile(content);
  if (result.valid && result.identity) {
    const pubKey = result.identity.identity.public_key;
    const fingerprint = pubKey.slice(0, 16) + "...";
    console.log(`Identity:    ${result.identity.motebit_id}`);
    if (result.did) console.log(`DID:         ${result.did}`);
    console.log(`Public key:  ${fingerprint}`);
    console.log(`Signature:   valid`);
    process.exit(0);
  } else {
    console.error(`Signature:   invalid`);
    if (result.error != null && result.error !== "") {
      console.error(`Error:       ${result.error}`);
    }
    process.exit(1);
  }
}

async function verifySingleJsonFile(filePath: string): Promise<void> {
  const jsonResult = readJsonFile(filePath);
  if (!jsonResult.ok) {
    console.error(`Error: ${jsonResult.error}`);
    process.exit(1);
  }

  const data = jsonResult.data;

  // Try as VerifiablePresentation first (it's also an object with "type" array)
  if (isVerifiablePresentation(data)) {
    console.log(`\nVerifying presentation...\n`);
    const vpResult = await verifyVerifiablePresentation(data);
    const credCount = data.verifiableCredential.length;
    if (vpResult.valid) {
      console.log(
        `  Presentation:  valid — ${credCount} credential${credCount !== 1 ? "s" : ""}, holder: ${data.holder}`,
      );
    } else {
      console.error(`  Presentation:  INVALID`);
      for (const err of vpResult.errors) {
        console.error(`    - ${err}`);
      }
    }
    console.log();
    process.exit(vpResult.valid ? 0 : 1);
  }

  // Try as single VerifiableCredential
  if (isVerifiableCredential(data)) {
    console.log(`\nVerifying credential...\n`);
    const valid = await verifyVerifiableCredential(data);
    const typeName = credentialTypeName(data);
    if (valid) {
      console.log(`  ${typeName}:  valid — issuer: ${data.issuer}`);
    } else {
      console.error(`  ${typeName}:  INVALID`);
    }
    console.log();
    process.exit(valid ? 0 : 1);
  }

  // Try as array of VCs
  if (Array.isArray(data) && data.length > 0 && isVerifiableCredential(data[0])) {
    console.log(`\nVerifying ${data.length} credential${data.length !== 1 ? "s" : ""}...\n`);
    let allValid = true;
    for (const item of data) {
      if (!isVerifiableCredential(item)) {
        console.error(`  (unknown entry):  skipped — not a VerifiableCredential`);
        allValid = false;
        continue;
      }
      const valid = await verifyVerifiableCredential(item);
      const typeName = credentialTypeName(item);
      if (valid) {
        console.log(`  ${typeName}:  valid — issuer: ${item.issuer}`);
      } else {
        console.error(`  ${typeName}:  INVALID`);
        allValid = false;
      }
    }
    console.log();
    process.exit(allValid ? 0 : 1);
  }

  console.error(
    `Error: JSON file is not a recognized VerifiableCredential, VerifiablePresentation, or credential array.`,
  );
  process.exit(1);
}

async function verifyBundle(dirPath: string): Promise<void> {
  console.log(`\nVerifying ${path.basename(dirPath)}/...\n`);

  let passed = true;
  let motebitId: string | null = null;
  let identityDid: string | null = null;

  // 1. Identity (motebit.md)
  const identityPath = path.join(dirPath, "motebit.md");
  if (fs.existsSync(identityPath)) {
    let content: string;
    try {
      content = fs.readFileSync(identityPath, "utf-8");
    } catch {
      console.log(`  Identity (motebit.md):     FAILED — cannot read file`);
      passed = false;
      content = "";
    }
    if (content !== "") {
      const result = await verifyIdentityFile(content);
      if (result.valid && result.identity) {
        motebitId = result.identity.motebit_id;
        identityDid = result.did ?? null;
        const idShort = motebitId.length > 12 ? motebitId.slice(0, 12) + "..." : motebitId;
        console.log(`  Identity (motebit.md):     valid — motebit_id: ${idShort}`);
      } else {
        console.log(
          `  Identity (motebit.md):     INVALID — ${result.error ?? "signature verification failed"}`,
        );
        passed = false;
      }
    }
  } else {
    console.log(`  Identity (motebit.md):     not found, skipping`);
  }

  // 2. Credentials (credentials.json)
  const credsPath = path.join(dirPath, "credentials.json");
  const credentials: VerifiableCredential[] = [];
  if (fs.existsSync(credsPath)) {
    const credResult = readJsonFile(credsPath);
    if (!credResult.ok) {
      console.log(`  Credentials:               FAILED — ${credResult.error}`);
      passed = false;
    } else {
      const data = credResult.data;
      const credArray = Array.isArray(data) ? data : [];
      if (credArray.length === 0) {
        console.log(`  Credentials:               empty (0 found)`);
      } else {
        let validCount = 0;
        const credLines: string[] = [];
        for (const item of credArray) {
          if (!isVerifiableCredential(item)) {
            credLines.push(`    - (unrecognized entry)     INVALID — not a VerifiableCredential`);
            passed = false;
            continue;
          }
          credentials.push(item);
          const valid = await verifyVerifiableCredential(item);
          const typeName = credentialTypeName(item).padEnd(32);
          if (valid) {
            validCount++;
            const issuerShort =
              item.issuer.length > 20 ? item.issuer.slice(0, 20) + "..." : item.issuer;
            credLines.push(`    - ${typeName} valid — issuer: ${issuerShort}`);
          } else {
            credLines.push(`    - ${typeName} INVALID`);
            passed = false;
          }
        }
        const statusIcon = validCount === credArray.length ? "valid" : "FAILED";
        console.log(
          `  Credentials (${credArray.length} found):     ${statusIcon} — ${validCount}/${credArray.length} valid`,
        );
        for (const line of credLines) {
          console.log(line);
        }
      }
    }
  } else {
    console.log(`  Credentials:               not found, skipping`);
  }

  // 3. Presentation (presentation.json)
  const vpPath = path.join(dirPath, "presentation.json");
  if (fs.existsSync(vpPath)) {
    const vpResult = readJsonFile(vpPath);
    if (!vpResult.ok) {
      console.log(`  Presentation:              FAILED — ${vpResult.error}`);
      passed = false;
    } else if (!isVerifiablePresentation(vpResult.data)) {
      console.log(`  Presentation:              FAILED — not a valid VerifiablePresentation`);
      passed = false;
    } else {
      const vp = vpResult.data;
      const result = await verifyVerifiablePresentation(vp);
      const credCount = vp.verifiableCredential.length;
      if (result.valid) {
        const holderShort = vp.holder.length > 20 ? vp.holder.slice(0, 20) + "..." : vp.holder;
        console.log(
          `  Presentation:              valid — ${credCount} credential${credCount !== 1 ? "s" : ""}, holder: ${holderShort}`,
        );
      } else {
        console.log(`  Presentation:              INVALID`);
        for (const err of result.errors) {
          console.log(`    - ${err}`);
        }
        passed = false;
      }
    }
  } else {
    console.log(`  Presentation:              not found, skipping`);
  }

  // 4. Subject consistency — cross-check credential subjects against motebit_id
  if (motebitId != null && credentials.length > 0) {
    // Build the expected DID for this motebit — credentials may reference the did:key
    let allConsistent = true;
    for (const vc of credentials) {
      const subjectId = extractSubjectMotebitId(vc);
      if (subjectId == null) continue;
      // The subject id should be either the motebit_id directly or the did:key derived from the identity
      const matches = subjectId === motebitId || (identityDid != null && subjectId === identityDid);
      if (!matches) {
        allConsistent = false;
        break;
      }
    }
    if (allConsistent) {
      const idShort = motebitId.length > 12 ? motebitId.slice(0, 12) + "..." : motebitId;
      console.log(`  Subject consistency:       valid — all credentials reference ${idShort}`);
    } else {
      console.log(
        `  Subject consistency:       FAILED — credential subjects do not match identity`,
      );
      passed = false;
    }
  }

  // 5. Budget (budget.json) — informational, no cryptographic verification
  const budgetPath = path.join(dirPath, "budget.json");
  if (fs.existsSync(budgetPath)) {
    const budgetResult = readJsonFile(budgetPath);
    if (!budgetResult.ok) {
      console.log(`  Budget:                    FAILED — ${budgetResult.error}`);
    } else {
      const budgetData = budgetResult.data as Record<string, unknown>;
      const allocations = Array.isArray(budgetData["allocations"]) ? budgetData["allocations"] : [];
      const settlements = Array.isArray(budgetData["settlements"]) ? budgetData["settlements"] : [];
      const parts: string[] = [];
      if (allocations.length > 0) {
        parts.push(`${allocations.length} allocation${allocations.length !== 1 ? "s" : ""}`);
      }
      if (settlements.length > 0) {
        parts.push(`${settlements.length} settlement${settlements.length !== 1 ? "s" : ""}`);
      }
      console.log(
        `  Budget:                    ${parts.length > 0 ? parts.join(", ") : "present (empty)"}`,
      );
    }
  } else {
    console.log(`  Budget:                    not found, skipping`);
  }

  // 6. Gradient (gradient.json) — informational, no cryptographic verification
  const gradientPath = path.join(dirPath, "gradient.json");
  if (fs.existsSync(gradientPath)) {
    const gradientResult = readJsonFile(gradientPath);
    if (!gradientResult.ok) {
      console.log(`  Gradient:                  FAILED — ${gradientResult.error}`);
    } else {
      const gradientData = gradientResult.data as Record<string, unknown>;
      const composite =
        typeof gradientData["gradient"] === "number"
          ? gradientData["gradient"].toFixed(2)
          : "unknown";
      console.log(`  Gradient:                  composite: ${composite}`);
    }
  } else {
    console.log(`  Gradient:                  not found, skipping`);
  }

  // Summary
  console.log();
  if (passed) {
    console.log(`Bundle verification: PASSED`);
  } else {
    console.log(`Bundle verification: FAILED`);
  }
  console.log();
  process.exit(passed ? 0 : 1);
}

const DEFAULT_SYNC_URL = "https://motebit-sync.fly.dev";

/**
 * `motebit register [--sync-url <url>]`
 *
 * Registers this identity with the relay so other motebits can discover and
 * delegate to it.  Saves the sync URL to ~/.motebit/config.json for future
 * use by daemon and REPL modes.
 */
export async function handleRegister(config: CliConfig): Promise<void> {
  const syncUrl = (config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"] ?? DEFAULT_SYNC_URL).replace(
    /\/+$/,
    "",
  );

  const fullConfig = loadFullConfig();

  // Require identity to exist (user must have launched the REPL at least once)
  const motebitId = fullConfig.motebit_id;
  const deviceId = fullConfig.device_id;
  const publicKeyHex = fullConfig.device_public_key;

  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }
  if (deviceId == null || deviceId === "") {
    console.error("Error: no device_id found in config. Run `motebit` first.");
    process.exit(1);
  }
  if (publicKeyHex == null || publicKeyHex === "") {
    console.error("Error: no public key found in config. Run `motebit` first.");
    process.exit(1);
  }

  // Optionally decrypt private key so we can verify the registration with a signed token
  let privateKeyBytes: Uint8Array | undefined;
  if (fullConfig.cli_encrypted_key) {
    try {
      const envPassphrase = process.env["MOTEBIT_PASSPHRASE"];
      let passphrase: string;
      if (envPassphrase != null && envPassphrase !== "") {
        passphrase = envPassphrase;
      } else {
        passphrase = await promptPassphrase("Passphrase (to sign registration): ");
      }
      const pkHex = await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
      privateKeyBytes = fromHex(pkHex);
    } catch {
      console.warn("Warning: could not decrypt private key — registration proceeds unsigned");
    }
  }

  // Step 1: Bootstrap identity + device on relay (creates identity if new, idempotent if same key)
  const bootstrapBody = {
    motebit_id: motebitId,
    device_id: deviceId,
    public_key: publicKeyHex,
  };

  let registerResp: Response;
  try {
    registerResp = await fetch(`${syncUrl}/api/v1/agents/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bootstrapBody),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: could not reach relay at ${syncUrl}: ${msg}`);
    process.exit(1);
  }

  if (!registerResp.ok) {
    const text = await registerResp.text();
    console.error(
      `Error: relay registration failed (${registerResp.status}): ${text.slice(0, 200)}`,
    );
    process.exit(1);
  }

  const bootstrapResult = (await registerResp.json()) as { registered: boolean };
  const registered = true;

  // Step 2: Verify registration succeeded by minting a signed token and calling /health
  if (registered && privateKeyBytes) {
    try {
      const token = await createSignedToken(
        {
          mid: motebitId,
          did: deviceId,
          iat: Date.now(),
          exp: Date.now() + 5 * 60 * 1000,
          jti: crypto.randomUUID(),
          aud: "sync",
        },
        privateKeyBytes,
      );

      const healthResp = await fetch(`${syncUrl}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!healthResp.ok) {
        console.warn(`Warning: relay health check returned ${healthResp.status} — continuing`);
      }
    } catch {
      // Best-effort verification — don't fail the command
    }
  }

  // Step 3: Save sync URL to config if not already set
  if (fullConfig.sync_url == null || fullConfig.sync_url === "") {
    fullConfig.sync_url = syncUrl;
    saveFullConfig(fullConfig);
    console.log(`Saved sync URL: ${syncUrl}`);
  }

  if (bootstrapResult.registered) {
    console.log(`Created + registered ${motebitId.slice(0, 8)}... with relay at ${syncUrl}`);
  } else {
    console.log(
      `Registered ${motebitId.slice(0, 8)}... with relay at ${syncUrl} (identity already existed)`,
    );
  }

  // Erase temporary private key bytes
  if (privateKeyBytes) secureErase(privateKeyBytes);
}

// --- Federation ---

function getRelayUrl(config: CliConfig): string {
  const url = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"] ?? loadFullConfig().sync_url;
  if (!url) {
    console.error("Error: no relay URL. Use --sync-url or run `motebit register` first.");
    process.exit(1);
  }
  return url.replace(/\/+$/, "");
}

/**
 * Build auth headers for relay API calls. Tries in order:
 * 1. --sync-token / MOTEBIT_API_TOKEN (master token)
 * 2. Signed device token (decrypts private key from config, prompts for passphrase)
 * 3. No auth (unauthenticated)
 */
async function getRelayAuthHeaders(
  config: CliConfig,
  opts?: { aud?: string; json?: boolean },
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (opts?.json) headers["Content-Type"] = "application/json";

  // 1. Master token
  const master = config.syncToken ?? process.env["MOTEBIT_API_TOKEN"];
  if (master) {
    headers["Authorization"] = `Bearer ${master}`;
    return headers;
  }

  // 2. Signed device token from encrypted private key
  const fullConfig = loadFullConfig();
  if (fullConfig.cli_encrypted_key && fullConfig.motebit_id && fullConfig.device_id) {
    try {
      const passphrase = await promptPassphrase("Passphrase (for relay auth): ");
      const privateKeyHex = await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
      const privateKeyBytes = fromHex(privateKeyHex);
      const token = await createSignedToken(
        {
          mid: fullConfig.motebit_id,
          did: fullConfig.device_id,
          iat: Date.now(),
          exp: Date.now() + 5 * 60 * 1000,
          jti: crypto.randomUUID(),
          aud: opts?.aud ?? "admin:query",
        },
        privateKeyBytes,
      );
      secureErase(privateKeyBytes);
      headers["Authorization"] = `Bearer ${token}`;
    } catch {
      // Passphrase wrong or key unavailable — continue without auth
    }
  }

  return headers;
}

export async function handleFederationStatus(config: CliConfig): Promise<void> {
  const relayUrl = getRelayUrl(config);
  const result = await fetchRelayJson(`${relayUrl}/federation/v1/identity`, {});
  if (!result.ok) {
    console.error(`Failed to get relay identity: ${result.error}`);
    process.exit(1);
  }
  const id = result.data as {
    relay_motebit_id: string;
    public_key: string;
    did: string;
    spec: string;
  };
  console.log(`Relay Identity`);
  console.log(`  ID:   ${id.relay_motebit_id}`);
  console.log(`  DID:  ${id.did}`);
  console.log(`  Key:  ${id.public_key.slice(0, 16)}...`);
  console.log(`  Spec: ${id.spec}`);
}

export async function handleFederationPeers(config: CliConfig): Promise<void> {
  const relayUrl = getRelayUrl(config);
  const token = config.syncToken ?? process.env["MOTEBIT_SYNC_TOKEN"] ?? "";
  const result = await fetchRelayJson(`${relayUrl}/federation/v1/peers`, {
    Authorization: `Bearer ${token}`,
  });
  if (!result.ok) {
    console.error(`Failed to list peers: ${result.error}`);
    process.exit(1);
  }
  const { peers } = result.data as {
    peers: Array<{
      peer_relay_id: string;
      state: string;
      endpoint_url: string;
      display_name: string | null;
      trust_score: number;
      agent_count: number;
    }>;
  };
  if (peers.length === 0) {
    console.log("No peers. Use `motebit federation peer <url>` to add one.");
    return;
  }
  console.log(`${String(peers.length)} peer(s):\n`);
  for (const p of peers) {
    const name = p.display_name ?? p.peer_relay_id.slice(0, 16);
    console.log(
      `  ${name}  ${p.state}  trust=${p.trust_score.toFixed(2)}  agents=${String(p.agent_count)}  ${p.endpoint_url}`,
    );
  }
}

export async function handleFederationPeer(config: CliConfig): Promise<void> {
  const peerUrl = config.positionals[2];
  if (!peerUrl) {
    console.error("Usage: motebit federation peer <relay-url>");
    process.exit(1);
  }
  const relayUrl = getRelayUrl(config);
  const peerEndpoint = peerUrl.replace(/\/+$/, "");

  console.log(`Peering ${relayUrl} ↔ ${peerEndpoint}\n`);

  // 1. Get both identities
  const [ourIdRes, peerIdRes] = await Promise.all([
    fetchRelayJson(`${relayUrl}/federation/v1/identity`, {}),
    fetchRelayJson(`${peerEndpoint}/federation/v1/identity`, {}),
  ]);
  if (!ourIdRes.ok) {
    console.error(`Cannot reach our relay: ${ourIdRes.error}`);
    process.exit(1);
  }
  if (!peerIdRes.ok) {
    console.error(`Cannot reach peer relay: ${peerIdRes.error}`);
    process.exit(1);
  }

  const ourId = ourIdRes.data as { relay_motebit_id: string; public_key: string };
  const peerId = peerIdRes.data as { relay_motebit_id: string; public_key: string };
  console.log(`  Our relay:  ${ourId.relay_motebit_id.slice(0, 16)}...`);
  console.log(`  Peer relay: ${peerId.relay_motebit_id.slice(0, 16)}...`);

  // 2. Propose: us → peer
  const nonce1 = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const propose1 = await fetch(`${peerEndpoint}/federation/v1/peer/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: ourId.relay_motebit_id,
      public_key: ourId.public_key,
      endpoint_url: relayUrl,
      nonce: nonce1,
    }),
  });
  if (!propose1.ok) {
    const err = await propose1.text();
    console.error(`Propose to peer failed: ${err}`);
    process.exit(1);
  }
  const proposeBody1 = (await propose1.json()) as { nonce: string; challenge: string };
  console.log("  ✓ Proposed to peer");

  // 3. Propose: peer → us (so we have them as pending too)
  const nonce2 = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const propose2 = await fetch(`${relayUrl}/federation/v1/peer/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: peerId.relay_motebit_id,
      public_key: peerId.public_key,
      endpoint_url: peerEndpoint,
      nonce: nonce2,
    }),
  });
  if (!propose2.ok) {
    const err = await propose2.text();
    console.error(`Propose to our relay failed: ${err}`);
    process.exit(1);
  }
  const proposeBody2 = (await propose2.json()) as { nonce: string; challenge: string };
  console.log("  ✓ Proposed to our relay");

  // 4. Get signatures via oracle trick: propose to each relay from a dummy with the nonce we want signed
  const dummyKey1 = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const oracle1 = await fetch(`${relayUrl}/federation/v1/peer/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: `dummy-${crypto.randomUUID()}`,
      public_key: dummyKey1,
      endpoint_url: "http://dummy.test",
      nonce: proposeBody1.nonce, // peer's nonce — our relay will sign it
    }),
  });
  if (!oracle1.ok) {
    console.error("Failed to get signature from our relay");
    process.exit(1);
  }
  const oracleBody1 = (await oracle1.json()) as { challenge: string };

  const dummyKey2 = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const oracle2 = await fetch(`${peerEndpoint}/federation/v1/peer/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: `dummy-${crypto.randomUUID()}`,
      public_key: dummyKey2,
      endpoint_url: "http://dummy.test",
      nonce: proposeBody2.nonce, // our nonce — peer will sign it
    }),
  });
  if (!oracle2.ok) {
    console.error("Failed to get signature from peer relay");
    process.exit(1);
  }
  const oracleBody2 = (await oracle2.json()) as { challenge: string };

  // 5. Confirm on both sides
  const confirm1 = await fetch(`${peerEndpoint}/federation/v1/peer/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: ourId.relay_motebit_id,
      challenge_response: oracleBody1.challenge,
    }),
  });
  if (!confirm1.ok) {
    const err = await confirm1.text();
    console.error(`Confirm on peer failed: ${err}`);
    process.exit(1);
  }
  console.log("  ✓ Confirmed on peer");

  const confirm2 = await fetch(`${relayUrl}/federation/v1/peer/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: peerId.relay_motebit_id,
      challenge_response: oracleBody2.challenge,
    }),
  });
  if (!confirm2.ok) {
    const err = await confirm2.text();
    console.error(`Confirm on our relay failed: ${err}`);
    process.exit(1);
  }
  console.log("  ✓ Confirmed on our relay");

  console.log(`\nPeered successfully. Both relays are now active peers.`);
}

// ---------------------------------------------------------------------------
// motebit rotate — rotate the Ed25519 keypair with succession chain
// ---------------------------------------------------------------------------

/**
 * Discover motebit.md by searching cwd, parent directories, and ~/.motebit/identity.md.
 * Returns the absolute path to the first found identity file, or null.
 */
function discoverIdentityFile(): string | null {
  // 1. Walk up from cwd looking for motebit.md
  let dir = process.cwd();
  const root = path.parse(dir).root;
  let parent = path.dirname(dir);
  while (dir !== parent && dir !== root) {
    const candidate = path.join(dir, "motebit.md");
    if (fs.existsSync(candidate)) return candidate;
    dir = parent;
    parent = path.dirname(dir);
  }
  // Check root itself
  const rootCandidate = path.join(root, "motebit.md");
  if (fs.existsSync(rootCandidate)) return rootCandidate;

  // 2. Check ~/.motebit/identity.md
  const homeCandidate = path.join(CONFIG_DIR, "identity.md");
  if (fs.existsSync(homeCandidate)) return homeCandidate;

  return null;
}

export async function handleRotate(config: CliConfig): Promise<void> {
  const reason = config.reason;

  // 1. Find identity file
  const identityPath = discoverIdentityFile();
  if (!identityPath) {
    console.error("Error: no motebit.md found. Searched cwd/parents and ~/.motebit/identity.md.");
    console.error("  Run `motebit export` first to generate an identity file.");
    process.exit(1);
  }

  console.log(`\nIdentity file: ${identityPath}`);

  // 2. Read and verify existing identity file
  let existingContent: string;
  try {
    existingContent = fs.readFileSync(identityPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: cannot read identity file: ${msg}`);
    process.exit(1);
  }

  const verifyResult = await verifyIdentityFile(existingContent);
  if (!verifyResult.valid || !verifyResult.identity) {
    console.error("Error: identity file verification failed.");
    if (verifyResult.error) console.error(`  ${verifyResult.error}`);
    process.exit(1);
  }
  console.log("  Verified: signature valid");

  const identity = verifyResult.identity;
  const motebitId = identity.motebit_id;
  const oldPublicKeyHex = identity.identity.public_key;

  // 3. Load config and decrypt old private key
  const fullConfig = loadFullConfig();
  if (!fullConfig.cli_encrypted_key) {
    console.error("Error: no encrypted key found in config. Cannot rotate without the old key.");
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    escapeCodeTimeout: 50,
  });
  const envPassphrase = process.env["MOTEBIT_PASSPHRASE"];
  let passphrase: string;
  if (envPassphrase != null && envPassphrase !== "") {
    passphrase = envPassphrase;
  } else {
    passphrase = await promptPassphrase(rl, "Passphrase: ");
  }

  let oldPrivKeyHex: string;
  try {
    oldPrivKeyHex = await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
  } catch {
    console.error("Error: incorrect passphrase.");
    rl.close();
    process.exit(1);
  }

  const oldPrivateKey = fromHex(oldPrivKeyHex);
  const oldPublicKey = fromHex(oldPublicKeyHex);

  // 4. Generate new keypair and sign succession record
  const rotateResult = await rotateIdentityKeys({
    oldPrivateKey,
    oldPublicKey,
    reason,
  });
  console.log(`  Old public key: ${oldPublicKeyHex.slice(0, 16)}...`);
  console.log(`  New public key: ${rotateResult.newPublicKeyHex.slice(0, 16)}...`);
  console.log("  Succession record: created (dual-signed)");

  // 5. Rotate identity file and verify before writing
  const rotatedContent = await rotateIdentityFile({
    existingContent,
    newPublicKey: rotateResult.newPublicKey,
    newPrivateKey: rotateResult.newPrivateKey,
    successionRecord: rotateResult.successionRecord,
  });
  const rotatedVerify = await verifyIdentityFile(rotatedContent);
  if (!rotatedVerify.valid) {
    console.error("Error: rotated identity file failed self-verification. Aborting.");
    if (rotatedVerify.error) console.error(`  ${rotatedVerify.error}`);
    secureErase(oldPrivateKey);
    secureErase(rotateResult.newPrivateKey);
    rl.close();
    process.exit(1);
  }

  fs.writeFileSync(identityPath, rotatedContent, "utf-8");
  console.log("  Identity file: updated and re-signed");

  // 6. Encrypt new private key and update config
  fullConfig.cli_encrypted_key = await encryptPrivateKey(
    bytesToHex(rotateResult.newPrivateKey),
    passphrase,
  );
  fullConfig.device_public_key = rotateResult.newPublicKeyHex;
  saveFullConfig(fullConfig);
  console.log("  Config: new key encrypted and saved");

  // Securely erase old key material
  secureErase(oldPrivateKey);
  secureErase(rotateResult.newPrivateKey);

  // 8. Submit succession record to relay if configured
  const syncUrl = fullConfig.sync_url ?? process.env["MOTEBIT_SYNC_URL"];
  if (syncUrl) {
    const baseUrl = syncUrl.replace(/\/+$/, "");
    try {
      // Re-decrypt new key for signing the relay request
      if (!fullConfig.cli_encrypted_key) throw new Error("No encrypted key in config");
      const newPrivKeyHex = await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
      const newPrivKey = fromHex(newPrivKeyHex);
      const deviceId = fullConfig.device_id ?? "";

      const token = await createSignedToken(
        {
          mid: motebitId,
          did: deviceId,
          iat: Date.now(),
          exp: Date.now() + 5 * 60 * 1000,
          jti: crypto.randomUUID(),
          aud: "rotate-key",
        },
        newPrivKey,
      );
      secureErase(newPrivKey);

      const relayResp = await fetch(`${baseUrl}/api/v1/agents/${motebitId}/rotate-key`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(rotateResult.successionRecord),
      });

      if (relayResp.ok) {
        console.log("  Relay: succession record submitted");
      } else {
        const text = await relayResp.text();
        console.warn(`  Relay: submission failed (${relayResp.status}): ${text.slice(0, 200)}`);
        console.warn("  The local rotation is complete. Re-register with the relay manually.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Relay: could not reach ${baseUrl}: ${msg}`);
      console.warn("  The local rotation is complete. Re-register with the relay manually.");
    }
  } else {
    console.log("  Relay: not configured (skipped)");
  }

  // 9. Summary
  console.log();
  console.log("Key rotation complete.");
  console.log(`  motebit_id   ${motebitId}`);
  console.log(`  did          ${hexPublicKeyToDidKey(rotateResult.newPublicKeyHex)}`);
  console.log(`  public_key   ${rotateResult.newPublicKeyHex.slice(0, 16)}...`);
  const chainLength = (identity.succession?.length ?? 0) + 1;
  console.log(`  rotations    ${chainLength}`);
  if (reason) {
    console.log(`  reason       ${reason}`);
  }
  console.log();

  rl.close();
}

// ---------------------------------------------------------------------------
// motebit balance — show virtual account balance and recent transactions
// ---------------------------------------------------------------------------

export async function handleBalance(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const relayUrl = getRelayUrl(config);
  const headers = await getRelayAuthHeaders(config);

  const result = await fetchRelayJson(`${relayUrl}/api/v1/agents/${motebitId}/balance`, headers);
  if (!result.ok) {
    console.error(`Failed to get balance: ${result.error}`);
    process.exit(1);
  }

  const data = result.data as {
    balance: number;
    currency: string;
    transactions: Array<{
      type: string;
      amount: number;
      created_at: string;
    }>;
  };

  if (config.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`\nBalance: $${data.balance.toFixed(2)} ${data.currency}`);
  const recent = (data.transactions ?? []).slice(0, 5);
  if (recent.length > 0) {
    console.log("Recent:");
    for (const tx of recent) {
      const sign = tx.amount >= 0 ? "+" : "";
      const ago = formatTimeAgo(Date.now() - new Date(tx.created_at).getTime());
      console.log(`  ${sign}$${Math.abs(tx.amount).toFixed(2)}  ${tx.type.padEnd(20)} ${ago}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// motebit withdraw <amount> [--destination <addr>]
// ---------------------------------------------------------------------------

export async function handleWithdraw(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const amountStr = config.positionals[1];
  if (!amountStr) {
    console.error("Usage: motebit withdraw <amount> [--destination <addr>]");
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    console.error("Error: amount must be a positive number.");
    process.exit(1);
  }

  const relayUrl = getRelayUrl(config);
  const headers = await getRelayAuthHeaders(config, { json: true });

  const body: Record<string, unknown> = { amount };
  if (config.destination) body["destination"] = config.destination;

  try {
    const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    if (res.status === 402) {
      console.error("Insufficient balance.");
      process.exit(1);
    }
    if (!res.ok) {
      const text = await res.text();
      console.error(`Withdrawal failed (${res.status}): ${text.slice(0, 200)}`);
      process.exit(1);
    }
    const data = (await res.json()) as { withdrawal_id?: string };
    console.log(`Withdrawal of $${amount.toFixed(2)} submitted.`);
    if (data.withdrawal_id != null && data.withdrawal_id !== "") {
      console.log(`  ID: ${data.withdrawal_id}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: could not reach relay: ${msg}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// motebit fund <amount> — deposit via Stripe Checkout
// ---------------------------------------------------------------------------

export async function handleFund(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const amountStr = config.positionals[1];
  if (!amountStr) {
    console.error("Usage: motebit fund <amount>");
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount < 0.5) {
    console.error("Error: minimum amount is $0.50.");
    process.exit(1);
  }

  const relayUrl = getRelayUrl(config);
  const headers = await getRelayAuthHeaders(config, { json: true });

  // Create Stripe Checkout session
  let checkoutUrl: string;
  try {
    const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/checkout`, {
      method: "POST",
      headers,
      body: JSON.stringify({ amount }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Checkout failed (${res.status}): ${text.slice(0, 200)}`);
      process.exit(1);
    }
    const data = (await res.json()) as { checkout_url: string; session_id: string };
    checkoutUrl = data.checkout_url;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: could not reach relay: ${msg}`);
    process.exit(1);
  }

  // Open in browser
  console.log(`\nOpening Stripe Checkout for $${amount.toFixed(2)}...\n`);
  console.log(`  ${checkoutUrl}\n`);
  try {
    const { execSync } = await import("node:child_process");
    const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
    execSync(`${openCmd} "${checkoutUrl}"`, { stdio: "ignore" });
  } catch {
    console.log("Could not open browser. Please visit the URL above to complete payment.");
  }

  // Poll for deposit confirmation (120s max, 3s intervals)
  console.log("Waiting for payment confirmation...");
  const startBalance = await getBalanceAmount(relayUrl, motebitId, headers);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
    const currentBalance = await getBalanceAmount(relayUrl, motebitId, headers);
    if (currentBalance !== null && startBalance !== null && currentBalance > startBalance) {
      console.log(`\nDeposit confirmed! Balance: $${currentBalance.toFixed(2)}`);
      return;
    }
    process.stdout.write(".");
  }
  console.log("\nPayment not yet confirmed. Check `motebit balance` after completing checkout.");
}

async function getBalanceAmount(
  relayUrl: string,
  motebitId: string,
  headers: Record<string, string>,
): Promise<number | null> {
  try {
    const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/balance`, { headers });
    if (!res.ok) return null;
    const data = (await res.json()) as { balance: number };
    return data.balance;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// motebit delegate --plan — multi-agent orchestration via PlanEngine
// ---------------------------------------------------------------------------

async function handleDelegatePlan(
  config: CliConfig,
  motebitId: string,
  prompt: string,
): Promise<void> {
  const relayUrl = getRelayUrl(config);

  // Build auth headers for relay calls
  const authHeaders = await getRelayAuthHeaders(config, { aud: "task:submit", json: true });

  // Initialize runtime with AI provider for plan decomposition
  const { createProvider, buildToolRegistry, buildStorageAdapters, deriveGovernanceForRuntime } =
    await import("./runtime-factory.js");
  const { MotebitRuntime, NullRenderer, PLANNING_TASK_ROUTER } = await import("@motebit/runtime");
  const { loadFullConfig } = await import("./config.js");

  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);

  const runtimeRef: { current: InstanceType<typeof MotebitRuntime> | null } = { current: null };
  const provider = createProvider(config);
  const registry = buildToolRegistry(config, runtimeRef, motebitId);
  const storage = buildStorageAdapters(moteDb);
  const governance = deriveGovernanceForRuntime(loadFullConfig().governance);

  const runtime = new MotebitRuntime(
    {
      motebitId,
      policy: {
        maxRiskLevel: governance.policyApproval.maxRiskLevel,
        requireApprovalAbove: governance.policyApproval.requireApprovalAbove,
        denyAbove: governance.policyApproval.denyAbove,
        budget: governance.policyBudget,
      },
      memoryGovernance: governance.memoryGovernance,
      taskRouter: PLANNING_TASK_ROUTER,
    },
    { storage, renderer: new NullRenderer(), tools: registry },
  );
  runtimeRef.current = runtime;
  await runtime.init();
  runtime.setProvider(provider);

  // HTTP-polling delegation adapter (no WebSocket needed for one-shot)
  // HTTP-polling delegation adapter with retry logic matching RelayDelegationAdapter
  const MAX_RETRIES = 2;
  const httpDelegationAdapter: StepDelegationAdapter = {
    async delegateStep(
      step: PlanStep,
      timeoutMs: number,
      onTaskSubmitted?: (taskId: string) => void,
    ): Promise<DelegatedStepResult> {
      const excludeAgents: string[] = [];
      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const result = await attemptDelegation(
            step,
            timeoutMs,
            excludeAgents,
            attempt === 0 ? onTaskSubmitted : undefined,
          );
          return result;
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err));
          // Extract failed agent ID from receipt if available
          const failedId = (lastError as { failedAgentId?: string }).failedAgentId;
          if (failedId) excludeAgents.push(failedId);
          // Don't retry non-retryable errors (submission failures, payment required)
          if (
            lastError.message.includes("Relay task submission failed") ||
            lastError.message.includes("HTTP 402")
          ) {
            break;
          }
          if (attempt < MAX_RETRIES) {
            console.log(
              `  ↻ Retrying step "${step.description}" (attempt ${attempt + 2}/${MAX_RETRIES + 1})`,
            );
          }
        }
      }
      throw new Error(
        `Delegation failed after ${Math.min(excludeAgents.length, MAX_RETRIES) + 1} attempt(s): ${lastError?.message ?? "unknown"}`,
        { cause: lastError },
      );
    },
  };

  async function attemptDelegation(
    step: PlanStep,
    timeoutMs: number,
    excludeAgents: string[],
    onTaskSubmitted?: (taskId: string) => void,
  ): Promise<DelegatedStepResult> {
    const body: Record<string, unknown> = {
      prompt: step.prompt,
      submitted_by: motebitId,
      required_capabilities: step.required_capabilities,
      step_id: step.step_id,
      routing_strategy: config.routingStrategy,
    };
    if (excludeAgents.length > 0) body.exclude_agents = excludeAgents;

    const resp = await fetch(`${relayUrl}/agent/${motebitId}/task`, {
      method: "POST",
      headers: { ...authHeaders, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });

    if (resp.status === 402) throw new Error("Insufficient balance (HTTP 402)");
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Relay task submission failed (${resp.status}): ${text.slice(0, 200)}`);
    }

    const taskResp = (await resp.json()) as { task_id: string };
    const taskId = taskResp.task_id;
    onTaskSubmitted?.(taskId);

    // Poll for result
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 2000));
      try {
        const pollResp = await fetch(`${relayUrl}/agent/${motebitId}/task/${taskId}`, {
          headers: authHeaders,
        });
        if (!pollResp.ok) continue;
        const data = (await pollResp.json()) as {
          receipt: ExecutionReceipt | null;
        };
        if (data.receipt) {
          if (data.receipt.status !== "completed") {
            const err = new Error(`Delegated step ${data.receipt.status}: ${data.receipt.result}`);
            (err as { failedAgentId?: string }).failedAgentId = data.receipt.motebit_id;
            throw err;
          }
          return {
            step_id: step.step_id,
            task_id: taskId,
            receipt: data.receipt,
            result_text: data.receipt.result,
          };
        }
      } catch (err) {
        if (err instanceof Error && (err as { failedAgentId?: string }).failedAgentId) throw err;
        // Network error — keep polling
      }
    }
    throw new Error(`Delegation timed out after ${timeoutMs}ms for step "${step.description}"`);
  }

  // Wire delegation: empty local capabilities forces all steps to delegate to the network
  runtime.setLocalCapabilities([]);
  runtime.setDelegationAdapter(httpDelegationAdapter);

  // Execute plan
  const goalId = crypto.randomUUID();
  console.log(`\nDecomposing: "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"\n`);

  let stepCount = 0;
  let completedCount = 0;

  try {
    for await (const chunk of runtime.executePlan(goalId, prompt)) {
      switch (chunk.type) {
        case "plan_created":
          stepCount = chunk.steps.length;
          console.log(`Plan: ${chunk.plan.title}`);
          console.log(`  ${stepCount} steps\n`);
          break;

        case "step_started":
          console.log(
            `Step ${chunk.step.ordinal + 1}/${stepCount}: ${chunk.step.description}` +
              (chunk.step.required_capabilities?.length
                ? ` (${chunk.step.required_capabilities.join(", ")})`
                : ""),
          );
          break;

        case "step_delegated":
          console.log(
            `  → Delegated${chunk.routing_choice?.selected_agent ? ` to ${chunk.routing_choice.selected_agent.slice(0, 12)}...` : ""} (task: ${chunk.task_id.slice(0, 12)}...)`,
          );
          break;

        case "step_completed": {
          completedCount++;
          const summary = chunk.step.result_summary ?? "";
          const preview = summary.length > 200 ? summary.slice(0, 200) + "..." : summary;
          console.log(`  ✓ ${preview || "completed"}\n`);
          break;
        }

        case "step_failed":
          console.log(`  ✗ ${chunk.error}\n`);
          break;

        case "plan_completed":
          console.log(`\nPlan complete. ${completedCount}/${stepCount} steps executed.`);
          break;

        case "plan_failed":
          console.error(`\nPlan failed: ${chunk.reason}`);
          break;
      }
    }
  } finally {
    runtime.stop();
    moteDb.close();
  }
}

// ---------------------------------------------------------------------------
// motebit delegate "<prompt>" — delegate a task to a worker agent
// ---------------------------------------------------------------------------

export async function handleDelegate(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const prompt = config.positionals.slice(1).join(" ");
  if (!prompt) {
    console.error('Usage: motebit delegate "<prompt>" [--capability web_search] [--target <id>]');
    process.exit(1);
  }

  // --plan: multi-agent orchestration via PlanEngine
  if (config.plan) {
    await handleDelegatePlan(config, motebitId, prompt);
    return;
  }

  const relayUrl = getRelayUrl(config);
  const headers = await getRelayAuthHeaders(config, { aud: "task:submit", json: true });

  const capability = config.capability ?? "web_search";
  let targetMotebitId = config.target;

  // Discover a worker if no target specified
  if (!targetMotebitId) {
    try {
      const maxBudget = config.budget ? parseFloat(config.budget) : 10;
      const discoverRes = await fetch(
        `${relayUrl}/api/v1/market/candidates?capability=${encodeURIComponent(capability)}&max_budget=${maxBudget}&limit=5`,
        { headers },
      );
      if (!discoverRes.ok) {
        const text = await discoverRes.text();
        console.error(`Discovery failed (${discoverRes.status}): ${text.slice(0, 200)}`);
        process.exit(1);
      }
      const discoverData = (await discoverRes.json()) as {
        candidates: Array<{
          motebit_id: string;
          composite: number;
          pricing?: Array<{ capability: string; unit_cost: number }>;
          description?: string;
          selected?: boolean;
        }>;
      };
      const candidates = discoverData.candidates ?? [];
      if (candidates.length === 0) {
        console.error(`No agents found with capability "${capability}". Is a worker running?`);
        process.exit(1);
      }
      const best = candidates.find((c) => c.selected) ?? candidates[0]!;
      targetMotebitId = best.motebit_id;
      const price = best.pricing?.find((p) => p.capability === capability)?.unit_cost;
      console.log(
        `Found worker: ${targetMotebitId.slice(0, 12)}...` +
          (price != null ? ` ($${price.toFixed(4)}/request)` : "") +
          (best.description ? ` — ${best.description}` : ""),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Discovery error: ${msg}`);
      process.exit(1);
    }
  }

  // Submit task
  let taskId: string;
  try {
    console.log(`Delegating to ${targetMotebitId.slice(0, 12)}...`);
    const submitRes = await fetch(`${relayUrl}/agent/${targetMotebitId}/task`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        prompt,
        submitted_by: motebitId,
        required_capabilities: [capability],
      }),
    });
    if (submitRes.status === 402) {
      console.error("Insufficient balance. Run `motebit fund <amount>` to deposit.");
      process.exit(1);
    }
    if (!submitRes.ok) {
      const text = await submitRes.text();
      console.error(`Task submission failed (${submitRes.status}): ${text.slice(0, 200)}`);
      process.exit(1);
    }
    const submitData = (await submitRes.json()) as { task_id: string };
    taskId = submitData.task_id;
    console.log(`Task submitted: ${taskId.slice(0, 12)}...`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Task submission error: ${msg}`);
    process.exit(1);
  }

  // Poll for result (60s max, 2s intervals)
  const POLL_INTERVAL_MS = 2000;
  const MAX_POLLS = 30;
  process.stdout.write("Waiting");

  for (let poll = 0; poll < MAX_POLLS; poll++) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const pollRes = await fetch(`${relayUrl}/agent/${targetMotebitId}/task/${taskId}`, {
        headers,
      });
      if (!pollRes.ok) {
        process.stdout.write(".");
        continue;
      }
      const pollData = (await pollRes.json()) as {
        task: { status: string };
        receipt: {
          status: string;
          result: string;
          motebit_id: string;
          tools_used?: string[];
          completed_at?: number;
          submitted_at?: number;
        } | null;
      };
      if (pollData.receipt != null) {
        console.log(); // newline after dots
        const r = pollData.receipt;
        if (r.status === "completed") {
          console.log(`\n--- Result ---\n`);
          console.log(r.result);
          console.log();
          if (r.tools_used && r.tools_used.length > 0) {
            console.log(`Tools: ${r.tools_used.join(", ")}`);
          }
          if (r.submitted_at && r.completed_at) {
            const latency = r.completed_at - r.submitted_at;
            console.log(`Latency: ${latency}ms`);
          }
        } else {
          console.log(`Task ${r.status}: ${r.result || "(no result)"}`);
        }
        return;
      }
      process.stdout.write(".");
    } catch {
      process.stdout.write(".");
    }
  }
  console.log("\nTask timed out after 60s. The worker may still be running.");
  console.log(`Check status: curl ${relayUrl}/agent/${targetMotebitId}/task/${taskId}`);
}
