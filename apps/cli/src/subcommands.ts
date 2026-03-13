// --- CLI subcommand handlers (non-REPL) ---

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { openMotebitDatabase } from "@motebit/persistence";
import { EventStore } from "@motebit/event-log";
import { EventType, RiskLevel } from "@motebit/sdk";
import {
  generate as generateIdentityFile,
  verify as verifyIdentityFile,
} from "@motebit/identity-file";
import {
  hexPublicKeyToDidKey,
  verifyVerifiableCredential,
  verifyVerifiablePresentation,
  createSignedToken,
  secureErase,
} from "@motebit/crypto";
import type { VerifiableCredential, VerifiablePresentation } from "@motebit/crypto";
import type { CliConfig } from "./args.js";
import { CONFIG_DIR, loadFullConfig, saveFullConfig } from "./config.js";
import {
  fromHex,
  promptPassphrase,
  encryptPrivateKey,
  decryptPrivateKey,
  bootstrapIdentity,
} from "./identity.js";
import { getDbPath } from "./runtime-factory.js";
import { formatMs } from "./utils.js";
import { parseInterval } from "./intervals.js";

export async function handleDoctor(): Promise<void> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  // Node version
  const nodeVer = process.versions.node;
  const major = parseInt(nodeVer.split(".")[0]!, 10);
  checks.push({
    name: "Node.js",
    ok: major >= 20,
    detail: major >= 20 ? `v${nodeVer}` : `v${nodeVer} (requires >=20)`,
  });

  // Config directory writable
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const testFile = path.join(CONFIG_DIR, ".doctor-test");
    fs.writeFileSync(testFile, "ok", "utf-8");
    fs.unlinkSync(testFile);
    checks.push({ name: "Config dir", ok: true, detail: CONFIG_DIR });
  } catch {
    checks.push({ name: "Config dir", ok: false, detail: `Cannot write to ${CONFIG_DIR}` });
  }

  // SQLite driver (better-sqlite3 preferred, sql.js fallback)
  try {
    const tmpDbPath = path.join(CONFIG_DIR, ".doctor-test.db");
    const db = await openMotebitDatabase(tmpDbPath);
    const driverName = db.db.driverName;
    db.close();
    fs.unlinkSync(tmpDbPath);
    try {
      fs.unlinkSync(tmpDbPath + "-wal");
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(tmpDbPath + "-shm");
    } catch {
      /* ignore */
    }
    checks.push({ name: "SQLite", ok: true, detail: `${driverName} loaded and functional` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: "SQLite", ok: false, detail: msg });
  }

  // @xenova/transformers (optional)
  try {
    await import("@xenova/transformers");
    checks.push({
      name: "Embeddings",
      ok: true,
      detail: "@xenova/transformers available (local embeddings)",
    });
  } catch {
    checks.push({
      name: "Embeddings",
      ok: true,
      detail: "not installed (optional — hash-based fallback active)",
    });
  }

  // Existing identity
  const fullCfg = loadFullConfig();
  if (fullCfg.motebit_id != null && fullCfg.motebit_id !== "") {
    checks.push({ name: "Identity", ok: true, detail: `${fullCfg.motebit_id.slice(0, 8)}...` });
  } else {
    checks.push({ name: "Identity", ok: true, detail: "not created yet (run motebit to create)" });
  }

  // Print results
  console.log("\nmotebit doctor\n");
  let allOk = true;
  for (const check of checks) {
    const icon = check.ok ? "ok" : "FAIL";
    console.log(`  ${icon.padEnd(6)} ${check.name.padEnd(14)} ${check.detail}`);
    if (!check.ok) allOk = false;
  }
  console.log();

  if (!allOk) {
    console.log("Some checks failed. See https://motebit.dev/docs for troubleshooting.\n");
    process.exit(1);
  } else {
    console.log("All checks passed.\n");
  }
}

