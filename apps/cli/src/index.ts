import * as readline from "node:readline";
import { DEFAULT_CONFIG } from "@motebit/ai-core";
import type { MotebitPersonalityConfig } from "@motebit/ai-core";
import { deriveSyncEncryptionKey } from "@motebit/crypto";
import { connectMcpServers } from "@motebit/mcp-client";
import { formatBodyAwareness } from "@motebit/ai-core";
import { parseCliArgs, printHelp, printVersion, printBanner, trimHistory } from "./args.js";
import type { CliConfig } from "./args.js";
import { loadFullConfig, extractPersonality, persistMotebitPublicKeys } from "./config.js";
import {
  promptPassphrase,
  encryptPrivateKey,
  decryptPrivateKey,
  bootstrapIdentity,
  fromHex,
} from "./identity.js";
import {
  getDbPath,
  buildToolRegistry,
  createRuntime,
  openMotebitDatabase,
} from "./runtime-factory.js";
import { consumeStream } from "./stream.js";
import { isSlashCommand, parseSlashCommand, handleSlashCommand } from "./slash-commands.js";
import type { ReplContext } from "./slash-commands.js";
import {
  handleDoctor,
  handleExport,
  handleVerify,
  handleGoalAdd,
  handleGoalList,
  handleGoalOutcomes,
  handleGoalRemove,
  handleGoalSetEnabled,
  handleApprovalList,
  handleApprovalShow,
  handleApprovalApprove,
  handleApprovalDeny,
  handleId,
  handleLedger,
  handleCredentials,
  handleRegister,
  handleFederationStatus,
  handleFederationPeers,
  handleFederationPeer,
} from "./subcommands.js";
import { handleRun, handleServe } from "./daemon.js";
import { formatMs, formatTimeAgo } from "./utils.js";

// --- Re-exports for tests and external consumers ---
export {
  parseCliArgs,
  printHelp,
  printVersion,
  trimHistory,
  isSlashCommand,
  parseSlashCommand,
  handleSlashCommand,
  formatMs,
  formatTimeAgo,
};
export type { CliConfig, ReplContext };

// --- REPL ---

