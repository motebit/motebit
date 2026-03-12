// --- CLI subcommand handlers (non-REPL) ---

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { openMotebitDatabase } from "@motebit/persistence";
import { EventStore } from "@motebit/event-log";
import { EventType, RiskLevel } from "@motebit/sdk";
import {
  generate as generateIdentityFile,
} from "@motebit/identity-file";
import { hexPublicKeyToDidKey } from "@motebit/crypto";
import type { CliConfig } from "./args.js";
import {
  CONFIG_DIR,
  loadFullConfig,
  saveFullConfig,
} from "./config.js";
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
  moteDb.close();

  // Reload config (may have been updated by bootstrap)
  const updatedConfig = loadFullConfig();

  // Decrypt private key
  if (!updatedConfig.cli_encrypted_key) {
    console.error("Error: no encrypted key found in config.");
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
  const content = await generateIdentityFile(
    {
      motebitId,
      ownerId: motebitId,
      publicKeyHex,
      devices,
    },
    privateKey,
  );

  // Determine output path
  const outputPath =
    config.output != null && config.output !== ""
      ? path.resolve(config.output)
      : path.resolve("motebit.md");

  fs.writeFileSync(outputPath, content, "utf-8");
  console.log(`Your agent identity file has been created: ${outputPath}`);
  rl.close();
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