export async function handleExport(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

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
  const syncToken = config.syncToken ?? process.env["MOTEBIT_SYNC_TOKEN"];
  const headers: Record<string, string> = {};
  if (syncToken) {
    headers["Authorization"] = `Bearer ${syncToken}`;
  }
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

    // 5. Budget summary
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

/** Fetch JSON from relay, returning a typed success/error result. */
async function fetchRelayJson(
  url: string,
  headers: Record<string, string>,
  method: "GET" | "POST" = "GET",
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method, headers });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `relay returned ${String(res.status)}: ${body.slice(0, 100)}` };
    }
    const data: unknown = await res.json();
    return { ok: true, data };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function handleGoalAdd(config: CliConfig): Promise<void> {
  // positionals: ["goal", "add", "<prompt>"]
  const prompt = config.positionals[2];
  if (prompt == null || prompt === "") {
    console.error('Usage: motebit goal add "<prompt>" --every <interval>');
    process.exit(1);
  }
  if (config.every == null || config.every === "") {
    console.error("Error: --every <interval> is required. E.g. --every 30m");
    process.exit(1);
  }

  let intervalMs: number;
  try {
    intervalMs = parseInterval(config.every);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);

  let wallClockMs: number | null = null;
  if (config.wallClock != null && config.wallClock !== "") {
    try {
      wallClockMs = parseInterval(config.wallClock);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error parsing --wall-clock: ${msg}`);
      process.exit(1);
    }
  }

  const projectId = config.project != null && config.project !== "" ? config.project : null;

  const mode = config.once ? "once" : "recurring";
  const goalId = crypto.randomUUID();
  moteDb.goalStore.add({
    goal_id: goalId,
    motebit_id: motebitId,
    prompt,
    interval_ms: intervalMs,
    last_run_at: null,
    enabled: true,
    created_at: Date.now(),
    mode,
    status: "active",
    parent_goal_id: null,
    max_retries: 3,
    consecutive_failures: 0,
    wall_clock_ms: wallClockMs,
    project_id: projectId,
  });

  // Log event
  const eventStore = new EventStore(moteDb.eventStore);
  await eventStore.append({
    event_id: crypto.randomUUID(),
    motebit_id: motebitId,
    timestamp: Date.now(),
    event_type: EventType.GoalCreated,
    payload: {
      goal_id: goalId,
      prompt,
      interval_ms: intervalMs,
      mode,
      wall_clock_ms: wallClockMs,
      project_id: projectId,
    },
    version_clock: (await moteDb.eventStore.getLatestClock(motebitId)) + 1,
    tombstoned: false,
  });

  moteDb.close();
  const modeLabel = mode === "once" ? " (one-shot)" : "";
  const wallClockLabel = wallClockMs != null ? ` (wall-clock: ${config.wallClock})` : "";
  const projectLabel = projectId != null ? ` [project: ${projectId}]` : "";
  console.log(
    `Goal added: ${goalId.slice(0, 8)} — "${prompt}" every ${config.every}${modeLabel}${wallClockLabel}${projectLabel}`,
  );
}

export async function handleGoalList(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  const goals = moteDb.goalStore.list(motebitId);

  if (goals.length === 0) {
    moteDb.close();
    console.log("No goals scheduled.");
    return;
  }

  console.log(`\nGoals (${goals.length}):\n`);
  console.log(
    "  ID        Prompt                                     Interval    Status      Last Outcome",
  );
  console.log("  " + "-".repeat(105));

  for (const g of goals) {
    const id = g.goal_id.slice(0, 8);
    const prompt = g.prompt.length > 40 ? g.prompt.slice(0, 37) + "..." : g.prompt.padEnd(40);
    const interval = formatMs(g.interval_ms).padEnd(11);
    const status = g.status.padEnd(11);

    // Get last outcome summary
    const outcomes = moteDb.goalOutcomeStore.listForGoal(g.goal_id, 1);
    let lastOutcome = "—";
    if (outcomes.length > 0) {
      const o = outcomes[0]!;
      const summary = o.summary != null && o.summary !== "" ? o.summary.slice(0, 30) : o.status;
      lastOutcome = summary;
    }

    console.log(`  ${id}  ${prompt} ${interval} ${status} ${lastOutcome}`);
  }
  moteDb.close();
  console.log();
}

export async function handleGoalOutcomes(config: CliConfig): Promise<void> {
  const goalId = config.positionals[2];
  if (goalId == null || goalId === "") {
    console.error("Usage: motebit goal outcomes <goal_id>");
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);

  // Find goal by prefix match
  const goals = moteDb.goalStore.list(motebitId);
  const match = goals.find((g) => g.goal_id === goalId || g.goal_id.startsWith(goalId));
  if (!match) {
    console.error(`Error: no goal found matching "${goalId}".`);
    moteDb.close();
    process.exit(1);
  }

  const outcomes = moteDb.goalOutcomeStore.listForGoal(match.goal_id, 10);
  moteDb.close();

  if (outcomes.length === 0) {
    console.log(`No outcomes recorded for goal ${match.goal_id.slice(0, 8)}.`);
    return;
  }

  console.log(`\nOutcomes for goal ${match.goal_id.slice(0, 8)} (${outcomes.length}):\n`);
  console.log("  Ran At               Status      Tools  Memories  Summary / Error");
  console.log("  " + "-".repeat(90));

  for (const o of outcomes) {
    const ranAt = new Date(o.ran_at).toISOString().slice(0, 19);
    const status = o.status.padEnd(11);
    const tools = String(o.tool_calls_made).padEnd(6);
    const memories = String(o.memories_formed).padEnd(9);
    const detail =
      o.error_message != null && o.error_message !== ""
        ? `[error: ${o.error_message.slice(0, 40)}]`
        : o.summary != null && o.summary !== ""
          ? o.summary.slice(0, 50)
          : "—";
    console.log(`  ${ranAt}  ${status} ${tools} ${memories} ${detail}`);
  }
  console.log();
}

export async function handleGoalRemove(config: CliConfig): Promise<void> {
  const goalId = config.positionals[2];
  if (goalId == null || goalId === "") {
    console.error("Usage: motebit goal remove <goal_id>");
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);

  // Find goal by prefix match
  const goals = moteDb.goalStore.list(motebitId);
  const match = goals.find((g) => g.goal_id === goalId || g.goal_id.startsWith(goalId));
  if (!match) {
    console.error(`Error: no goal found matching "${goalId}".`);
    moteDb.close();
    process.exit(1);
  }

  moteDb.goalStore.remove(match.goal_id);

  // Log event
  const eventStore = new EventStore(moteDb.eventStore);
  await eventStore.append({
    event_id: crypto.randomUUID(),
    motebit_id: motebitId,
    timestamp: Date.now(),
    event_type: EventType.GoalRemoved,
    payload: { goal_id: match.goal_id },
    version_clock: (await moteDb.eventStore.getLatestClock(motebitId)) + 1,
    tombstoned: false,
  });

  moteDb.close();
  console.log(`Goal removed: ${match.goal_id.slice(0, 8)}`);
}

export async function handleGoalSetEnabled(config: CliConfig, enabled: boolean): Promise<void> {
  const goalId = config.positionals[2];
  const verb = enabled ? "resume" : "pause";
  if (goalId == null || goalId === "") {
    console.error(`Usage: motebit goal ${verb} <goal_id>`);
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);

  const goals = moteDb.goalStore.list(motebitId);
  const match = goals.find((g) => g.goal_id === goalId || g.goal_id.startsWith(goalId));
  if (!match) {
    console.error(`Error: no goal found matching "${goalId}".`);
    moteDb.close();
    process.exit(1);
  }

  moteDb.goalStore.setEnabled(match.goal_id, enabled);
  moteDb.close();
  console.log(`Goal ${verb}d: ${match.goal_id.slice(0, 8)}`);
}

export async function handleApprovalList(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  const items = moteDb.approvalStore.listAll(motebitId);
  moteDb.close();

  if (items.length === 0) {
    console.log("No approvals found.");
    return;
  }

  console.log("ID        | Tool              | Status   | Goal     | Created");
  console.log("--------- | ----------------- | -------- | -------- | --------------------");
  for (const item of items) {
    const id = item.approval_id.slice(0, 8);
    const tool = item.tool_name.slice(0, 17).padEnd(17);
    const status = item.status.padEnd(8);
    const goal = item.goal_id.slice(0, 8);
    const created = new Date(item.created_at).toISOString().slice(0, 19);
    console.log(`${id}  | ${tool} | ${status} | ${goal} | ${created}`);
  }
}

export async function handleApprovalShow(config: CliConfig): Promise<void> {
  const approvalId = config.positionals[2];
  if (approvalId == null || approvalId === "") {
    console.error("Usage: motebit approvals show <approval_id>");
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);

  // Support prefix match
  const all = moteDb.approvalStore.listAll(motebitId);
  const match = all.find(
    (a) => a.approval_id === approvalId || a.approval_id.startsWith(approvalId),
  );
  moteDb.close();

  if (!match) {
    console.error(`Error: no approval found matching "${approvalId}".`);
    process.exit(1);
  }

  console.log(`Approval ID:    ${match.approval_id}`);
  console.log(`Status:         ${match.status}`);
  console.log(`Tool:           ${match.tool_name}`);
  console.log(
    `Risk Level:     ${match.risk_level >= 0 ? (RiskLevel[match.risk_level] ?? match.risk_level) : "unknown"}`,
  );
  console.log(`Goal ID:        ${match.goal_id}`);
  console.log(`Args Preview:   ${match.args_preview.slice(0, 100)}`);
  console.log(`Args Hash:      ${match.args_hash.slice(0, 16)}...`);
  console.log(`Created:        ${new Date(match.created_at).toISOString()}`);
  console.log(`Expires:        ${new Date(match.expires_at).toISOString()}`);
  if (match.resolved_at != null) {
    console.log(`Resolved:       ${new Date(match.resolved_at).toISOString()}`);
  }
  if (match.denied_reason != null && match.denied_reason !== "") {
    console.log(`Denied Reason:  ${match.denied_reason}`);
  }
}

export async function handleApprovalApprove(config: CliConfig): Promise<void> {
  const approvalId = config.positionals[2];
  if (approvalId == null || approvalId === "") {
    console.error("Usage: motebit approvals approve <approval_id>");
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);

  const all = moteDb.approvalStore.listAll(motebitId);
  const match = all.find(
    (a) => a.approval_id === approvalId || a.approval_id.startsWith(approvalId),
  );

  if (!match) {
    console.error(`Error: no approval found matching "${approvalId}".`);
    moteDb.close();
    process.exit(1);
  }

  if (match.status !== "pending") {
    console.error(`Error: approval ${match.approval_id.slice(0, 8)} is already ${match.status}.`);
    moteDb.close();
    process.exit(1);
  }

  moteDb.approvalStore.resolve(match.approval_id, "approved");
  moteDb.close();
  console.log(`Approved: ${match.approval_id.slice(0, 8)} (${match.tool_name})`);
  console.log("The daemon will execute this tool on its next tick.");
}

export async function handleApprovalDeny(config: CliConfig): Promise<void> {
  const approvalId = config.positionals[2];
  if (approvalId == null || approvalId === "") {
    console.error("Usage: motebit approvals deny <approval_id> [--reason <text>]");
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);

  const all = moteDb.approvalStore.listAll(motebitId);
  const match = all.find(
    (a) => a.approval_id === approvalId || a.approval_id.startsWith(approvalId),
  );

  if (!match) {
    console.error(`Error: no approval found matching "${approvalId}".`);
    moteDb.close();
    process.exit(1);
  }

  if (match.status !== "pending") {
    console.error(`Error: approval ${match.approval_id.slice(0, 8)} is already ${match.status}.`);
    moteDb.close();
    process.exit(1);
  }

  moteDb.approvalStore.resolve(match.approval_id, "denied", config.reason);
  moteDb.close();
  console.log(`Denied: ${match.approval_id.slice(0, 8)} (${match.tool_name})`);
  if (config.reason != null && config.reason !== "") {
    console.log(`Reason: ${config.reason}`);
  }
}

// ---------------------------------------------------------------------------
// motebit id — display identity card from config (no file / verification needed)
// ---------------------------------------------------------------------------

export function handleId(): void {
  const config = loadFullConfig();

  if (!config.motebit_id) {
    console.error("No identity found. Run `npm create motebit` or `motebit run` to create one.");
    process.exit(1);
  }

  console.log();
  console.log(`  motebit_id   ${config.motebit_id}`);

  if (config.device_public_key) {
    try {
      console.log(`  did          ${hexPublicKeyToDidKey(config.device_public_key)}`);
    } catch {
      // Non-fatal — key may be invalid
    }
    console.log(`  public_key   ${config.device_public_key.slice(0, 16)}...`);
  }

  if (config.device_id) {
    console.log(`  device_id    ${config.device_id}`);
  }

  console.log(`  config       ${CONFIG_DIR}/config.json`);
  console.log();
}

// ---------------------------------------------------------------------------
// motebit ledger <goalId> — fetch and display a signed execution ledger
// ---------------------------------------------------------------------------

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
  if (syncUrl == null || syncUrl === "") {
    console.error(
      "Error: --sync-url or MOTEBIT_SYNC_URL is required to fetch credentials from the relay.",
    );
    process.exit(1);
  }

  const headers: Record<string, string> = {};
  if (syncToken) {
    headers["Authorization"] = `Bearer ${syncToken}`;
  }

  // If --presentation, fetch a bundled VP
  if (config.presentation) {
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

  // Default: list credentials
  const url = `${syncUrl.replace(/\/$/, "")}/api/v1/agents/${motebitId}/credentials`;
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

  const credBody = (await res.json()) as {
    motebit_id: string;
    credentials: Array<{
      credential_id: string;
      credential_type: string;
      credential: { issuer: string; credentialSubject: { id: string }; validFrom: string };
      issued_at: number;
    }>;
  };

  if (config.json) {
    console.log(JSON.stringify(credBody, null, 2));
    return;
  }

  if (credBody.credentials.length === 0) {
    console.log("No credentials found.");
    return;
  }

  console.log(`\nCredentials (${credBody.credentials.length}):\n`);
  console.log("  ID        Type                         Issuer           Issued At");
  console.log("  " + "-".repeat(80));
  for (const cred of credBody.credentials) {
    const id = cred.credential_id.slice(0, 8);
    const type = cred.credential_type.slice(0, 28).padEnd(28);
    const issuer = cred.credential.issuer.slice(0, 16);
    const issuedAt = new Date(cred.issued_at).toISOString().slice(0, 19);
    console.log(`  ${id}  ${type} ${issuer} ${issuedAt}`);
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
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        passphrase = await new Promise<string>((resolve) => {
          rl.question("Passphrase (to sign registration): ", (answer) => {
            rl.close();
            resolve(answer);
          });
        });
      }
      const pkHex = await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
      privateKeyBytes = fromHex(pkHex);
    } catch {
      console.warn("Warning: could not decrypt private key — registration proceeds unsigned");
    }
  }

  // Step 1: Register device (public key binding) with the relay
  const registerBody: Record<string, string> = {
    motebit_id: motebitId,
    device_name: deviceId,
    public_key: publicKeyHex,
  };

  let registerResp: Response;
  try {
    registerResp = await fetch(`${syncUrl}/device/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: could not reach relay at ${syncUrl}: ${msg}`);
    process.exit(1);
  }

  // 404 means the relay has no record of this identity yet — that's expected for a
  // fresh registration before any sync events have been pushed.  Treat it as a soft
  // failure and continue so the operator can still set up the sync URL locally.
  if (!registerResp.ok && registerResp.status !== 404) {
    const text = await registerResp.text();
    console.error(
      `Error: relay registration failed (${registerResp.status}): ${text.slice(0, 200)}`,
    );
    process.exit(1);
  }

  const registered = registerResp.ok;

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

  if (registered) {
    console.log(`Registered ${motebitId.slice(0, 8)}... with relay at ${syncUrl}`);
  } else {
    // 404: relay doesn't have this identity yet (first ever sync)
    console.log(
      `Identity ${motebitId.slice(0, 8)}... not yet on relay — sync URL saved to config.`,
    );
    console.log(`Run the REPL with --sync-url ${syncUrl} to push your events, then re-register.`);
  }

  // Erase temporary private key bytes
  if (privateKeyBytes) secureErase(privateKeyBytes);
}
