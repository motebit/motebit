import * as readline from "node:readline";
import { DEFAULT_CONFIG } from "@motebit/ai-core";
import type { MotebitPersonalityConfig } from "@motebit/ai-core";
import { deriveSyncEncryptionKey, createSignedToken } from "@motebit/crypto";
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
import { readInput, enableBracketedPaste, disableBracketedPaste } from "./input.js";
import {
  prompt as promptColor,
  meta,
  error as errorColor,
  dim,
  success,
  bold,
  cyan,
} from "./colors.js";
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
  handleRotate,
  handleFederationStatus,
  handleFederationPeers,
  handleFederationPeer,
  handleBalance,
  handleWithdraw,
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
    const filePath = config.positionals[1] ?? "motebit.md";
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

  if (subcommand === "rotate") {
    await handleRotate(config);
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

  if (subcommand === "balance") {
    await handleBalance(config);
    return;
  }

  if (subcommand === "withdraw") {
    await handleWithdraw(config);
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
    const validProviders = ["anthropic", "openai", "ollama"] as const;
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
  if (fullConfig.max_tokens != null && !process.argv.includes("--max-tokens")) {
    config.maxTokens = fullConfig.max_tokens;
  }

  // --- The creature is the onboarding ---
  // The droplet is present from the first byte. It speaks in its own voice,
  // guiding you through setup. No mechanical wizard, no "run again" exits.

  const isFirstLaunchFlow =
    !fullConfig.cli_encrypted_key &&
    (fullConfig.cli_private_key == null || fullConfig.cli_private_key === "");

  // Show the droplet on first launch — the creature arrives before anything else.
  // The greeting only shows when the API key is also missing (true first contact).
  // If the user already has a key, they saw the intro last run — skip to passphrase.
  const hasApiKey =
    (config.provider === "anthropic" && process.env["ANTHROPIC_API_KEY"]) ||
    (config.provider === "openai" && process.env["OPENAI_API_KEY"]) ||
    config.provider === "ollama" ||
    config.provider === "hybrid";

  if (isFirstLaunchFlow) {
    console.log();
    console.log(dim("         ."));
    console.log(dim("       .:::."));
    console.log(dim("      .:::::."));
    console.log(dim("      :::::::"));
    console.log(dim("      ':::::' "));
    console.log(dim("        '''"));
    console.log();
    if (!hasApiKey) {
      console.log(`  ${dim("Hello. I'm your mote — a small, curious being.")}`);
      console.log(`  ${dim("Let me get set up so I can think.")}`);
      console.log();
    }
  }

  // API key — the creature asks for what it needs
  if (config.provider === "anthropic") {
    const key = process.env["ANTHROPIC_API_KEY"];
    if (key == null || key === "") {
      if (isFirstLaunchFlow) {
        console.log(`  ${dim("I need an API key to think. You can get one here:")}`);
      } else {
        console.log();
        console.log(`  ${dim("─")} ${bold("motebit")}${dim(" needs an API key to think")}`);
      }
      console.log();
      console.log(`     ${cyan("https://console.anthropic.com/settings/keys")}`);
      console.log();
      console.log(`  ${dim("Then add it to your shell:")}`);
      console.log();
      console.log(`     ${dim("echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.zshrc")}`);
      console.log(`     ${dim("source ~/.zshrc")}`);
      console.log();
      if (isFirstLaunchFlow) {
        console.log(
          `  ${dim("Run")} ${bold("motebit")} ${dim("when you're ready. I'll be here.")}`,
        );
      } else {
        console.log(`  ${dim("Run")} ${bold("motebit")} ${dim("again.")}`);
      }
      console.log();
      console.log(`  ${dim("Or run locally without a key:")} ${bold("motebit --provider ollama")}`);
      console.log();
      return;
    }

    // Validate the key before expensive passphrase/PBKDF2 flow
    try {
      const resp = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!resp.ok) {
        console.log();
        console.log(`  ${dim("That key didn't work. Check it here:")}`);
        console.log();
        console.log(`     ${cyan("https://console.anthropic.com/settings/keys")}`);
        console.log();
        return;
      }
    } catch {
      // Network error — let it through, will fail later with context
    }
  } else if (config.provider === "openai") {
    const key = process.env["OPENAI_API_KEY"];
    if (key == null || key === "") {
      if (isFirstLaunchFlow) {
        console.log(`  ${dim("I need an API key to think. You can get one here:")}`);
      } else {
        console.log();
        console.log(`  ${dim("─")} ${bold("motebit")}${dim(" needs an API key to think")}`);
      }
      console.log();
      console.log(`     ${cyan("https://platform.openai.com/api-keys")}`);
      console.log();
      console.log(`  ${dim("Then add it to your shell:")}`);
      console.log();
      console.log(`     ${dim("echo 'export OPENAI_API_KEY=sk-...' >> ~/.zshrc")}`);
      console.log(`     ${dim("source ~/.zshrc")}`);
      console.log();
      if (isFirstLaunchFlow) {
        console.log(
          `  ${dim("Run")} ${bold("motebit")} ${dim("when you're ready. I'll be here.")}`,
        );
      } else {
        console.log(`  ${dim("Run")} ${bold("motebit")} ${dim("again.")}`);
      }
      console.log();
      console.log(`  ${dim("Or run locally without a key:")} ${bold("motebit --provider ollama")}`);
      console.log();
      return;
    }

    // Validate the key before expensive passphrase/PBKDF2 flow
    try {
      const resp = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!resp.ok) {
        console.log();
        console.log(`  ${dim("That key didn't work. Check it here:")}`);
        console.log();
        console.log(`     ${cyan("https://platform.openai.com/api-keys")}`);
        console.log();
        return;
      }
    } catch {
      // Network error — let it through, will fail later with context
    }
  }

  // Passphrase — the creature explains why
  const envPassphrase = process.env["MOTEBIT_PASSPHRASE"];
  let passphrase: string;

  if (fullConfig.cli_encrypted_key) {
    // Returning user — just the prompt
    passphrase = envPassphrase ?? (await promptPassphrase("  Passphrase: "));
    try {
      await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
    } catch {
      console.log();
      console.log(`  ${dim("That wasn't right. Try again, or start fresh:")}`);
      console.log();
      console.log(`     ${dim("rm ~/.motebit/config.json")}`);
      console.log(`     ${dim("motebit")}`);
      console.log();
      process.exit(1);
    }
  } else if (fullConfig.cli_private_key != null && fullConfig.cli_private_key !== "") {
    // Migration: plaintext key exists — encrypt it
    console.log(dim("  Migrating your key to encrypted storage..."));
    passphrase = envPassphrase ?? (await promptPassphrase("  Set a passphrase: "));
    if (passphrase === "") {
      console.error("  Passphrase cannot be empty.");
      process.exit(1);
    }
    fullConfig.cli_encrypted_key = await encryptPrivateKey(fullConfig.cli_private_key, passphrase);
    delete fullConfig.cli_private_key;
    const { saveFullConfig } = await import("./config.js");
    saveFullConfig(fullConfig);
    console.log(dim("  Done — plaintext key removed."));
  } else {
    // First launch — the creature explains identity
    console.log(`  ${dim("I need a passphrase to protect my keypair.")}`);
    console.log(`  ${dim("This is my identity — I'll ask for it each session.")}`);
    console.log();
    passphrase = envPassphrase ?? (await promptPassphrase("  Set a passphrase: "));
    if (!passphrase) {
      console.error("  Passphrase cannot be empty.");
      process.exit(1);
    }
    if (!envPassphrase) {
      const confirm = await promptPassphrase("  Confirm: ");
      if (confirm !== passphrase) {
        console.log();
        console.log(
          `  ${dim("Those didn't match. Run")} ${bold("motebit")} ${dim("to try again.")}`,
        );
        console.log();
        process.exit(1);
      }
    }
  }

  enableBracketedPaste();

  // Readline is created lazily — only when the approval flow in consumeStream
  // needs it. Keeping readline connected to stdin at all times interferes with
  // raw-mode input (readInput) by echoing paste content before the handler sees it.
  let rl: readline.Interface | null = null;
  const getOrCreateRl = (): readline.Interface => {
    if (!rl) {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        escapeCodeTimeout: 50,
      });
    }
    return rl;
  };

  // Bootstrap identity — need DB first for identity storage
  const dbPath = getDbPath(config.dbPath);
  const tempDb = await openMotebitDatabase(dbPath);
  const { motebitId, isFirstLaunch } = await bootstrapIdentity(tempDb, fullConfig, passphrase);
  tempDb.close();

  if (isFirstLaunch) {
    console.log();
    console.log(
      `  ${dim("I'm")} ${cyan(motebitId.slice(0, 8))}${dim(". My keypair is stored in ~/.motebit/")}`,
    );
    console.log();
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

  // Enable interactive delegation if relay + signing keys are available
  const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"] ?? reloadedConfig.sync_url;
  if (syncUrl && privateKeyBytes && deviceId) {
    const pk = privateKeyBytes; // capture for closure
    const did = deviceId;
    runtime.enableInteractiveDelegation({
      syncUrl,
      authToken: async () => {
        const now = Date.now();
        return createSignedToken(
          {
            mid: motebitId,
            did,
            iat: now,
            exp: now + 5 * 60 * 1000,
            jti: crypto.randomUUID(),
            aud: "task:submit",
          },
          pk,
        );
      },
      routingStrategy: config.routingStrategy,
    });
  }

  // Initial sync — only attempt if a remote sync URL was configured
  const hasSyncRemote =
    config.syncUrl != null ||
    process.env["MOTEBIT_SYNC_URL"] != null ||
    (reloadedConfig.sync_url != null && reloadedConfig.sync_url !== "");
  if (hasSyncRemote) {
    try {
      console.log(dim("Syncing..."));
      const result = await runtime.sync.sync();
      console.log(dim(`Synced: pulled ${result.pulled} events, pushed ${result.pushed} events`));
      if (result.conflicts.length > 0) {
        console.log(`  [${result.conflicts.length} conflicts detected]`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Sync failed (continuing offline): ${message}`);
    }

    // Register device with relay so other agents can resolve our public key
    if (syncUrl && privateKeyBytes && deviceId && reloadedConfig.device_public_key) {
      try {
        const resp = await fetch(`${syncUrl}/api/v1/agents/bootstrap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            motebit_id: motebitId,
            device_id: deviceId,
            public_key: reloadedConfig.device_public_key,
          }),
        });
        if (!resp.ok && resp.status !== 200 && resp.status !== 201) {
          const body = await resp.text();
          // 409 = already registered with same key, that's fine
          if (resp.status !== 409) {
            console.warn(`Device registration: ${resp.status} ${body}`);
          }
        }
      } catch {
        // Best-effort — relay may be unreachable
      }
    }

    // Discover remote agents and populate service listings for interactive delegation
    if (syncUrl) {
      try {
        const token = config.syncToken ?? process.env["MOTEBIT_API_TOKEN"];
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const resp = await fetch(`${syncUrl}/api/v1/agents/discover`, { headers });
        if (resp.ok) {
          const data = (await resp.json()) as {
            agents: Array<{
              motebit_id: string;
              capabilities: string[];
              endpoint_url?: string;
            }>;
          };
          // Filter out self, populate service listings for agents with capabilities
          const others = data.agents.filter(
            (a) => a.motebit_id !== motebitId && a.capabilities.length > 0,
          );
          for (const agent of others) {
            await runtime.registerServiceListing({
              motebit_id: agent.motebit_id,
              capabilities: agent.capabilities,
              pricing: [],
              sla: { max_latency_ms: 30_000, availability_guarantee: 0.99 },
              description: agent.capabilities.join(", "),
            });
          }
          if (others.length > 0) {
            console.log(success(`Discovered ${others.length} agent(s) on the network`));
          }
        }
      } catch {
        // Discovery is best-effort — offline mode still works
      }
    }
  }

  const shutdown = async (): Promise<void> => {
    disableBracketedPaste();
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
    readInput(promptColor("you>") + " ").then(
      (line) => void handleLine(line),
      () => {}, // Ignore errors (e.g. stdin closed)
    );
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();

    if (trimmed === "quit" || trimmed === "exit") {
      console.log("Goodbye!");
      await shutdown();
      rl?.close();
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

        console.log(`\n${promptColor("mote>")} ${result.response}\n`);

        if (result.memoriesFormed.length > 0) {
          console.log(
            meta(`  [memories: ${result.memoriesFormed.map((m) => m.content).join(", ")}]`),
          );
        }

        const s = result.stateAfter;
        console.log(
          meta(
            `  [state: attention=${s.attention.toFixed(2)} confidence=${s.confidence.toFixed(2)} valence=${s.affect_valence.toFixed(2)} curiosity=${s.curiosity.toFixed(2)}]`,
          ),
        );
        const bodyLine = formatBodyAwareness(result.cues);
        if (bodyLine) console.log(meta(`  ${bodyLine}`));
        console.log();
      } else {
        process.stdout.write("\n" + promptColor("mote>") + " ");
        const streamRl = getOrCreateRl();
        await consumeStream(runtime.sendMessageStreaming(trimmed, chatRunId), runtime, streamRl);
        // Close readline after each stream so it doesn't interfere with next readInput
        streamRl.close();
        rl = null;
      }
      // Best-effort auto-title after enough messages
      void runtime.autoTitle();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  ${errorColor("[error: " + message + "]")}\n`);
    }

    prompt();
  };

  prompt();
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