async function main(): Promise<void> {
  let config: CliConfig;
  try {
    config = parseCliArgs();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    printHelp();
    process.exit(1);
  }

  if (config.help) {
    printHelp();
    return;
  }
  if (config.version) {
    printVersion();
    return;
  }

  // --- Subcommands: export / verify ---

  const subcommand = config.positionals[0];

  if (subcommand === "verify") {
    const filePath = config.positionals[1];
    if (filePath == null || filePath === "") {
      console.error("Usage: motebit verify <path>");
      process.exit(1);
    }
    await handleVerify(filePath);
    return;
  }

  if (subcommand === "id") {
    handleId();
    return;
  }

  if (subcommand === "doctor") {
    await handleDoctor();
    return;
  }

  if (subcommand === "export") {
    await handleExport(config);
    return;
  }

  if (subcommand === "register") {
    await handleRegister(config);
    return;
  }

  if (subcommand === "run") {
    await handleRun(config);
    return;
  }

  if (subcommand === "serve") {
    await handleServe(config);
    return;
  }

  if (subcommand === "approvals") {
    const approvalCmd = config.positionals[1];
    if (approvalCmd === "list") {
      await handleApprovalList(config);
    } else if (approvalCmd === "show") {
      await handleApprovalShow(config);
    } else if (approvalCmd === "approve") {
      await handleApprovalApprove(config);
    } else if (approvalCmd === "deny") {
      await handleApprovalDeny(config);
    } else {
      console.error("Usage: motebit approvals [list|show|approve|deny]");
      process.exit(1);
    }
    return;
  }

  if (subcommand === "ledger") {
    await handleLedger(config);
    return;
  }

  if (subcommand === "credentials") {
    await handleCredentials(config);
    return;
  }

  if (subcommand === "federation") {
    const fedCmd = config.positionals[1];
    if (fedCmd === "status") {
      await handleFederationStatus(config);
    } else if (fedCmd === "peers") {
      await handleFederationPeers(config);
    } else if (fedCmd === "peer") {
      await handleFederationPeer(config);
    } else {
      console.error("Usage: motebit federation [status|peers|peer <url>]");
      process.exit(1);
    }
    return;
  }

  if (subcommand === "goal") {
    const goalCmd = config.positionals[1];
    if (goalCmd === "add") {
      await handleGoalAdd(config);
    } else if (goalCmd === "list") {
      await handleGoalList(config);
    } else if (goalCmd === "outcomes") {
      await handleGoalOutcomes(config);
    } else if (goalCmd === "remove") {
      await handleGoalRemove(config);
    } else if (goalCmd === "pause") {
      await handleGoalSetEnabled(config, false);
    } else if (goalCmd === "resume") {
      await handleGoalSetEnabled(config, true);
    } else {
      console.error("Usage: motebit goal [add|list|outcomes|remove|pause|resume]");
      process.exit(1);
    }
    return;
  }

  // Load full config (personality + identity + MCP)
  const fullConfig = loadFullConfig();
  const personalityConfig: MotebitPersonalityConfig = {
    ...DEFAULT_CONFIG,
    ...extractPersonality(fullConfig),
  };

  if (personalityConfig.default_provider && !process.argv.includes("--provider")) {
    const validProviders = ["anthropic", "ollama"] as const;
    if (validProviders.includes(personalityConfig.default_provider)) {
      config.provider = personalityConfig.default_provider!;
    }
  }
  if (
    personalityConfig.default_model != null &&
    personalityConfig.default_model !== "" &&
    !process.argv.includes("--model")
  ) {
    config.model = personalityConfig.default_model;
  }

  // Create readline early for passphrase prompts
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Resolve passphrase for key encryption
  const envPassphrase = process.env["MOTEBIT_PASSPHRASE"];
  let passphrase: string;

  if (fullConfig.cli_encrypted_key) {
    // Existing encrypted key — need passphrase to decrypt
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
    // Migration: plaintext key exists — encrypt it
    console.log("Migrating private key to encrypted storage...");
    passphrase =
      envPassphrase ?? (await promptPassphrase(rl, "Set a passphrase for key encryption: "));
    if (passphrase === "") {
      console.error("Error: passphrase cannot be empty.");
      rl.close();
      process.exit(1);
    }
    fullConfig.cli_encrypted_key = await encryptPrivateKey(fullConfig.cli_private_key, passphrase);
    delete fullConfig.cli_private_key;
    const { saveFullConfig } = await import("./config.js");
    saveFullConfig(fullConfig);
    console.log("Private key encrypted and plaintext removed.");
  } else {
    // First launch — prompt for new passphrase
    passphrase =
      envPassphrase ?? (await promptPassphrase(rl, "Set a passphrase for your mote's key: "));
    if (!passphrase) {
      console.error("Error: passphrase cannot be empty.");
      rl.close();
      process.exit(1);
    }
  }

  // Bootstrap identity — need DB first for identity storage
  const dbPath = getDbPath(config.dbPath);
  const tempDb = await openMotebitDatabase(dbPath);
  const { motebitId, isFirstLaunch } = await bootstrapIdentity(tempDb, fullConfig, passphrase);
  tempDb.close();

  if (isFirstLaunch) {
    console.log(`\nYour mote has been created: ${motebitId.slice(0, 8)}...`);
    console.log("Identity and encrypted keypair stored in ~/.motebit/config.json\n");
  }

  // Derive sync encryption key from private key (for zero-knowledge relay)
  const reloadedConfig = loadFullConfig();
  let syncEncKey: Uint8Array | undefined;
  let privateKeyBytes: Uint8Array | undefined;
  if (reloadedConfig.cli_encrypted_key) {
    const pkHex = await decryptPrivateKey(reloadedConfig.cli_encrypted_key, passphrase);
    privateKeyBytes = fromHex(pkHex);
    syncEncKey = await deriveSyncEncryptionKey(privateKeyBytes);
  }
  const deviceId = reloadedConfig.device_id;

  // Build tool registry with deferred runtime ref
  const runtimeRef: { current: import("@motebit/runtime").MotebitRuntime | null } = {
    current: null,
  };
  const toolRegistry = buildToolRegistry(config, runtimeRef, motebitId);

  // MCP servers from config — overlay trust from trusted list, inject caller identity for motebit servers
  const trustedServers = fullConfig.mcp_trusted_servers ?? [];
  const mcpServers = (fullConfig.mcp_servers ?? []).map((s) => ({
    ...s,
    trusted: trustedServers.includes(s.name),
    // Inject caller identity for motebit-to-motebit connections
    ...(s.motebit && privateKeyBytes && deviceId
      ? {
          callerMotebitId: motebitId,
          callerDeviceId: deviceId,
          callerPrivateKey: privateKeyBytes,
        }
      : {}),
  }));

  // Create runtime with tools, policy, MCP config
  const { runtime, moteDb } = await createRuntime(
    config,
    motebitId,
    toolRegistry,
    mcpServers,
    personalityConfig,
    syncEncKey,
  );
  runtimeRef.current = runtime;

  // Connect MCP servers
  let mcpAdapters: Awaited<ReturnType<typeof connectMcpServers>> = [];
  if (mcpServers.length > 0) {
    try {
      mcpAdapters = await connectMcpServers(mcpServers, toolRegistry);
      // Re-wire loop deps since registry grew
      runtime.getToolRegistry().merge(toolRegistry);
      console.log(`MCP: connected to ${mcpAdapters.length} server(s)`);

      // Persist newly pinned motebit public keys
      persistMotebitPublicKeys(mcpAdapters, fullConfig);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`MCP connection failed: ${message}`);
    }
  }

  // Init runtime (renderer + MCP handled above)
  await runtime.init();

  // Initial sync
  try {
    console.log("Syncing...");
    const result = await runtime.sync.sync();
    console.log(`Synced: pulled ${result.pulled} events, pushed ${result.pushed} events`);
    if (result.conflicts.length > 0) {
      console.log(`  [${result.conflicts.length} conflicts detected]`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Sync failed (continuing offline): ${message}`);
  }

  const shutdown = async (): Promise<void> => {
    runtime.stop();
    // Disconnect MCP servers
    await Promise.allSettled(mcpAdapters.map((a) => a.disconnect()));
    try {
      const result = await runtime.sync.sync();
      console.log(`Synced on exit: pushed ${result.pushed}, pulled ${result.pulled}`);
    } catch {
      console.warn("Sync on exit failed (changes saved locally)");
    }
    moteDb.close();
  };

  process.on("SIGINT", () => {
    console.log("\nGoodbye!");
    void shutdown().then(() => process.exit(0));
  });

  const toolCount = toolRegistry.size;
  const goalCount = moteDb.goalStore.list(motebitId).filter((g) => g.status === "active").length;
  console.log();
  printBanner({
    motebitId,
    provider: config.provider,
    model: config.model,
    toolCount,
    goalCount,
    operator: config.operator,
  });
  console.log();

  const prompt = (): void => {
    rl.question("you> ", (line) => {
      void handleLine(line);
    });
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();

    if (trimmed === "quit" || trimmed === "exit") {
      console.log("Goodbye!");
      await shutdown();
      rl.close();
      return;
    }

    if (trimmed === "") {
      prompt();
      return;
    }

    if (isSlashCommand(trimmed)) {
      const { command, args } = parseSlashCommand(trimmed);
      await handleSlashCommand(command, args, runtime, config, fullConfig, {
        moteDb,
        motebitId,
        mcpAdapters,
        privateKeyBytes,
        deviceId,
      });
      console.log();
      prompt();
      return;
    }

    try {
      const chatRunId = crypto.randomUUID();
      if (config.noStream) {
        const result = await runtime.sendMessage(trimmed, chatRunId);

        console.log(`\nmote> ${result.response}\n`);

        if (result.memoriesFormed.length > 0) {
          console.log(`  [memories: ${result.memoriesFormed.map((m) => m.content).join(", ")}]`);
        }

        const s = result.stateAfter;
        console.log(
          `  [state: attention=${s.attention.toFixed(2)} confidence=${s.confidence.toFixed(2)} valence=${s.affect_valence.toFixed(2)} curiosity=${s.curiosity.toFixed(2)}]`,
        );
        const bodyLine = formatBodyAwareness(result.cues);
        if (bodyLine) console.log(`  ${bodyLine}`);
        console.log();
      } else {
        process.stdout.write("\nmote> ");
        await consumeStream(runtime.sendMessageStreaming(trimmed, chatRunId), runtime, rl);
      }
      // Best-effort auto-title after enough messages
      void runtime.autoTitle();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  [error: ${message}]\n`);
    }

    prompt();
  };

  prompt();
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
