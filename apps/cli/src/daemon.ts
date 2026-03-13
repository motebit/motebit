// --- Daemon mode and MCP server mode ---

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import { embedText } from "@motebit/memory-graph";
import type { StorageAdapters } from "@motebit/runtime";
import type { MotebitPersonalityConfig } from "@motebit/ai-core";
import { DEFAULT_CONFIG } from "@motebit/ai-core";
import { openMotebitDatabase } from "@motebit/persistence";
import {
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  PlanSyncEngine,
  HttpPlanSyncAdapter,
} from "@motebit/sync-engine";
import type { AgentTask } from "@motebit/sdk";
import {
  EventType,
  RiskLevel,
  SensitivityLevel,
  AgentTaskStatus,
  DeviceCapability,
} from "@motebit/sdk";
import { createSignedToken, verifySignedToken } from "@motebit/crypto";
import { verify as verifyIdentityFile, governanceToPolicyConfig } from "@motebit/identity-file";
import { McpServerAdapter } from "@motebit/mcp-server";
import type {
  MotebitServerDeps,
  McpServerConfig as McpServerAdapterConfig,
} from "@motebit/mcp-server";
import { PlanEngine, RelayDelegationAdapter } from "@motebit/planner";
import { GoalScheduler } from "./scheduler.js";
import type { CliConfig } from "./args.js";
import { loadFullConfig, extractPersonality } from "./config.js";
import { fromHex, decryptPrivateKey } from "./identity.js";
import { getDbPath, createProvider, buildToolRegistry } from "./runtime-factory.js";

