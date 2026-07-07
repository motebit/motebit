import { DEFAULT_CONFIG } from "@motebit/ai-core";
import type { MotebitPersonalityConfig } from "@motebit/ai-core";
import { deriveSyncEncryptionKey, createSignedToken } from "@motebit/encryption";
import { connectMcpServers } from "@motebit/mcp-client";
import { formatBodyAwareness } from "@motebit/ai-core";
import { providerAcceptsModel } from "@motebit/sdk";
import { createSolanaWalletRail } from "@motebit/wallet-solana";
import { preflightGrant, renderPreflight } from "./grant-preflight.js";
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
import { readInput, writeOutput, initTerminal, destroyTerminal } from "./terminal.js";
import { electCliRuntimeHost } from "./runtime-host.js";
import { runAttachedRepl } from "./attached-repl.js";
import type { ElectionOutcome } from "@motebit/runtime-host";
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
  handleAttest,
  handleDoctor,
  handleExport,
  handleVerify,
  handleGrantCreate,
  handleGrantList,
  handleGrantShow,
  handleGrantRevoke,
  createGrantPresenter,
  loadStoredGrant,
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
  handleInit,
  handleLedger,
  handleLogs,
  handleLsp,
  handleSchema,
  handleSmokeReconciliation,
  handleSmokeX402,
  handleVerifyWire,
  isVerifyKind,
  handlePs,
  handleUp,
  handleCredentials,
  handleRegister,
  handleRelayUp,
  handleRotate,
  handleFederationStatus,
  handleFederationPeers,
  handleFederationPeer,
  handleFederationPeerRemove,
  handleFederationMesh,
  handleBalance,
  handleFund,
  handleDelegate,
  handleDiscover,
  handleMigrate,
  handleMigrateKeyring,
  handleWithdraw,
  handleWallet,
  handleWalletSwap,
  handleSkillsInstall,
  handleSkillsAudit,
  handleSkillsList,
  handleSkillsEnable,
  handleSkillsDisable,
  handleSkillsRemove,
  handleSkillsVerify,
  handleSkillsTrust,
  handleSkillsUntrust,
  handleSkillsPublish,
  handleSkillsRunScript,
} from "./subcommands/index.js";
import { handleRun, handleServe } from "./daemon.js";
import { formatMs, formatTimeAgo } from "./utils.js";
import { VoiceController } from "./voice.js";

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
    // Two-form dispatch:
    //   motebit verify <kind> <path>      — wire-format artifacts (receipt | token | listing)
    //   motebit verify identity <path>    — explicit identity file
    //   motebit verify [path]             — backward-compat: 1 arg = identity file
    const first = config.positionals[1];
    const second = config.positionals[2];
    if (first === "identity") {
      await handleVerify(second ?? "motebit.md");
    } else if (first != null && isVerifyKind(first)) {
      await handleVerifyWire(first, second, { json: config.json });
    } else {
      await handleVerify(first ?? "motebit.md");
    }
    return;
  }

  if (subcommand === "id") {
    handleId();
    return;
  }

  if (subcommand === "wallet") {
    if (config.positionals[1] === "swap") {
      await handleWalletSwap(config.positionals[2], { rpcUrl: config.solanaRpcUrl });
      return;
    }
    await handleWallet({
      rpcUrl: config.solanaRpcUrl,
      addressOnly: config.walletAddressOnly,
    });
    return;
  }

  if (subcommand === "attest") {
    await handleAttest(config);
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

  if (subcommand === "fund") {
    await handleFund(config);
    return;
  }

  if (subcommand === "delegate") {
    await handleDelegate(config);
    return;
  }

  if (subcommand === "withdraw") {
    await handleWithdraw(config);
    return;
  }

  if (subcommand === "discover") {
    await handleDiscover(config);
    return;
  }

  if (subcommand === "migrate") {
    await handleMigrate(config);
    return;
  }

  if (subcommand === "migrate-keyring") {
    await handleMigrateKeyring(config);
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
    } else if (fedCmd === "peer-remove") {
      await handleFederationPeerRemove(config);
    } else if (fedCmd === "mesh") {
      await handleFederationMesh(config);
    } else {
      console.error(
        "Usage: motebit federation [status|peers|peer <url>|peer-remove <url>|mesh <url1> <url2> ...]",
      );
      process.exit(1);
    }
    return;
  }

  if (subcommand === "relay") {
    const relayCmd = config.positionals[1];
    if (relayCmd === "up") {
      await handleRelayUp(config);
    } else {
      console.error("Usage: motebit relay up [--port|--db-path|--pay-to-address|...]");
      process.exit(1);
    }
    return;
  }

  if (subcommand === "smoke") {
    const smokeCmd = config.positionals[1];
    if (smokeCmd === "reconciliation") {
      await handleSmokeReconciliation(config);
    } else if (smokeCmd === "x402") {
      await handleSmokeX402(config);
    } else {
      console.error(
        "Usage: motebit smoke [reconciliation|x402] [--mainnet] [--sync-token <token>]",
      );
      process.exit(1);
    }
    return;
  }

  if (subcommand === "init") {
    handleInit(config);
    return;
  }

  if (subcommand === "up") {
    await handleUp(config);
    return;
  }

  if (subcommand === "ps") {
    await handlePs(config);
    return;
  }

  if (subcommand === "logs") {
    await handleLogs(config);
    return;
  }

  if (subcommand === "lsp") {
    handleLsp();
    return;
  }

  if (subcommand === "schema") {
    handleSchema();
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

  if (subcommand === "grant") {
    const grantCmd = config.positionals[1];
    if (grantCmd === "create") {
      await handleGrantCreate(config);
    } else if (grantCmd === "list") {
      handleGrantList();
    } else if (grantCmd === "show") {
      handleGrantShow(config.positionals[2]);
    } else if (grantCmd === "revoke") {
      await handleGrantRevoke(config.positionals[2]);
    } else {
      console.error("Usage: motebit grant [create|list|show|revoke]");
      process.exit(1);
    }
    return;
  }

  if (subcommand === "skills") {
    const skillsCmd = config.positionals[1];
    if (skillsCmd === "install") {
      await handleSkillsInstall(config);
    } else if (skillsCmd === "list" || skillsCmd === undefined) {
      await handleSkillsList(config);
    } else if (skillsCmd === "enable") {
      await handleSkillsEnable(config);
    } else if (skillsCmd === "disable") {
      await handleSkillsDisable(config);
    } else if (skillsCmd === "remove") {
      await handleSkillsRemove(config);
    } else if (skillsCmd === "verify") {
      await handleSkillsVerify(config);
    } else if (skillsCmd === "trust") {
      await handleSkillsTrust(config);
    } else if (skillsCmd === "untrust") {
      await handleSkillsUntrust(config);
    } else if (skillsCmd === "publish") {
      await handleSkillsPublish(config);
    } else if (skillsCmd === "run-script") {
      await handleSkillsRunScript(config);
    } else if (skillsCmd === "audit") {
      handleSkillsAudit(config);
    } else {
      console.error(
        "Usage: motebit skills [list|install <dir|did:key:…/name@version>|publish <dir>|enable <name>|disable <name>|remove <name>|verify <name>|trust <name>|untrust <name>|audit [skill-name] [--type=…] [--limit=N] [--json]|run-script <skill> <script> [args...]]",
      );
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
    const validProviders = ["anthropic", "openai", "google", "local-server", "proxy"] as const;
    if (validProviders.includes(personalityConfig.default_provider)) {
      config.provider = personalityConfig.default_provider;
    }
  }
  if (
    personalityConfig.default_model != null &&
    personalityConfig.default_model !== "" &&
    !process.argv.includes("--model")
  ) {
    // Config residue yields politely: a default_model from a previous
    // provider era must not ride along onto a different provider (the
    // 2026-07-06 "anthropic · llama3.2:latest" pairing — pre-flight
    // admission per intelligence-pluggability-contract). The per-provider
    // parse-time default already sits on config.model; keep it and say so.
    if (providerAcceptsModel(config.provider, personalityConfig.default_model)) {
      config.model = personalityConfig.default_model;
    } else {
      console.log(
        dim(
          `  [config default_model "${personalityConfig.default_model}" belongs to another provider; using ${config.model} for ${config.provider}]`,
        ),
      );
    }
  }
  // An EXPLICIT contradiction fails loud at startup, naming both — never
  // deferred to an opaque first-call API error.
  if (process.argv.includes("--model") && !providerAcceptsModel(config.provider, config.model)) {
    console.error(
      `Model "${config.model}" does not belong to provider "${config.provider}" — ` +
        `pick a matching pair (e.g. --provider anthropic --model claude-sonnet-4-6), ` +
        `or drop --model to use the provider's default.`,
    );
    process.exit(1);
  }
  if (fullConfig.max_tokens != null && !process.argv.includes("--max-tokens")) {
    config.maxTokens = fullConfig.max_tokens;
  }

  // --- Two-phase onboarding ---
  // Phase 1: Infra (API key) — fail early, deterministic, no narrative.
  // Phase 2: Identity (passphrase) — the creature speaks here.
  // Narrative begins only after the system is valid.

  // Phase 1: API key — environment check, fail fast
  if (config.provider === "anthropic" || config.provider === "openai") {
    const keyEnvName = config.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    const keyUrl =
      config.provider === "openai"
        ? "https://platform.openai.com/api-keys"
        : "https://console.anthropic.com/settings/keys";
    const apiKey = process.env[keyEnvName];

    if (!apiKey) {
      console.log();
      console.log(`  ${bold(keyEnvName)} ${dim("not set")}`);
      console.log();
      console.log(`  ${dim("export")} ${keyEnvName}=${dim("sk-...")}`);
      console.log();
      console.log(
        `  ${dim("To persist:")} ${dim(`echo 'export ${keyEnvName}=sk-...' >> ~/.zshrc`)}`,
      );
      console.log();
      console.log(`  ${dim("Get a key:")} ${cyan(keyUrl)}`);
      console.log(`  ${dim("Or run local:")} ${bold("motebit --provider ollama")}`);
      console.log();
      return;
    }

    // Validate
    try {
      const validateUrl =
        config.provider === "openai"
          ? "https://api.openai.com/v1/models"
          : "https://api.anthropic.com/v1/models";
      const validateHeaders: Record<string, string> =
        config.provider === "openai"
          ? { Authorization: `Bearer ${apiKey}` }
          : { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
      const resp = await fetch(validateUrl, { headers: validateHeaders });
      if (!resp.ok) {
        console.log();
        console.log(`  ${bold(keyEnvName)} ${dim("is set but invalid")}`);
        console.log();
        console.log(`  ${dim("Check your key:")} ${cyan(keyUrl)}`);
        console.log();
        return;
      }
    } catch {
      // Network error — let it through, will fail later with context
    }
  }

  // Phase 2: Identity — the creature speaks here
  const envPassphrase = process.env["MOTEBIT_PASSPHRASE"];
  let passphrase: string;

  if (fullConfig.cli_encrypted_key) {
    // Returning user — just the prompt
    passphrase = envPassphrase ?? (await promptPassphrase("  Passphrase: "));
    try {
      await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
    } catch {
      console.log();
      console.log(`  ${dim("Incorrect. Try again, or start fresh:")}`);
      console.log();
      console.log(`     ${dim("rm ~/.motebit/config.json && motebit")}`);
      console.log();
      process.exit(1);
    }
  } else if (fullConfig.cli_private_key != null && fullConfig.cli_private_key !== "") {
    // Migration: plaintext key exists — encrypt it
    console.log(dim("  Migrating private key to encrypted storage..."));
    passphrase = envPassphrase ?? (await promptPassphrase("  Set a passphrase: "));
    if (passphrase === "") {
      console.error("  Passphrase cannot be empty.");
      process.exit(1);
    }
    fullConfig.cli_encrypted_key = await encryptPrivateKey(fullConfig.cli_private_key, passphrase);
    delete fullConfig.cli_private_key;
    const { saveFullConfig } = await import("./config.js");
    saveFullConfig(fullConfig);
    console.log(dim("  Encrypted. Plaintext removed."));
  } else {
    // Identity birth
    console.log();
    console.log(`  ${bold("Welcome to Motebit.")}`);
    console.log();
    console.log(dim("         ."));
    console.log(dim("       .:::."));
    console.log(dim("      .:::::."));
    console.log(dim("      :::::::"));
    console.log(dim("      ':::::' "));
    console.log(dim("        '''"));
    console.log();
    console.log(`  ${dim("Your mote gets its own Ed25519 keypair — a cryptographic")}`);
    console.log(`  ${dim("identity that signs everything it does.")}`);
    console.log();
    console.log(`  ${dim("The passphrase encrypts this key on disk.")}`);
    console.log(`  ${dim("You'll need it each session.")}`);
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
        console.log(`  ${dim("Didn't match. Run")} ${bold("motebit")} ${dim("to try again.")}`);
        console.log();
        process.exit(1);
      }
    }
  }

  initTerminal();

  // Terminal is already initialized (initTerminal above) — raw stdin is owned.

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

  // Runtime-host election (daemon-desktop unification): one coordinator
  // runtime per machine. If another motebit process already binds the
  // socket, this REPL attaches as a rendering frontend instead of
  // constructing a second authority.
  let election: ElectionOutcome;
  try {
    election = await electCliRuntimeHost({
      fullConfig: reloadedConfig,
      motebitId,
      loadPrivateKey: () =>
        privateKeyBytes !== undefined
          ? Promise.resolve(privateKeyBytes)
          : Promise.reject(
              new Error("signing key unavailable — cannot attach to the running coordinator"),
            ),
      runtimeRef,
    });
  } catch (err: unknown) {
    console.error(
      `Runtime-host election failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "Another motebit process may be coordinating with an incompatible build. Stop it and retry.",
    );
    destroyTerminal();
    process.exit(1);
  }
  if (election.role === "frontend") {
    await runAttachedRepl(election.client, motebitId);
    return;
  }
  const runtimeHostServer = election.server;

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

  // The sovereign Solana rail — identity key IS the wallet. Constructed
  // here (the one place the decrypted seed exists) and injected; the
  // runtime wraps its payment builder in the money meter at delegation
  // enable. Without the seed (unsigned/degraded sessions) the rail is
  // absent and paid delegation degrades to relay-mode honestly.
  const solanaWallet =
    privateKeyBytes !== undefined
      ? createSolanaWalletRail({
          rpcUrl:
            config.solanaRpcUrl ??
            process.env["SOLANA_RPC_URL"] ??
            "https://api.mainnet-beta.solana.com",
          identitySeed: privateKeyBytes,
        })
      : undefined;

  // Create runtime with tools, policy, MCP config
  const { runtime, moteDb } = await createRuntime(
    config,
    motebitId,
    toolRegistry,
    mcpServers,
    personalityConfig,
    syncEncKey,
    solanaWallet,
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

  // Voice — opt-in only. Off by default. --voice flag or /voice on enables.
  // Provider chain (ElevenLabs → OpenAI → system `say`/`espeak`) is built
  // once from env keys; the controller owns the enabled flag independently.
  const voiceController = new VoiceController({ enabled: config.voice === true });

  // Enable interactive delegation if relay + signing keys are available
  const DEFAULT_SYNC_URL = "https://relay.motebit.com";
  const syncUrl =
    config.syncUrl ??
    process.env["MOTEBIT_SYNC_URL"] ??
    reloadedConfig.sync_url ??
    DEFAULT_SYNC_URL;
  // Initial sync — default relay is always available
  {
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

    // Register device with relay BEFORE enabling delegation.
    // Signed device tokens require the device's public key in the relay's
    // identity manager. Without this, verifySignedTokenForDevice rejects
    // poll requests with "Device not authorized".
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

    // Enable delegation with audience-scoped device tokens (submit vs query).
    // Falls back to raw API token only when device keys are unavailable.
    // `enableInvokeCapability` is wired to the same relay coordinates so
    // the deterministic `/invoke <cap> <prompt>` path shares transport with
    // the AI-loop delegation path (surface-determinism doctrine).
    if (syncUrl) {
      if (privateKeyBytes && deviceId) {
        const pk = privateKeyBytes;
        const did = deviceId;
        const authToken = async (audience = "task:submit"): Promise<string> => {
          const now = Date.now();
          return createSignedToken(
            {
              mid: motebitId,
              did,
              iat: now,
              exp: now + 5 * 60 * 1000,
              jti: crypto.randomUUID(),
              aud: audience,
            },
            pk,
          );
        };
        const delegationCfg = {
          syncUrl,
          authToken,
          ...(config.routingStrategy !== undefined
            ? { routingStrategy: config.routingStrategy }
            : {}),
          // Cold-start opt-in (`--pay-new-agents`) — admit paid P2P delegation
          // to a no-history worker (else relay-mode). Shared by both the chat
          // (delegate_to_agent) and deterministic (invokeCapability) paths.
          ...(config.payNewAgents ? { acknowledgeNoHistoryRisk: true } : {}),
          // The PINNED relay operator key (motebit register, TOFU over the
          // signed transparency declaration). With the sovereign rail
          // present, this is what unlocks the P2P path — the treasury
          // address derives FROM the pin, never from a fetched response.
          ...(fullConfig.relay_public_key ? { relayPublicKey: fullConfig.relay_public_key } : {}),
        };
        runtime.enableInteractiveDelegation(delegationCfg);
        runtime.enableInvokeCapability(delegationCfg);
      } else {
        const apiToken = config.syncToken ?? process.env["MOTEBIT_API_TOKEN"];
        if (apiToken) {
          const delegationCfg = {
            syncUrl,
            authToken: () => Promise.resolve(apiToken),
            ...(config.routingStrategy !== undefined
              ? { routingStrategy: config.routingStrategy }
              : {}),
            ...(config.payNewAgents ? { acknowledgeNoHistoryRisk: true } : {}),
            ...(fullConfig.relay_public_key ? { relayPublicKey: fullConfig.relay_public_key } : {}),
          };
          runtime.enableInteractiveDelegation(delegationCfg);
          runtime.enableInvokeCapability(delegationCfg);
        }
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
    destroyTerminal();
    // Release the runtime-host socket first so a successor can elect.
    await runtimeHostServer.close().catch(() => {});
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

  // First-session activation: creature speaks first after identity birth.
  // Uses generateActivation — no synthetic user message in history.
  if (isFirstLaunch) {
    try {
      const activationRunId = crypto.randomUUID();
      writeOutput(promptColor("mote>") + " ");
      await consumeStream(
        runtime.generateActivation(
          "You just came into existence. The person who created you is here. Speak first.",
          activationRunId,
        ),
        runtime,
      );
    } catch (err: unknown) {
      // Activation is best-effort — if it fails, user still gets the prompt
      const msg = err instanceof Error ? err.message : String(err);
      console.error(dim(`  [activation failed: ${msg}]`));
    }
    console.log();
  }

  // Standing-grant presentation (`motebit --grant <id>`): artifacts are
  // loaded once; each turn presents the currently-due pre-minted tick.
  // The runtime derives (or refuses) authority per turn — a null
  // presentation is an honestly grantless turn, never an error.
  const grantPresenter = config.grant != null ? await createGrantPresenter(config.grant) : null;
  if (grantPresenter != null) {
    console.log(
      dim(
        `  [standing grant ${grantPresenter.grantId} presented per turn — R4 money clears only within its signed ceiling]`,
      ),
    );
    // Pre-flight: walk the whole authorization chain the first money turn
    // will need and TEACH any blocker now (gate-repair-instructions
    // extended to the product). Advisory only — the verifier/gate/meter
    // remain the authorities; this predicts, the boundary decides.
    const storedForPreflight = loadStoredGrant(grantPresenter.grantId);
    if (storedForPreflight != null) {
      const pf = await preflightGrant({
        stored: storedForPreflight,
        now: Date.now(),
        fullConfig,
        hasRail: solanaWallet !== undefined,
        ...(solanaWallet !== undefined ? { getBalanceMicro: () => solanaWallet.getBalance() } : {}),
      });
      for (const line of renderPreflight(pf, dim)) console.log(line);
    }
  }

  const prompt = (): void => {
    readInput(promptColor("you>") + " ").then(
      (line) => void handleLine(line),
      () => {}, // Ignore errors (e.g. stdin closed)
    );
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();

    if (trimmed === "quit" || trimmed === "exit") {
      writeOutput("Goodbye!\n");
      await shutdown();
      // Mirror the SIGINT path: exit explicitly. Waiting for the event
      // loop to drain leaves a zombie REPL holding the terminal whenever
      // any live handle remains (the sovereign rail's RPC connection, an
      // MCP socket) — observed 2026-07-07: "Goodbye!" printed, process
      // survived, terminal unusable until a new window.
      process.exit(0);
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
        voice: voiceController,
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
        writeOutput("\n" + promptColor("mote>") + " ");
        const grantOptions = grantPresenter?.delegationForTurn() ?? undefined;
        if (grantPresenter != null && grantOptions == null) {
          console.log(dim("  [no grant tick due this turn — running grantless]"));
        }
        await consumeStream(
          runtime.sendMessageStreaming(trimmed, chatRunId, grantOptions),
          runtime,
          {
            voice: voiceController,
          },
        );
      }
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