export async function handleRun(config: CliConfig): Promise<void> {
  const identityPath =
    config.identity != null && config.identity !== ""
      ? path.resolve(config.identity)
      : path.resolve("motebit.md");

  let identityContent: string;
  try {
    identityContent = fs.readFileSync(identityPath, "utf-8");
  } catch {
    console.error(`Error: cannot read identity file: ${identityPath}`);
    process.exit(1);
  }

  // Verify signature
  const verifyResult = await verifyIdentityFile(identityContent);
  if (!verifyResult.valid || !verifyResult.identity) {
    console.error(`Error: invalid identity file signature.`);
    if (verifyResult.error != null && verifyResult.error !== "")
      console.error(`  ${verifyResult.error}`);
    process.exit(1);
  }

  const identity = verifyResult.identity;
  const gov = identity.governance;

  // Fail-closed: require all three governance thresholds before starting daemon mode.
  // Without explicit thresholds, the daemon cannot make safe auto-allow / deny decisions.
  const requiredFields = ["max_risk_auto", "require_approval_above", "deny_above"] as const;
  for (const field of requiredFields) {
    if (!gov[field]) {
      console.error(
        `Error: motebit.md governance.${field} is missing or empty. All three governance thresholds are required for daemon mode.`,
      );
      process.exit(1);
    }
  }

  // Derive policy from governance -- parseRiskLevel throws on invalid values
  const policyConfig = governanceToPolicyConfig(gov);
  const { maxRiskAuto, denyAbove } = policyConfig;

  // Force operator mode from governance
  config.operator = policyConfig.operatorMode;

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

  const motebitId = identity.motebit_id;

  // Build tool registry
  const runtimeRef: { current: MotebitRuntime | null } = { current: null };
  const toolRegistry = buildToolRegistry(config, runtimeRef, motebitId);

  const mcpServers = (fullConfig.mcp_servers ?? []).map((s) => ({
    ...s,
    trusted: (fullConfig.mcp_trusted_servers ?? []).includes(s.name),
  }));

  // Create runtime with governance-derived policy
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  const provider = createProvider(config, personalityConfig);

  const storage: StorageAdapters = {
    eventStore: moteDb.eventStore,
    memoryStorage: moteDb.memoryStorage,
    identityStorage: moteDb.identityStorage,
    auditLog: moteDb.auditLog,
    stateSnapshot: moteDb.stateSnapshot,
    toolAuditSink: moteDb.toolAuditSink,
    conversationStore: moteDb.conversationStore,
  };

  const runtime = new MotebitRuntime(
    {
      motebitId,
      mcpServers,
      policy: {
        operatorMode: config.operator,
        maxRiskLevel: maxRiskAuto,
        requireApprovalAbove: policyConfig.requireApprovalAbove,
        denyAbove: policyConfig.denyAbove,
        pathAllowList: config.allowedPaths,
      },
    },
    {
      storage,
      renderer: new NullRenderer(),
      ai: provider,
      tools: toolRegistry,
    },
  );
  runtimeRef.current = runtime;

  await runtime.init();

  // Advertise full CLI/desktop capabilities
  runtime.setLocalCapabilities([
    DeviceCapability.StdioMcp,
    DeviceCapability.HttpMcp,
    DeviceCapability.FileSystem,
    DeviceCapability.Keyring,
    DeviceCapability.Background,
  ]);

  // Start goal scheduler
  const goals = moteDb.goalStore.list(motebitId);
  const scheduler = new GoalScheduler(
    runtime,
    moteDb.goalStore,
    moteDb.approvalStore,
    moteDb.goalOutcomeStore,
    motebitId,
    denyAbove,
  );
  scheduler.setPlanEngine(new PlanEngine(moteDb.planStore), moteDb.planStore);
  scheduler.start();

  console.log(
    `Daemon running. motebit_id: ${motebitId.slice(0, 8)}... Goals: ${goals.length}. Policy: max_risk_auto=${RiskLevel[maxRiskAuto]}, deny_above=${RiskLevel[denyAbove]}`,
  );

  // Wire agent task handler via WebSocket (if sync URL configured)
  const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
  const syncToken = config.syncToken ?? process.env["MOTEBIT_SYNC_TOKEN"];
  let wsAdapter: WebSocketEventStoreAdapter | null = null;
  let daemonHeartbeatTimer: ReturnType<typeof setInterval> | undefined;

  if (syncUrl != null && syncUrl !== "") {
    // Derive private key for signing execution receipts
    let privKeyBytes: Uint8Array | undefined;
    const deviceId = fullConfig.device_id ?? "unknown";

    if (fullConfig.cli_encrypted_key) {
      try {
        // Prompt for passphrase to decrypt private key
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const passphrase = await new Promise<string>((resolve) => {
          rl.question("Passphrase (for agent signing): ", (answer) => {
            rl.close();
            resolve(answer);
          });
        });
        const pkHex = await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
        privKeyBytes = fromHex(pkHex);
      } catch {
        console.log("Warning: could not decrypt private key — agent tasks disabled");
      }
    }

    // Set up WebSocket adapter for real-time task dispatch
    const wsUrl = syncUrl.replace(/^http/, "ws") + `/ws/sync/${motebitId}`;

    // Create a signed auth token for the WS connection
    let authToken = syncToken;
    if (privKeyBytes && fullConfig.device_id) {
      try {
        authToken = await createSignedToken(
          {
            mid: motebitId,
            did: fullConfig.device_id,
            iat: Date.now(),
            exp: Date.now() + 5 * 60 * 1000,
          },
          privKeyBytes,
        );
      } catch {
        // Fall back to sync token
      }
    }

    const httpAdapter = new HttpEventStoreAdapter({
      baseUrl: syncUrl,
      motebitId,
      authToken: syncToken,
    });

    const cliCapabilities = [
      DeviceCapability.StdioMcp,
      DeviceCapability.HttpMcp,
      DeviceCapability.FileSystem,
      DeviceCapability.Keyring,
      DeviceCapability.Background,
    ];

    wsAdapter = new WebSocketEventStoreAdapter({
      url: wsUrl,
      motebitId,
      authToken,
      capabilities: cliCapabilities,
      httpFallback: httpAdapter,
      localStore: moteDb.eventStore,
    });

    // Handle agent task requests
    if (privKeyBytes) {
      const privateKey = privKeyBytes;
      wsAdapter.onCustomMessage((msg) => {
        if (msg.type === "task_request" && msg.task) {
          const task = msg.task as AgentTask;

          // Check if we have the required capabilities
          const requiredCaps = task.required_capabilities ?? [];
          if (requiredCaps.length > 0) {
            const missingCaps = requiredCaps.filter((c) => !cliCapabilities.includes(c));
            if (missingCaps.length > 0) {
              console.log(
                `\nAgent task ${task.task_id.slice(0, 8)}... skipped (missing: ${missingCaps.join(", ")})`,
              );
              return;
            }
          }

          console.log(
            `\nAgent task received: ${task.task_id.slice(0, 8)}... prompt: "${task.prompt.slice(0, 80)}"`,
          );

          // Claim the task
          wsAdapter!.sendRaw(JSON.stringify({ type: "task_claim", task_id: task.task_id }));

          // Execute and post receipt
          void (async () => {
            try {
              let receipt: import("@motebit/sdk").ExecutionReceipt | undefined;
              for await (const chunk of runtime.handleAgentTask(task, privateKey, deviceId)) {
                if (chunk.type === "task_result") {
                  receipt = chunk.receipt;
                }
              }

              if (receipt) {
                // POST receipt to relay
                const resultUrl = `${syncUrl}/agent/${motebitId}/task/${task.task_id}/result`;
                await fetch(resultUrl, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${syncToken ?? ""}`,
                  },
                  body: JSON.stringify(receipt),
                });
                console.log(
                  `Agent task ${task.task_id.slice(0, 8)}... ${receipt.status}. Tools: [${receipt.tools_used.join(", ")}]`,
                );
              }
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.error(`Agent task ${task.task_id.slice(0, 8)}... error: ${errMsg}`);
            }
          })();
        }
      });

      console.log(`Agent surface: active (WS → ${wsUrl.replace(/token=.*/, "token=***")})`);
    } else {
      console.log("Agent surface: disabled (no private key)");
    }

    wsAdapter.connect();

    // Wire RelayDelegationAdapter so PlanEngine can delegate steps to other motebits.
    // Use a token factory to mint fresh signed tokens for long-lived daemons (5-min expiry).
    if (privKeyBytes) {
      const privateKeyForDelegation = privKeyBytes;
      const tokenFactory = async (): Promise<string> => {
        if (!fullConfig.device_id) return syncToken ?? "";
        try {
          return await createSignedToken(
            {
              mid: motebitId,
              did: fullConfig.device_id,
              iat: Date.now(),
              exp: Date.now() + 5 * 60 * 1000,
            },
            privateKeyForDelegation,
          );
        } catch {
          return syncToken ?? "";
        }
      };

      const delegationAdapter = new RelayDelegationAdapter({
        syncUrl,
        motebitId,
        authToken: tokenFactory,
        sendRaw: (data: string) => wsAdapter!.sendRaw(data),
        onCustomMessage: (cb) => wsAdapter!.onCustomMessage(cb),
        getExplorationDrive: () => runtime.getPrecision().explorationDrive,
        onDelegationFailure: (step, _attempt, error, failedAgentId) => {
          console.warn(
            `Delegation failed for step "${step.description}"${failedAgentId ? ` (agent: ${failedAgentId.slice(0, 8)}...)` : ""}: ${error}`,
          );
        },
      });
      runtime.setDelegationAdapter(delegationAdapter);
      console.log("Delegation: enabled (RelayDelegationAdapter wired)");
    }

    // Register with agent discovery registry so other motebits can find this daemon.
    try {
      const toolNames = runtime
        .getToolRegistry()
        .list()
        .map((t) => t.name);

      const regHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (syncToken) regHeaders["Authorization"] = `Bearer ${syncToken}`;

      const regResp = await fetch(`${syncUrl}/api/v1/agents/register`, {
        method: "POST",
        headers: regHeaders,
        body: JSON.stringify({
          motebit_id: motebitId,
          endpoint_url: syncUrl,
          capabilities: toolNames,
          metadata: { name: `daemon-${motebitId.slice(0, 8)}`, transport: "ws" },
        }),
      });

      if (regResp.ok) {
        console.log(`Discovery: registered with relay (${toolNames.length} tools)`);
        // Heartbeat every 5 minutes to keep the registry entry alive
        daemonHeartbeatTimer = setInterval(
          () => {
            void fetch(`${syncUrl}/api/v1/agents/heartbeat`, {
              method: "POST",
              headers: regHeaders,
            }).catch(() => {
              // Best-effort heartbeat
            });
          },
          5 * 60 * 1000,
        );
      } else {
        console.log(`Discovery: registry registration returned ${regResp.status} (skipping)`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Discovery: registry registration failed (${msg}) — continuing`);
    }

    // Also wire sync via the HTTP adapter
    runtime.connectSync(httpAdapter);

    // Plan sync: push/pull plans every 30s for cross-device visibility
    const { SqlitePlanSyncStoreAdapter } = await import("./runtime-factory.js");
    const planSyncAdapter = new SqlitePlanSyncStoreAdapter(moteDb.planStore, motebitId);
    const planSyncEngine = new PlanSyncEngine(planSyncAdapter, motebitId);
    planSyncEngine.connectRemote(
      new HttpPlanSyncAdapter({ baseUrl: syncUrl, motebitId, authToken: syncToken }),
    );
    planSyncEngine.start();
  }

  // Graceful shutdown on SIGINT/SIGTERM with safety timeout
  const shutdown = (): void => {
    console.log("\nShutting down...");
    const forceExit = setTimeout(() => process.exit(1), 5_000);
    if (typeof forceExit.unref === "function") forceExit.unref(); // Don't block event loop
    try {
      if (daemonHeartbeatTimer !== undefined) clearInterval(daemonHeartbeatTimer);
      // Best-effort deregistration from agent discovery registry
      if (syncUrl) {
        const deregHeaders: Record<string, string> = {};
        if (syncToken) deregHeaders["Authorization"] = `Bearer ${syncToken}`;
        void fetch(`${syncUrl}/api/v1/agents/deregister`, {
          method: "DELETE",
          headers: deregHeaders,
        }).catch(() => {});
      }
      scheduler.stop();
      wsAdapter?.disconnect();
      runtime.stop();
      moteDb.close();
    } catch (err: unknown) {
      console.error("Shutdown error:", err instanceof Error ? err.message : String(err));
    }
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function handleServe(config: CliConfig): Promise<void> {
  // Determine transport and port
  const transport = (config.serveTransport ?? "stdio") as "stdio" | "http";
  if (transport !== "stdio" && transport !== "http") {
    console.error(
      `Error: --serve-transport must be "stdio" or "http", got "${transport as string}"`,
    );
    process.exit(1);
  }
  const port =
    config.servePort != null && config.servePort !== "" ? parseInt(config.servePort, 10) : 3100;

  // For stdio mode, all diagnostic output must go to stderr (stdout is the MCP JSON-RPC transport)
  const log =
    transport === "stdio"
      ? (...args: unknown[]) => {
          console.error(...args);
        }
      : (...args: unknown[]) => {
          console.log(...args);
        };

  // Load identity file if provided, otherwise use ambient config
  let motebitId: string;
  let publicKeyHex: string | undefined;
  let policyOverrides: {
    operatorMode?: boolean;
    maxRiskLevel?: RiskLevel;
    requireApprovalAbove?: RiskLevel;
    denyAbove?: RiskLevel;
  } = {};

  if (config.identity != null && config.identity !== "") {
    const identityPath = path.resolve(config.identity);
    let identityContent: string;
    try {
      identityContent = fs.readFileSync(identityPath, "utf-8");
    } catch {
      console.error(`Error: cannot read identity file: ${identityPath}`);
      process.exit(1);
    }

    const verifyResult = await verifyIdentityFile(identityContent);
    if (!verifyResult.valid || !verifyResult.identity) {
      console.error(`Error: invalid identity file signature.`);
      if (verifyResult.error != null && verifyResult.error !== "")
        console.error(`  ${verifyResult.error}`);
      process.exit(1);
    }

    const identity = verifyResult.identity;
    const gov = identity.governance;

    // Derive policy from governance if thresholds present
    if (gov.max_risk_auto && gov.require_approval_above && gov.deny_above) {
      const policyConfig = governanceToPolicyConfig(gov);
      policyOverrides = {
        operatorMode: policyConfig.operatorMode,
        maxRiskLevel: policyConfig.maxRiskAuto,
        requireApprovalAbove: policyConfig.requireApprovalAbove,
        denyAbove: policyConfig.denyAbove,
      };
      config.operator = policyConfig.operatorMode;
    }

    motebitId = identity.motebit_id;
    publicKeyHex = identity.identity.public_key;

    log(`Identity: ${motebitId.slice(0, 8)}... (from ${identityPath})`);
  } else {
    // Ambient mode -- use config identity
    const fullConfig = loadFullConfig();
    if (fullConfig.motebit_id == null || fullConfig.motebit_id === "") {
      console.error(
        "Error: no motebit identity found. Run `motebit` first to create an identity, or use --identity <path>.",
      );
      process.exit(1);
    }
    motebitId = fullConfig.motebit_id;
    publicKeyHex = fullConfig.device_public_key;
    log(`Identity: ${motebitId.slice(0, 8)}... (from config)`);
  }

  // Load full config for personality/MCP servers
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

  // Build tool registry
  const runtimeRef: { current: MotebitRuntime | null } = { current: null };
  const toolRegistry = buildToolRegistry(config, runtimeRef, motebitId);

  const mcpServers = (fullConfig.mcp_servers ?? []).map((s) => ({
    ...s,
    trusted: (fullConfig.mcp_trusted_servers ?? []).includes(s.name),
  }));

  // Create runtime
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  const provider = createProvider(config, personalityConfig);

  const storage: StorageAdapters = {
    eventStore: moteDb.eventStore,
    memoryStorage: moteDb.memoryStorage,
    identityStorage: moteDb.identityStorage,
    auditLog: moteDb.auditLog,
    stateSnapshot: moteDb.stateSnapshot,
    toolAuditSink: moteDb.toolAuditSink,
    conversationStore: moteDb.conversationStore,
  };

  const runtime = new MotebitRuntime(
    {
      motebitId,
      mcpServers,
      policy: {
        operatorMode: config.operator,
        pathAllowList: config.allowedPaths,
        ...policyOverrides,
      },
    },
    {
      storage,
      renderer: new NullRenderer(),
      ai: provider,
      tools: toolRegistry,
    },
  );
  runtimeRef.current = runtime;

  await runtime.init();

  // Wire MotebitServerDeps from the runtime
  const deps: MotebitServerDeps = {
    motebitId,
    publicKeyHex,

    listTools: () => runtime.getToolRegistry().list(),
    filterTools: (tools) => runtime.policy.filterTools(tools),
    validateTool: (tool, args) =>
      runtime.policy.validate(tool, args, runtime.policy.createTurnContext()),
    executeTool: (name, args) => runtime.getToolRegistry().execute(name, args),

    getState: () => runtime.getState() as unknown as Record<string, unknown>,

    getMemories: async (limit = 50) => {
      const data = await runtime.memory.exportAll();
      return data.nodes
        .filter((n) => !n.tombstoned)
        .map((n) => ({
          content: n.content,
          confidence: n.confidence,
          sensitivity: n.sensitivity,
          created_at: n.created_at,
        }))
        .slice(0, limit);
    },

    logToolCall: (name, args, result) => {
      const entry = {
        event_id: crypto.randomUUID(),
        motebit_id: motebitId,
        timestamp: Date.now(),
        event_type: EventType.ToolUsed,
        payload: {
          tool: name,
          args_preview: JSON.stringify(args).slice(0, 200),
          ok: result.ok,
          source: "mcp_server",
        },
        version_clock: 0, // best-effort, non-critical
        tombstoned: false,
      };
      void runtime.events.append(entry).catch(() => {});
    },

    // Synthetic tool backends
    sendMessage: async (text: string) => {
      const result = await runtime.sendMessage(text);
      return { response: result.response, memoriesFormed: result.memoriesFormed.length };
    },

    queryMemories: async (query: string, limit?: number) => {
      const embedding = await embedText(query);
      const nodes = await runtime.memory.retrieve(embedding, {
        limit: limit ?? 10,
        sensitivityFilter: [SensitivityLevel.None, SensitivityLevel.Personal],
      });
      return nodes.map((n) => ({
        content: n.content,
        confidence: n.confidence,
        similarity: 0,
        half_life_days: Math.round(n.half_life / 86_400_000),
        memory_type: (n.memory_type ?? "semantic") as string,
        created_at: n.created_at,
      }));
    },

    storeMemory: async (content: string, sensitivity?: string) => {
      const embedding = await embedText(content);
      const node = await runtime.memory.formMemory(
        {
          content,
          confidence: 0.7,
          sensitivity: (sensitivity as SensitivityLevel) ?? SensitivityLevel.None,
        },
        embedding,
      );
      return { node_id: node.node_id };
    },

    // Mutual auth: inject verifySignedToken for motebit caller verification
    verifySignedToken: async (token: string, publicKey: Uint8Array) => {
      return verifySignedToken(token, publicKey);
    },
  };

  // Wire handleAgentTask if private key is available
  const fullConfigForServe = loadFullConfig();
  const deviceId = fullConfigForServe.device_id ?? "unknown";

  if (fullConfigForServe.cli_encrypted_key) {
    try {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const passphrase = await new Promise<string>((resolve) => {
        rl.question("Passphrase (for agent signing): ", (answer) => {
          rl.close();
          resolve(answer);
        });
      });
      const pkHex = await decryptPrivateKey(fullConfigForServe.cli_encrypted_key, passphrase);
      const privateKey = fromHex(pkHex);

      deps.handleAgentTask = async function* (prompt: string) {
        const task: AgentTask = {
          task_id: crypto.randomUUID(),
          motebit_id: motebitId,
          prompt,
          submitted_at: Date.now(),
          submitted_by: "mcp_client",
          status: AgentTaskStatus.Running,
        };

        for await (const chunk of runtime.handleAgentTask(task, privateKey, deviceId)) {
          yield chunk;
        }
      };
      log("Agent task handler enabled (private key loaded).");
    } catch {
      log("Warning: could not decrypt private key — motebit_task tool disabled");
    }
  }

  // Wire identity file content if --identity was used
  if (config.identity != null && config.identity !== "") {
    try {
      deps.identityFileContent = fs.readFileSync(path.resolve(config.identity), "utf-8");
    } catch {
      // Identity content unavailable -- fallback to JSON identity
    }
  }

  // Create and start MCP server
  const serverConfig: McpServerAdapterConfig = {
    name: `motebit-${motebitId.slice(0, 8)}`,
    transport,
    port,
  };

  const mcpServer = new McpServerAdapter(serverConfig, deps);
  await mcpServer.start();

  const toolCount = runtime.getToolRegistry().list().length;
  if (transport === "stdio") {
    log(`MCP server running (stdio). ${toolCount} tools exposed.`);
    log(`Policy: ${config.operator ? "operator" : "ambient"} mode.`);
  } else {
    log(
      `MCP server running on http://localhost:${port} (StreamableHTTP). ${toolCount} tools exposed.`,
    );
    log(`Policy: ${config.operator ? "operator" : "ambient"} mode.`);
  }

  // Register with discovery relay (HTTP transport only)
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
  if (transport === "http" && syncUrl) {
    try {
      const toolNames = runtime
        .getToolRegistry()
        .list()
        .map((t) => t.name);

      const regHeaders: Record<string, string> = { "Content-Type": "application/json" };
      const masterToken = config.syncToken ?? process.env["MOTEBIT_API_TOKEN"];
      if (masterToken) regHeaders["Authorization"] = `Bearer ${masterToken}`;

      const endpointUrl = `http://localhost:${port}`;
      const regResp = await fetch(`${syncUrl}/api/v1/agents/register`, {
        method: "POST",
        headers: regHeaders,
        body: JSON.stringify({
          motebit_id: motebitId,
          endpoint_url: endpointUrl,
          capabilities: toolNames,
          metadata: { name: serverConfig.name },
        }),
      });
      if (regResp.ok) {
        log(`Registered with relay: ${syncUrl}`);
        // Heartbeat every 5 minutes
        heartbeatTimer = setInterval(
          () => {
            void fetch(`${syncUrl}/api/v1/agents/heartbeat`, {
              method: "POST",
              headers: regHeaders,
            }).catch(() => {
              // Best-effort heartbeat
            });
          },
          5 * 60 * 1000,
        );
      } else {
        log(`Registry registration failed: ${regResp.status}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Registry registration error: ${msg}`);
    }
  }

  // Graceful shutdown with safety timeout
  const shutdown = async (): Promise<void> => {
    log("\nShutting down MCP server...");
    const forceExit = setTimeout(() => process.exit(1), 5_000);
    if (typeof forceExit.unref === "function") forceExit.unref();
    try {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (syncUrl) {
        try {
          const masterToken = config.syncToken ?? process.env["MOTEBIT_API_TOKEN"];
          const headers: Record<string, string> = {};
          if (masterToken) headers["Authorization"] = `Bearer ${masterToken}`;
          await fetch(`${syncUrl}/api/v1/agents/deregister`, { method: "DELETE", headers });
        } catch {
          // Best-effort deregistration
        }
      }
      await mcpServer.stop();
      runtime.stop();
      moteDb.close();
    } catch (err: unknown) {
      log(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
