import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseArgs } from "node:util";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import { embedText } from "@motebit/memory-graph";
import type { StorageAdapters, StreamChunk, ReflectionResult } from "@motebit/runtime";
import { CloudProvider, OllamaProvider, formatBodyAwareness } from "@motebit/ai-core";
import type { StreamingProvider, MotebitPersonalityConfig } from "@motebit/ai-core";
import { DEFAULT_CONFIG } from "@motebit/ai-core";
import { openMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import {
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  EncryptedEventStoreAdapter,
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
} from "@motebit/sync-engine";
import type { ConversationSyncStoreAdapter } from "@motebit/sync-engine";
import type { SyncConversation, SyncConversationMessage, AgentTask } from "@motebit/sdk";
import { EventStore } from "@motebit/event-log";
import { EventType, RiskLevel, SensitivityLevel, AgentTaskStatus } from "@motebit/sdk";
import {
  InMemoryToolRegistry,
  readFileDefinition,
  createReadFileHandler,
  writeFileDefinition,
  createWriteFileHandler,
  shellExecDefinition,
  createShellExecHandler,
  webSearchDefinition,
  createWebSearchHandler,
  readUrlDefinition,
  createReadUrlHandler,
  recallMemoriesDefinition,
  createRecallMemoriesHandler,
  listEventsDefinition,
  createListEventsHandler,
  BraveSearchProvider,
  DuckDuckGoSearchProvider,
  FallbackSearchProvider,
} from "@motebit/tools";
import type { SearchProvider } from "@motebit/tools";
import { connectMcpServers, McpClientAdapter, type McpServerConfig } from "@motebit/mcp-client";
import {
  deriveKey,
  encrypt,
  decrypt,
  generateSalt,
  deriveSyncEncryptionKey,
  createSignedToken,
  verifySignedToken,
} from "@motebit/crypto";
import type { EncryptedPayload } from "@motebit/crypto";
import {
  bootstrapIdentity as sharedBootstrapIdentity,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import {
  generate as generateIdentityFile,
  verify as verifyIdentityFile,
  governanceToPolicyConfig,
} from "@motebit/identity-file";
import { McpServerAdapter } from "@motebit/mcp-server";
import type {
  MotebitServerDeps,
  McpServerConfig as McpServerAdapterConfig,
} from "@motebit/mcp-server";
import { PlanEngine } from "@motebit/planner";
import { GoalScheduler } from "./scheduler.js";
import { parseInterval } from "./intervals.js";

// --- Constants ---

const VERSION = "0.1.0";
const CONFIG_DIR = path.join(os.homedir(), ".motebit");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

// --- Full Config ---

interface FullConfig {
  // Personality (existing)
  name?: string;
  personality_notes?: string;
  default_provider?: "anthropic" | "ollama";
  default_model?: string;
  temperature?: number;
  // Identity (written on first launch)
  motebit_id?: string;
  device_id?: string;
  device_public_key?: string;
  /** @deprecated Plaintext key — migrated to cli_encrypted_key on next launch. */
  cli_private_key?: string;
  cli_encrypted_key?: {
    ciphertext: string; // hex
    nonce: string; // hex
    tag: string; // hex
    salt: string; // hex
  };
  // MCP servers (user-configured)
  mcp_servers?: McpServerConfig[];
  // Trusted MCP server names (tools don't require approval)
  mcp_trusted_servers?: string[];
}

function loadFullConfig(): FullConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as FullConfig;
  } catch {
    return {};
  }
}

function saveFullConfig(config: FullConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

/** Persist newly pinned motebit public keys from connected adapters back to config. */
function persistMotebitPublicKeys(
  adapters: Awaited<ReturnType<typeof connectMcpServers>>,
  fullConfig: FullConfig,
): void {
  let dirty = false;
  const servers = fullConfig.mcp_servers ?? [];
  for (const adapter of adapters) {
    if (!adapter.isMotebit || !adapter.verifiedIdentity?.verified) continue;
    const pinnedKey = adapter.serverConfig.motebitPublicKey;
    if (!pinnedKey) continue;
    // Find matching server config entry
    const serverCfg = servers.find((s) => s.name === adapter.serverName);
    if (serverCfg && !serverCfg.motebitPublicKey) {
      serverCfg.motebitPublicKey = pinnedKey;
      dirty = true;
    }
  }
  if (dirty) {
    saveFullConfig(fullConfig);
  }
}

function extractPersonality(full: FullConfig): MotebitPersonalityConfig {
  return {
    name: full.name,
    personality_notes: full.personality_notes,
    default_provider: full.default_provider,
    default_model: full.default_model,
    temperature: full.temperature,
  };
}

// --- Arg Parsing ---

export interface CliConfig {
  provider: "anthropic" | "ollama";
  model: string;
  dbPath: string | undefined;
  noStream: boolean;
  syncUrl: string | undefined;
  syncToken: string | undefined;
  operator: boolean;
  allowedPaths: string[];
  output: string | undefined;
  identity: string | undefined;
  every: string | undefined;
  once: boolean;
  wallClock: string | undefined;
  project: string | undefined;
  reason: string | undefined;
  serveTransport: string | undefined;
  servePort: string | undefined;
  version: boolean;
  help: boolean;
  positionals: string[];
}

export function parseCliArgs(args: string[] = process.argv.slice(2)): CliConfig {
  const cleanArgs = args[0] === "--" ? args.slice(1) : args;
  const { values, positionals } = parseArgs({
    args: cleanArgs,
    options: {
      provider: { type: "string", default: "anthropic" },
      model: { type: "string" },
      "db-path": { type: "string" },
      "no-stream": { type: "boolean", default: false },
      "sync-url": { type: "string" },
      "sync-token": { type: "string" },
      operator: { type: "boolean", default: false },
      "allowed-paths": { type: "string" },
      output: { type: "string", short: "o" },
      identity: { type: "string" },
      every: { type: "string" },
      once: { type: "boolean", default: false },
      "wall-clock": { type: "string" },
      project: { type: "string" },
      reason: { type: "string" },
      "serve-transport": { type: "string" },
      "serve-port": { type: "string" },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const provider = values.provider;
  if (provider !== "anthropic" && provider !== "ollama") {
    throw new Error(`Unknown provider "${provider}". Use "anthropic" or "ollama".`);
  }

  const defaultModel = provider === "ollama" ? "llama3.2" : "claude-sonnet-4-5-20250514";
  const allowedPaths =
    values["allowed-paths"] != null && values["allowed-paths"] !== ""
      ? values["allowed-paths"].split(",").map((p) => p.trim())
      : [process.cwd()];

  return {
    provider,
    model: values.model ?? defaultModel,
    dbPath: values["db-path"],
    noStream: values["no-stream"],
    syncUrl: values["sync-url"],
    syncToken: values["sync-token"],
    operator: values.operator,
    allowedPaths,
    output: values.output,
    identity: values.identity,
    every: values.every,
    once: values.once,
    wallClock: values["wall-clock"],
    project: values.project,
    reason: values.reason,
    serveTransport: values["serve-transport"],
    servePort: values["serve-port"],
    version: values.version,
    help: values.help,
    positionals,
  };
}

// --- Help / Version ---

export function printHelp(): void {
  console.log(
    `
Usage: motebit [command] [options]

Commands:
  doctor                    Check system readiness (Node, SQLite, config)
  export [--output <path>]  Export a signed motebit.md (portable identity for daemon mode)
  verify <path>             Verify a motebit.md identity file signature
  run [--identity <path>]   Start daemon mode (uses exported motebit.md)
  serve [--identity <path>] Start as MCP server (stdio by default)
    --serve-transport <mode>  Transport: "stdio" (default) or "http"
    --serve-port <port>       HTTP port (default: 3100)
  goal add "<prompt>" --every <interval> [--once] [--wall-clock <duration>] [--project <id>]
                            Add a scheduled goal
  goal list                 List all scheduled goals with status
  goal outcomes <goal_id>   Show execution history for a goal
  goal remove <goal_id>     Remove a scheduled goal
  goal pause <goal_id>      Pause a scheduled goal
  goal resume <goal_id>     Resume a paused goal
  approvals list            List approval queue items
  approvals show <id>       Show approval detail
  approvals approve <id>    Approve a pending tool call
  approvals deny <id> [--reason <text>]  Deny a pending tool call

Options:
  --provider <name>       AI provider: "anthropic" or "ollama" (default: anthropic)
  --model <model>         AI model to use (default depends on provider)
  --db-path <path>        Database file path (default: ~/.motebit/motebit.db)
  --no-stream             Disable streaming (use blocking mode)
  --sync-url <url>        Remote sync server URL (or set MOTEBIT_SYNC_URL)
  --sync-token <tok>      Auth token for sync server (or set MOTEBIT_SYNC_TOKEN)
  --once                  Create a one-shot goal (runs once then completes)
  --wall-clock <duration> Max wall-clock time per goal run (e.g. '30m', '1h'). Default: 10m
  --project <id>          Project ID for grouping related goals (shared context)
  --operator              Enable operator mode (write/exec tools)
  --allowed-paths <paths> Comma-separated allowed file paths (default: cwd)
  -v, --version           Print version and exit
  -h, --help              Print this help and exit

Providers:
  anthropic               Uses Anthropic API (requires ANTHROPIC_API_KEY)
                          Default model: claude-sonnet-4-5-20250514
  ollama                  Uses local Ollama server (no API key needed)
                          Default model: llama3.2

Slash commands (in REPL):
  /help              Show available commands
  /memories          List all memories
  /state             Show current state vector
  /forget <nodeId>   Delete a memory by ID
  /export            Export all memories and state as JSON
  /clear             Clear conversation history
  /conversations     List recent conversations
  /conversation <id> Load a past conversation
  /model <name>      Switch AI model mid-session
  /sync              Sync events and conversations with remote server
  /tools             List registered tools
  /goals             List all scheduled goals
  /goal add "<prompt>" --every <interval> [--once]
  /goal remove <id>  Remove a goal
  /goal pause <id>   Pause a goal
  /goal resume <id>  Resume a paused goal
  /goal outcomes <id> Show execution history
  /approvals         Show pending approval queue
  /reflect           Trigger reflection — see what the agent learned
  /mcp list          List MCP servers and trust status
  /mcp trust <name>  Mark MCP server as trusted (tools skip approval)
  /mcp untrust <name> Mark MCP server as untrusted (tools require approval)
  /operator          Show operator mode status
  quit, exit         Exit the REPL
`.trim(),
  );
}

export function printVersion(): void {
  console.log(VERSION);
}

function printBanner(opts: {
  motebitId: string;
  provider: string;
  model: string;
  toolCount: number;
  goalCount: number;
  operator: boolean;
}): void {
  const W = 46; // inner width
  const pad = (s: string) => s + " ".repeat(Math.max(0, W - s.length));
  const id = opts.motebitId.slice(0, 8);
  const model = opts.model.replace(/^claude-/, "").slice(0, 20);
  const providerInfo = `${opts.provider} \u00b7 ${model}`;
  const toolGoal = `${opts.toolCount} tools \u00b7 ${opts.goalCount} goals`;
  const op = opts.operator ? " \u00b7 operator" : "";
  const header = `\u2500 motebit v${VERSION} `;
  const headerPad = "\u2500".repeat(Math.max(0, W - header.length));

  console.log(`  \u256d${header}${headerPad}\u256e`);
  console.log(`  \u2502${pad("")}\u2502`);
  console.log(`  \u2502${pad("          .")}\u2502`);
  console.log(`  \u2502${pad(`        .:::.          ${id}`)}\u2502`);
  console.log(`  \u2502${pad(`       .:::::.         ${providerInfo}`)}\u2502`);
  console.log(`  \u2502${pad(`       :::::::         ${toolGoal}${op}`)}\u2502`);
  console.log(`  \u2502${pad("       ':::::'")}\u2502`);
  console.log(`  \u2502${pad("         '''")}\u2502`);
  console.log(`  \u2502${pad("")}\u2502`);
  console.log(`  \u2502${pad("   /help for commands \u00b7 /goals to manage")}\u2502`);
  console.log(`  \u2570${"─".repeat(W)}\u256f`);
}

// --- Conversation History ---

export function trimHistory(
  history: { role: "user" | "assistant"; content: string }[],
): { role: "user" | "assistant"; content: string }[] {
  const maxMessages = 40;
  if (history.length > maxMessages) {
    return history.slice(history.length - maxMessages);
  }
  return history;
}

// --- Conversation Sync Store Adapter ---

/**
 * Bridges SqliteConversationStore (camelCase) to ConversationSyncStoreAdapter (snake_case).
 */
class SqliteConversationSyncStoreAdapter implements ConversationSyncStoreAdapter {
  constructor(private store: MotebitDatabase["conversationStore"]) {}

  getConversationsSince(motebitId: string, since: number): SyncConversation[] {
    return this.store.getConversationsSince(motebitId, since).map((c) => ({
      conversation_id: c.conversationId,
      motebit_id: c.motebitId,
      started_at: c.startedAt,
      last_active_at: c.lastActiveAt,
      title: c.title,
      summary: c.summary,
      message_count: c.messageCount,
    }));
  }

  getMessagesSince(conversationId: string, since: number): SyncConversationMessage[] {
    return this.store.getMessagesSince(conversationId, since).map((m) => ({
      message_id: m.messageId,
      conversation_id: m.conversationId,
      motebit_id: m.motebitId,
      role: m.role,
      content: m.content,
      tool_calls: m.toolCalls,
      tool_call_id: m.toolCallId,
      created_at: m.createdAt,
      token_estimate: m.tokenEstimate,
    }));
  }

  upsertConversation(conv: SyncConversation): void {
    this.store.upsertConversation({
      conversationId: conv.conversation_id,
      motebitId: conv.motebit_id,
      startedAt: conv.started_at,
      lastActiveAt: conv.last_active_at,
      title: conv.title,
      summary: conv.summary,
      messageCount: conv.message_count,
    });
  }

  upsertMessage(msg: SyncConversationMessage): void {
    this.store.upsertMessage({
      messageId: msg.message_id,
      conversationId: msg.conversation_id,
      motebitId: msg.motebit_id,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.tool_calls,
      toolCallId: msg.tool_call_id,
      createdAt: msg.created_at,
      tokenEstimate: msg.token_estimate,
    });
  }
}

// --- Slash Commands ---

export function isSlashCommand(input: string): boolean {
  return input.startsWith("/");
}

export function parseSlashCommand(input: string): { command: string; args: string } {
  const spaceIdx = input.indexOf(" ");
  if (spaceIdx === -1) {
    return { command: input.slice(1), args: "" };
  }
  return { command: input.slice(1, spaceIdx), args: input.slice(spaceIdx + 1).trim() };
}

// --- State Formatting ---

function formatState(state: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(state)) {
    const display = typeof value === "number" ? value.toFixed(3) : String(value);
    lines.push(`  ${key.padEnd(20)} ${display}`);
  }
  return lines.join("\n");
}

// --- Configuration ---

function getApiKey(): string {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key == null || key === "") {
    console.error(
      "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
        "Set it with: export ANTHROPIC_API_KEY=sk-ant-...",
    );
    process.exit(1);
  }
  return key;
}

function getDbPath(override?: string): string {
  if (override != null && override !== "") return override;
  const envPath = process.env["MOTEBIT_DB_PATH"];
  if (envPath != null && envPath !== "") return envPath;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  return path.join(CONFIG_DIR, "motebit.db");
}

// --- Provider Factory ---

function createProvider(
  config: CliConfig,
  personalityConfig?: MotebitPersonalityConfig,
): StreamingProvider {
  const temperature = personalityConfig?.temperature ?? 0.7;

  if (config.provider === "ollama") {
    return new OllamaProvider({
      model: config.model,
      max_tokens: 1024,
      temperature,
      personalityConfig,
    });
  }

  const apiKey = getApiKey();
  return new CloudProvider({
    provider: "anthropic",
    api_key: apiKey,
    model: config.model,
    max_tokens: 1024,
    temperature,
    personalityConfig,
  });
}

// --- Identity Bootstrap ---

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function promptPassphrase(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

async function encryptPrivateKey(
  privKeyHex: string,
  passphrase: string,
): Promise<FullConfig["cli_encrypted_key"]> {
  const salt = generateSalt(); // 16 bytes (NIST SP 800-132)
  const key = await deriveKey(passphrase, salt);
  const payload: EncryptedPayload = await encrypt(new TextEncoder().encode(privKeyHex), key);
  return {
    ciphertext: toHex(payload.ciphertext),
    nonce: toHex(payload.nonce),
    tag: toHex(payload.tag),
    salt: toHex(salt),
  };
}

async function decryptPrivateKey(
  encKey: NonNullable<FullConfig["cli_encrypted_key"]>,
  passphrase: string,
): Promise<string> {
  const salt = fromHex(encKey.salt);
  const key = await deriveKey(passphrase, salt);
  const payload: EncryptedPayload = {
    ciphertext: fromHex(encKey.ciphertext),
    nonce: fromHex(encKey.nonce),
    tag: fromHex(encKey.tag),
  };
  const decrypted = await decrypt(payload, key);
  return new TextDecoder().decode(decrypted);
}

async function bootstrapIdentity(
  moteDb: MotebitDatabase,
  fullConfig: FullConfig,
  passphrase: string,
): Promise<{ motebitId: string; isFirstLaunch: boolean }> {
  const configStore: BootstrapConfigStore = {
    read() {
      if (fullConfig.motebit_id == null || fullConfig.motebit_id === "")
        return Promise.resolve(null);
      return Promise.resolve({
        motebit_id: fullConfig.motebit_id,
        device_id: fullConfig.device_id ?? "",
        device_public_key: fullConfig.device_public_key ?? "",
      });
    },
    write(state): Promise<void> {
      fullConfig.motebit_id = state.motebit_id;
      fullConfig.device_id = state.device_id;
      fullConfig.device_public_key = state.device_public_key;
      saveFullConfig(fullConfig);
      return Promise.resolve();
    },
  };

  const keyStore: BootstrapKeyStore = {
    async storePrivateKey(privKeyHex) {
      fullConfig.cli_encrypted_key = await encryptPrivateKey(privKeyHex, passphrase);
      delete fullConfig.cli_private_key;
      saveFullConfig(fullConfig);
    },
  };

  const result = await sharedBootstrapIdentity({
    surfaceName: "cli",
    identityStorage: moteDb.identityStorage,
    eventStoreAdapter: moteDb.eventStore,
    configStore,
    keyStore,
  });

  return { motebitId: result.motebitId, isFirstLaunch: result.isFirstLaunch };
}

// --- Tool Registry Setup ---

function buildToolRegistry(
  config: CliConfig,
  runtimeRef: { current: MotebitRuntime | null },
  motebitId: string,
): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();

  // Always available (R0/R1): read-only file access, web search, web read
  registry.register(readFileDefinition, createReadFileHandler(config.allowedPaths));

  // Search provider chain: Brave (if API key configured) → DuckDuckGo fallback
  const braveKey = process.env["BRAVE_SEARCH_API_KEY"];
  let searchProvider: SearchProvider | undefined;
  if (braveKey != null && braveKey !== "") {
    searchProvider = new FallbackSearchProvider([
      new BraveSearchProvider(braveKey),
      new DuckDuckGoSearchProvider(),
    ]);
  }
  registry.register(webSearchDefinition, createWebSearchHandler(searchProvider));
  registry.register(readUrlDefinition, createReadUrlHandler());

  // Deferred handlers for memory/events (need runtime, which needs registry)
  const memorySearchFn = async (query: string, limit: number) => {
    if (!runtimeRef.current) return [];
    const queryEmbedding = await embedText(query);
    const nodes = await runtimeRef.current.memory.retrieve(queryEmbedding, { limit });
    return nodes.map((n) => ({ content: n.content, confidence: n.confidence }));
  };
  const eventQueryFn = async (limit: number, eventType?: string) => {
    if (!runtimeRef.current) return [];
    const filter: {
      motebit_id: string;
      limit: number;
      event_types?: import("@motebit/sdk").EventType[];
    } = {
      motebit_id: motebitId,
      limit,
    };
    if (eventType != null && eventType !== "") {
      filter.event_types = [eventType as EventType];
    }
    const events = await runtimeRef.current.events.query(filter);
    return events.map((e) => ({
      event_type: e.event_type,
      timestamp: e.timestamp,
      payload: e.payload,
    }));
  };

  registry.register(recallMemoriesDefinition, createRecallMemoriesHandler(memorySearchFn));
  registry.register(listEventsDefinition, createListEventsHandler(eventQueryFn));

  // Operator-only (R2+): write files, execute shell commands
  if (config.operator) {
    registry.register(writeFileDefinition, createWriteFileHandler(config.allowedPaths));
    registry.register(shellExecDefinition, createShellExecHandler());
  }

  return registry;
}

// --- Bootstrap Runtime ---

async function createRuntime(
  config: CliConfig,
  motebitId: string,
  toolRegistry: InMemoryToolRegistry,
  mcpServers: McpServerConfig[],
  personalityConfig?: MotebitPersonalityConfig,
  encKey?: Uint8Array,
): Promise<{ runtime: MotebitRuntime; moteDb: MotebitDatabase }> {
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  const provider = createProvider(config, personalityConfig);

  console.log(`Data: ${dbPath}`);
  console.log(`Provider: ${config.provider} (${provider.model})`);
  if (config.operator) {
    console.log("Operator mode: enabled");
  }

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
      },
    },
    {
      storage,
      renderer: new NullRenderer(),
      ai: provider,
      tools: toolRegistry,
    },
  );

  // Wire sync if configured
  const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
  const syncToken = config.syncToken ?? process.env["MOTEBIT_SYNC_TOKEN"];

  if (syncUrl != null && syncUrl !== "") {
    const httpAdapter = new HttpEventStoreAdapter({
      baseUrl: syncUrl,
      motebitId,
      authToken: syncToken,
    });
    // Wrap with encryption if key available (zero-knowledge relay)
    const remoteStore = encKey
      ? new EncryptedEventStoreAdapter({ inner: httpAdapter, key: encKey })
      : httpAdapter;
    runtime.connectSync(remoteStore);
    console.log(`Sync: ${syncUrl}${encKey ? " (encrypted)" : ""}`);
  } else {
    console.log("Sync: disabled (set MOTEBIT_SYNC_URL to enable)");
  }

  return { runtime, moteDb };
}

// --- Streaming Consumer with Tool Status + Approval ---

function rlQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

async function consumeStream(
  stream: AsyncGenerator<StreamChunk>,
  runtime: MotebitRuntime,
  rl: readline.Interface,
): Promise<void> {
  let pendingApproval: {
    tool_call_id: string;
    name: string;
    args: Record<string, unknown>;
  } | null = null;

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "text":
        process.stdout.write(chunk.text);
        break;

      case "tool_status":
        if (chunk.status === "calling") {
          process.stdout.write(`\n  [tool] ${chunk.name}...`);
        } else {
          process.stdout.write(" done\n");
        }
        break;

      case "approval_request":
        pendingApproval = { tool_call_id: chunk.tool_call_id, name: chunk.name, args: chunk.args };
        break;

      case "injection_warning":
        process.stdout.write(`\n  [warning] suspicious content in ${chunk.tool_name}\n`);
        break;

      case "result": {
        const result = chunk.result;
        console.log("\n");

        if (result.memoriesFormed.length > 0) {
          console.log(
            `  [memories: ${result.memoriesFormed.map((m: { content: string }) => m.content).join(", ")}]`,
          );
        }

        const s = result.stateAfter;
        console.log(
          `  [state: attention=${s.attention.toFixed(2)} confidence=${s.confidence.toFixed(2)} valence=${s.affect_valence.toFixed(2)} curiosity=${s.curiosity.toFixed(2)}]`,
        );
        const bodyLine = formatBodyAwareness(result.cues);
        if (bodyLine) console.log(`  ${bodyLine}`);
        console.log();
        break;
      }
    }
  }

  // Handle approval request after stream ends — deterministic resumption
  if (pendingApproval) {
    const argsPreview = JSON.stringify(pendingApproval.args).slice(0, 80);
    const answer = await rlQuestion(
      rl,
      `  [approval] ${pendingApproval.name}(${argsPreview})\n  Allow? (y/n) `,
    );

    const approved = answer.trim().toLowerCase() === "y";
    process.stdout.write("\nmote> ");
    await consumeStream(runtime.resumeAfterApproval(approved), runtime, rl);
  }
}

// --- Slash Command Handlers ---

export interface ReplContext {
  moteDb: MotebitDatabase;
  motebitId: string;
  mcpAdapters: McpClientAdapter[];
  privateKeyBytes?: Uint8Array;
  deviceId?: string;
}

export async function handleSlashCommand(
  cmd: string,
  args: string,
  runtime: MotebitRuntime,
  config: CliConfig,
  fullConfig?: FullConfig,
  repl?: ReplContext,
): Promise<void> {
  switch (cmd) {
    case "help":
      console.log(
        `
Available commands:
  /help              Show this help
  /memories          List all memories
  /state             Show current state vector
  /forget <nodeId>   Delete a memory by ID
  /export            Export all memories and state as JSON
  /clear             Clear conversation history
  /summarize         Summarize current conversation
  /conversations     List recent conversations
  /conversation <id> Load a past conversation
  /model <name>      Switch AI model
  /sync              Sync events and conversations with remote server
  /tools             List registered tools
  /goals             List all scheduled goals
  /goal add "<prompt>" --every <interval> [--once]
  /goal remove <id>  Remove a goal
  /goal pause <id>   Pause a goal
  /goal resume <id>  Resume a paused goal
  /goal outcomes <id> Show execution history
  /approvals         Show pending approval queue
  /reflect           Trigger reflection — see what the agent learned
  /mcp list          List MCP servers and trust status
  /mcp add <name> <url> [--motebit]  Add an HTTP MCP server
  /mcp remove <name> Remove an MCP server
  /mcp trust <name>  Trust an MCP server
  /mcp untrust <name> Untrust an MCP server
  /discover [cap]    Discover agents on the relay (optional capability filter)
  /discover dom.com  Discover motebit at domain via DNS/well-known
  /operator          Show operator mode status
  quit, exit         Exit
`.trim(),
      );
      break;

    case "memories": {
      const data = await runtime.memory.exportAll();
      if (data.nodes.length === 0) {
        console.log("No memories stored yet.");
      } else {
        console.log(`\nMemories (${data.nodes.length}):\n`);
        for (const node of data.nodes) {
          console.log(
            `  ${node.node_id.slice(0, 8)}  [conf=${node.confidence.toFixed(2)} sens=${node.sensitivity}]  ${node.content}`,
          );
        }
      }
      break;
    }

    case "state": {
      const state = runtime.getState();
      console.log("\nState vector:\n" + formatState(state as unknown as Record<string, unknown>));
      break;
    }

    case "forget": {
      if (!args) {
        console.log("Usage: /forget <nodeId>");
        break;
      }
      try {
        await runtime.memory.deleteMemory(args);
        console.log(`Deleted memory: ${args}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to delete memory: ${message}`);
      }
      break;
    }

    case "export": {
      const memories = await runtime.memory.exportAll();
      const state = runtime.getState();
      const exportData = { memories, state };
      console.log(JSON.stringify(exportData, null, 2));
      break;
    }

    case "clear":
      runtime.resetConversation();
      console.log("Conversation history cleared.");
      break;

    case "summarize": {
      try {
        const summary = await runtime.summarizeCurrentConversation();
        if (summary != null && summary !== "") {
          console.log(`\nSummary:\n${summary}`);
        } else {
          console.log("No conversation to summarize (need at least 2 messages).");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Summarization failed: ${message}`);
      }
      break;
    }

    case "model": {
      if (!args) {
        console.log(`Current model: ${runtime.currentModel}`);
        break;
      }
      runtime.setModel(args);
      console.log(`Model switched to: ${args}`);
      break;
    }

    case "sync": {
      try {
        console.log("Syncing events...");
        const result = await runtime.sync.sync();
        console.log(`  Events — pushed: ${result.pushed}, pulled: ${result.pulled}`);
        if (result.conflicts.length > 0) {
          console.log(`  Conflicts: ${result.conflicts.length}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Event sync failed: ${message}`);
      }

      // Conversation sync
      if (repl) {
        const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
        if (syncUrl != null && syncUrl !== "") {
          try {
            console.log("Syncing conversations...");
            const convStoreAdapter = new SqliteConversationSyncStoreAdapter(
              repl.moteDb.conversationStore,
            );
            const convSyncEngine = new ConversationSyncEngine(convStoreAdapter, repl.motebitId);
            const syncToken = config.syncToken ?? process.env["MOTEBIT_SYNC_TOKEN"];
            convSyncEngine.connectRemote(
              new HttpConversationSyncAdapter({
                baseUrl: syncUrl,
                motebitId: repl.motebitId,
                authToken: syncToken,
              }),
            );
            const convResult = await convSyncEngine.sync();
            console.log(
              `  Conversations — pushed: ${convResult.conversations_pushed}, pulled: ${convResult.conversations_pulled}`,
            );
            console.log(
              `  Messages — pushed: ${convResult.messages_pushed}, pulled: ${convResult.messages_pulled}`,
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Conversation sync failed: ${message}`);
          }
        } else {
          console.log("  Conversation sync: skipped (no sync URL)");
        }
      }
      break;
    }

    case "tools": {
      const tools = runtime.getToolRegistry().list();
      if (tools.length === 0) {
        console.log("No tools registered.");
      } else {
        console.log(`\nRegistered tools (${tools.length}):\n`);
        for (const tool of tools) {
          console.log(`  ${tool.name.padEnd(24)} ${tool.description.slice(0, 60)}`);
        }
      }
      break;
    }

    case "conversations": {
      const convList = runtime.listConversations(20);
      if (convList.length === 0) {
        console.log("No conversations found.");
      } else {
        console.log(`\nConversations (${convList.length}):\n`);
        for (const c of convList) {
          const id = c.conversationId.slice(0, 8);
          const ago = formatTimeAgo(Date.now() - c.lastActiveAt);
          const title = c.title ?? "(untitled)";
          console.log(
            `  ${id}  ${ago.padEnd(10)} ${String(c.messageCount).padEnd(4)} msgs  ${title}`,
          );
        }
        console.log("\nLoad a conversation: /conversation <id>");
      }
      break;
    }

    case "conversation": {
      if (args == null || args === "") {
        const convId = runtime.getConversationId();
        if (convId != null && convId !== "") {
          console.log(`Active conversation: ${convId.slice(0, 8)}...`);
        } else {
          console.log("No active conversation. Use /conversations to list past ones.");
        }
        break;
      }
      const convList = runtime.listConversations(100);
      const match = convList.find(
        (c) => c.conversationId === args || c.conversationId.startsWith(args),
      );
      if (!match) {
        console.log(`No conversation found matching "${args}".`);
        break;
      }
      runtime.loadConversation(match.conversationId);
      const history = runtime.getConversationHistory();
      console.log(
        `Loaded conversation ${match.conversationId.slice(0, 8)} (${history.length} messages)`,
      );
      break;
    }

    case "operator":
      console.log(`Operator mode: ${config.operator ? "enabled" : "disabled"}`);
      if (!config.operator) {
        console.log("  Start with --operator to enable write/exec tools");
      }
      break;

    case "goals": {
      if (!repl) {
        console.log("Goals not available in this context.");
        break;
      }
      const goals = repl.moteDb.goalStore.list(repl.motebitId);
      if (goals.length === 0) {
        console.log("No goals scheduled. Use /goal add to create one.");
        break;
      }
      console.log(`\nGoals (${goals.length}):\n`);
      for (const g of goals) {
        const id = g.goal_id.slice(0, 8);
        const interval = formatMs(g.interval_ms);
        const statusIcon =
          g.status === "active"
            ? "+"
            : g.status === "paused"
              ? "~"
              : g.status === "completed"
                ? "*"
                : "!";
        const mode = g.mode === "once" ? " (once)" : "";
        const outcomes = repl.moteDb.goalOutcomeStore.listForGoal(g.goal_id, 1);
        const lastOutcome =
          outcomes.length > 0
            ? ` — last: ${outcomes[0]!.status}${outcomes[0]!.summary != null && outcomes[0]!.summary !== "" ? ` "${outcomes[0]!.summary.slice(0, 30)}"` : ""}`
            : "";
        console.log(
          `  [${statusIcon}] ${id}  "${g.prompt.slice(0, 45)}" every ${interval}${mode}${lastOutcome}`,
        );
      }
      console.log(`\n  + active  ~ paused  * completed  ! failed`);
      break;
    }

    case "goal": {
      if (!repl) {
        console.log("Goals not available in this context.");
        break;
      }
      const parts = args.match(/^(\S+)\s*([\s\S]*)$/) ?? [];
      const goalSub = parts[1] ?? "";
      const goalArgs = (parts[2] ?? "").trim();

      if (goalSub === "add") {
        // Parse: /goal add "prompt" --every 30m [--once]
        const promptMatch =
          goalArgs.match(/^["'](.+?)["']\s*(.*)$/) ?? goalArgs.match(/^(\S+)\s*(.*)$/);
        if (!promptMatch) {
          console.log('Usage: /goal add "check emails" --every 30m [--once]');
          break;
        }
        const prompt = promptMatch[1]!;
        const rest = promptMatch[2] ?? "";
        const everyMatch = rest.match(/--every\s+(\S+)/);
        if (!everyMatch) {
          console.log(
            'Error: --every <interval> is required. E.g. /goal add "check emails" --every 30m',
          );
          break;
        }
        let intervalMs: number;
        try {
          intervalMs = parseInterval(everyMatch[1]!);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`Error: ${msg}`);
          break;
        }
        const once = rest.includes("--once");
        let wallClockMs: number | null = null;
        const wallClockMatch = rest.match(/--wall-clock\s+(\S+)/);
        if (wallClockMatch) {
          try {
            wallClockMs = parseInterval(wallClockMatch[1]!);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`Error parsing --wall-clock: ${msg}`);
            break;
          }
        }
        const projectMatch = rest.match(/--project\s+(\S+)/);
        const projectId = projectMatch ? projectMatch[1]! : null;
        const goalId = crypto.randomUUID();
        repl.moteDb.goalStore.add({
          goal_id: goalId,
          motebit_id: repl.motebitId,
          prompt,
          interval_ms: intervalMs,
          last_run_at: null,
          enabled: true,
          created_at: Date.now(),
          mode: once ? "once" : "recurring",
          status: "active",
          parent_goal_id: null,
          max_retries: 3,
          consecutive_failures: 0,
          wall_clock_ms: wallClockMs,
          project_id: projectId,
        });
        const modeLabel = once ? " (one-shot)" : "";
        const wallClockLabel = wallClockMs != null ? ` (wall-clock: ${wallClockMatch![1]})` : "";
        const projectLabel = projectId != null ? ` [project: ${projectId}]` : "";
        console.log(
          `Goal added: ${goalId.slice(0, 8)} — "${prompt}" every ${everyMatch[1]}${modeLabel}${wallClockLabel}${projectLabel}`,
        );
      } else if (goalSub === "remove") {
        if (!goalArgs) {
          console.log("Usage: /goal remove <goal_id>");
          break;
        }
        const goals = repl.moteDb.goalStore.list(repl.motebitId);
        const match = goals.find((g) => g.goal_id === goalArgs || g.goal_id.startsWith(goalArgs));
        if (!match) {
          console.log(`No goal found matching "${goalArgs}".`);
          break;
        }
        repl.moteDb.goalStore.remove(match.goal_id);
        console.log(`Goal removed: ${match.goal_id.slice(0, 8)}`);
      } else if (goalSub === "pause") {
        if (!goalArgs) {
          console.log("Usage: /goal pause <goal_id>");
          break;
        }
        const goals = repl.moteDb.goalStore.list(repl.motebitId);
        const match = goals.find((g) => g.goal_id === goalArgs || g.goal_id.startsWith(goalArgs));
        if (!match) {
          console.log(`No goal found matching "${goalArgs}".`);
          break;
        }
        repl.moteDb.goalStore.setEnabled(match.goal_id, false);
        console.log(`Goal paused: ${match.goal_id.slice(0, 8)}`);
      } else if (goalSub === "resume") {
        if (!goalArgs) {
          console.log("Usage: /goal resume <goal_id>");
          break;
        }
        const goals = repl.moteDb.goalStore.list(repl.motebitId);
        const match = goals.find((g) => g.goal_id === goalArgs || g.goal_id.startsWith(goalArgs));
        if (!match) {
          console.log(`No goal found matching "${goalArgs}".`);
          break;
        }
        repl.moteDb.goalStore.setEnabled(match.goal_id, true);
        console.log(`Goal resumed: ${match.goal_id.slice(0, 8)}`);
      } else if (goalSub === "outcomes") {
        if (!goalArgs) {
          console.log("Usage: /goal outcomes <goal_id>");
          break;
        }
        const goals = repl.moteDb.goalStore.list(repl.motebitId);
        const match = goals.find((g) => g.goal_id === goalArgs || g.goal_id.startsWith(goalArgs));
        if (!match) {
          console.log(`No goal found matching "${goalArgs}".`);
          break;
        }
        const outcomes = repl.moteDb.goalOutcomeStore.listForGoal(match.goal_id, 10);
        if (outcomes.length === 0) {
          console.log(`No outcomes for goal ${match.goal_id.slice(0, 8)}.`);
          break;
        }
        console.log(`\nOutcomes for ${match.goal_id.slice(0, 8)} (${outcomes.length}):\n`);
        for (const o of outcomes) {
          const ago = formatTimeAgo(Date.now() - o.ran_at);
          const detail =
            o.error_message != null && o.error_message !== ""
              ? `[error: ${o.error_message.slice(0, 40)}]`
              : o.summary != null && o.summary !== ""
                ? `"${o.summary.slice(0, 50)}"`
                : "—";
          console.log(
            `  ${ago.padEnd(10)} ${o.status.padEnd(11)} tools:${o.tool_calls_made} mem:${o.memories_formed}  ${detail}`,
          );
        }
      } else {
        console.log("Usage: /goal [add|remove|pause|resume|outcomes] — or /goals to list");
      }
      break;
    }

    case "approvals": {
      if (!repl) {
        console.log("Approvals not available in this context.");
        break;
      }
      const items = repl.moteDb.approvalStore.listAll(repl.motebitId);
      const pending = items.filter((a) => a.status === "pending");
      if (pending.length === 0) {
        console.log("No pending approvals.");
        if (items.length > 0) {
          console.log(`(${items.length} total — use 'motebit approvals list' for full history)`);
        }
        break;
      }
      console.log(`\nPending approvals (${pending.length}):\n`);
      for (const a of pending) {
        const id = a.approval_id.slice(0, 8);
        const ago = formatTimeAgo(Date.now() - a.created_at);
        const goalId = a.goal_id.slice(0, 8);
        console.log(`  ${id}  ${a.tool_name.padEnd(20)} goal:${goalId}  ${ago}`);
        if (a.args_preview) {
          console.log(`         args: ${a.args_preview.slice(0, 60)}`);
        }
      }
      console.log(`\nApprove/deny via: motebit approvals approve/deny <id>`);
      break;
    }

    case "reflect": {
      try {
        console.log("Reflecting...");
        const reflection: ReflectionResult = await runtime.reflect();

        if (reflection.insights.length > 0) {
          console.log("\nInsights:");
          for (const insight of reflection.insights) {
            console.log(`  - ${insight}`);
          }
        }

        if (reflection.planAdjustments.length > 0) {
          console.log("\nAdjustments:");
          for (const adj of reflection.planAdjustments) {
            console.log(`  - ${adj}`);
          }
        }

        if (reflection.selfAssessment) {
          console.log(`\nSelf-assessment: ${reflection.selfAssessment}`);
        }

        if (reflection.insights.length > 0) {
          console.log(`\n  [${reflection.insights.length} insight(s) stored as memories]`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Reflection failed: ${message}`);
      }
      break;
    }

    case "mcp": {
      if (!fullConfig) {
        console.log("MCP config not available.");
        break;
      }
      const [subCmd, ...subArgs] = args.split(/\s+/);
      const serverName = subArgs.join(" ");

      if (subCmd == null || subCmd === "" || subCmd === "list") {
        const servers = fullConfig.mcp_servers ?? [];
        const trusted = fullConfig.mcp_trusted_servers ?? [];
        if (servers.length === 0) {
          console.log("No MCP servers configured.");
        } else {
          console.log(`\nMCP servers (${servers.length}):\n`);
          for (const s of servers) {
            const isTrusted = trusted.includes(s.name);
            const transport = s.transport ?? "stdio";
            const adapter = repl?.mcpAdapters.find((a) => a.serverName === s.name);
            const connected = adapter?.isConnected ? "connected" : "disconnected";
            const motebitStatus = adapter?.isMotebit
              ? adapter.verifiedIdentity?.verified
                ? " motebit:verified"
                : " motebit:unverified"
              : "";
            console.log(
              `  ${s.name.padEnd(20)} ${transport.padEnd(6)} ${(isTrusted ? "trusted" : "untrusted").padEnd(10)} ${connected}${motebitStatus}`,
            );
          }
        }
      } else if (subCmd === "add") {
        if (!repl) {
          console.log("REPL context not available.");
          break;
        }
        // Parse: /mcp add <name> <url> [--motebit]
        const addArgs = subArgs;
        const motebitFlag = addArgs.includes("--motebit");
        const filtered = addArgs.filter((a) => a !== "--motebit");
        const addName = filtered[0];
        const addUrl = filtered[1];
        if (!addName || !addUrl) {
          console.log("Usage: /mcp add <name> <url> [--motebit]");
          break;
        }
        const existing = (fullConfig.mcp_servers ?? []).find((s) => s.name === addName);
        if (existing) {
          console.log(`Server "${addName}" already configured. Use /mcp remove first.`);
          break;
        }
        const serverCfg: McpServerConfig = {
          name: addName,
          transport: "http",
          url: addUrl,
          ...(motebitFlag ? { motebit: true } : {}),
          ...(motebitFlag && repl.privateKeyBytes && repl.deviceId
            ? {
                callerMotebitId: repl.motebitId,
                callerDeviceId: repl.deviceId,
                callerPrivateKey: repl.privateKeyBytes,
              }
            : {}),
        };
        const adapter = new McpClientAdapter(serverCfg);
        try {
          await adapter.connect();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`Failed to connect to "${addName}": ${message}`);
          break;
        }
        // Pin manifest hash, register tools — cleanup adapter on failure
        let manifest: Awaited<ReturnType<typeof adapter.checkManifest>>;
        try {
          manifest = await adapter.checkManifest();
          const tmpRegistry = new InMemoryToolRegistry();
          adapter.registerInto(tmpRegistry);
          runtime.registerExternalTools(`mcp:${addName}`, tmpRegistry);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          try {
            await adapter.disconnect();
          } catch {
            /* best effort */
          }
          console.log(`Failed to register tools from "${addName}": ${message}`);
          break;
        }
        // Track adapter
        repl.mcpAdapters.push(adapter);
        // Persist to config (without transient fields like callerPrivateKey)
        const persistCfg: McpServerConfig = {
          name: addName,
          transport: "http",
          url: addUrl,
          ...(motebitFlag ? { motebit: true } : {}),
        };
        if (adapter.verifiedIdentity?.verified && adapter.serverConfig.motebitPublicKey) {
          persistCfg.motebitPublicKey = adapter.serverConfig.motebitPublicKey;
        }
        fullConfig.mcp_servers = [...(fullConfig.mcp_servers ?? []), persistCfg];
        saveFullConfig(fullConfig);
        // Output
        const verifiedStr = adapter.verifiedIdentity?.verified
          ? ` (motebit: ${adapter.verifiedIdentity.motebit_id?.slice(0, 12)}... verified)`
          : "";
        console.log(`Added "${addName}" — ${manifest.toolCount} tool(s)${verifiedStr}`);
      } else if (subCmd === "remove") {
        if (!repl) {
          console.log("REPL context not available.");
          break;
        }
        const removeName = subArgs[0];
        if (!removeName) {
          console.log("Usage: /mcp remove <name>");
          break;
        }
        // Disconnect adapter if connected
        const adapterIdx = repl.mcpAdapters.findIndex((a) => a.serverName === removeName);
        if (adapterIdx >= 0) {
          const removedAdapter = repl.mcpAdapters[adapterIdx];
          if (removedAdapter) {
            try {
              await removedAdapter.disconnect();
            } catch {
              /* best effort */
            }
          }
          repl.mcpAdapters.splice(adapterIdx, 1);
        }
        // Unregister tools from runtime
        runtime.unregisterExternalTools(`mcp:${removeName}`);
        // Remove from config
        fullConfig.mcp_servers = (fullConfig.mcp_servers ?? []).filter(
          (s) => s.name !== removeName,
        );
        fullConfig.mcp_trusted_servers = (fullConfig.mcp_trusted_servers ?? []).filter(
          (n) => n !== removeName,
        );
        saveFullConfig(fullConfig);
        console.log(`Removed "${removeName}".`);
      } else if (subCmd === "trust") {
        if (!serverName) {
          console.log("Usage: /mcp trust <server-name>");
          break;
        }
        const trusted = fullConfig.mcp_trusted_servers ?? [];
        if (!trusted.includes(serverName)) {
          fullConfig.mcp_trusted_servers = [...trusted, serverName];
          saveFullConfig(fullConfig);
        }
        console.log(`Marked "${serverName}" as trusted. Restart to apply.`);
      } else if (subCmd === "untrust") {
        if (!serverName) {
          console.log("Usage: /mcp untrust <server-name>");
          break;
        }
        const trusted = fullConfig.mcp_trusted_servers ?? [];
        fullConfig.mcp_trusted_servers = trusted.filter((n) => n !== serverName);
        saveFullConfig(fullConfig);
        console.log(`Marked "${serverName}" as untrusted. Restart to apply.`);
      } else {
        console.log(
          "Usage: /mcp [list|add <name> <url>|remove <name>|trust <name>|untrust <name>]",
        );
      }
      break;
    }

    case "discover": {
      const discoverArg = args.trim();

      // Domain-based discovery: argument contains a dot → DNS/well-known lookup
      if (discoverArg && discoverArg.includes(".")) {
        try {
          const { discoverMotebit } = await import("@motebit/mcp-client");
          const result = await discoverMotebit(discoverArg);
          if (result.identityVerified) {
            console.log(`\nFound motebit at ${result.domain}:`);
            if (result.motebitId) console.log(`  ID: ${result.motebitId}`);
            if (result.motebitType) console.log(`  Type: ${result.motebitType}`);
            if (result.serviceName) console.log(`  Name: ${result.serviceName}`);
            if (result.endpointUrl) console.log(`  Endpoint: ${result.endpointUrl}`);
            console.log(`  Identity: verified \u2713`);
            console.log(`\nUse /mcp add ${result.domain} to connect.`);
          } else {
            console.log(`No motebit found at ${discoverArg}: ${result.error ?? "unknown error"}`);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`Discovery error: ${message}`);
        }
        break;
      }

      // Relay-based discovery: no argument or capability filter
      const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
      if (!syncUrl) {
        console.log("No sync URL configured. Set --sync-url or MOTEBIT_SYNC_URL.");
        break;
      }
      try {
        const capParam = discoverArg || undefined;
        const queryStr = capParam ? `?capability=${encodeURIComponent(capParam)}` : "";
        const token = config.syncToken ?? process.env["MOTEBIT_API_TOKEN"];
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const resp = await fetch(`${syncUrl}/api/v1/agents/discover${queryStr}`, { headers });
        if (!resp.ok) {
          console.log(`Discovery failed: ${resp.status} ${resp.statusText}`);
          break;
        }
        const data = (await resp.json()) as {
          agents: Array<{
            motebit_id: string;
            endpoint_url: string;
            capabilities: string[];
            public_key: string;
          }>;
        };
        if (data.agents.length === 0) {
          console.log(
            capParam ? `No agents found with capability "${capParam}".` : "No agents registered.",
          );
        } else {
          console.log(`\nDiscovered agents (${data.agents.length}):\n`);
          for (const agent of data.agents) {
            const caps =
              agent.capabilities.length > 0 ? agent.capabilities.slice(0, 5).join(", ") : "none";
            console.log(
              `  ${agent.motebit_id.slice(0, 12).padEnd(14)} ${agent.endpoint_url.padEnd(30)} [${caps}]`,
            );
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Discovery error: ${message}`);
      }
      break;
    }

    default:
      console.log(`Unknown command: /${cmd}. Type /help for available commands.`);
  }
}

// --- Subcommand: doctor ---

async function handleDoctor(): Promise<void> {
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

// --- Subcommand: export ---

async function handleExport(config: CliConfig): Promise<void> {
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

// --- Subcommand: run (daemon mode) ---

async function handleRun(config: CliConfig): Promise<void> {
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

  // Derive policy from governance — parseRiskLevel throws on invalid values
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

    wsAdapter = new WebSocketEventStoreAdapter({
      url: wsUrl,
      motebitId,
      authToken,
      httpFallback: httpAdapter,
      localStore: moteDb.eventStore,
    });

    // Handle agent task requests
    if (privKeyBytes) {
      const privateKey = privKeyBytes;
      wsAdapter.onCustomMessage((msg) => {
        if (msg.type === "task_request" && msg.task) {
          const task = msg.task as AgentTask;
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

    // Also wire sync via the HTTP adapter
    runtime.connectSync(httpAdapter);
  }

  // Graceful shutdown on SIGINT/SIGTERM
  const shutdown = (): void => {
    console.log("\nShutting down...");
    scheduler.stop();
    wsAdapter?.disconnect();
    runtime.stop();
    moteDb.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// --- Subcommand: serve (MCP server mode) ---

async function handleServe(config: CliConfig): Promise<void> {
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
    // Ambient mode — use config identity
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
      // Identity content unavailable — fallback to JSON identity
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
    log(`MCP server running on http://localhost:${port} (SSE). ${toolCount} tools exposed.`);
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
          async () => {
            try {
              await fetch(`${syncUrl}/api/v1/agents/heartbeat`, {
                method: "POST",
                headers: regHeaders,
              });
            } catch {
              // Best-effort heartbeat
            }
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

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    log("\nShutting down MCP server...");
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    // Deregister from relay
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
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// --- Subcommand: goal add/list/remove ---

async function handleGoalAdd(config: CliConfig): Promise<void> {
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

async function handleGoalList(config: CliConfig): Promise<void> {
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

async function handleGoalOutcomes(config: CliConfig): Promise<void> {
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

function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  return `${ms / 60_000}m`;
}

function formatTimeAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

async function handleGoalRemove(config: CliConfig): Promise<void> {
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

async function handleGoalSetEnabled(config: CliConfig, enabled: boolean): Promise<void> {
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

// --- Subcommand: approvals list/show/approve/deny ---

async function handleApprovalList(config: CliConfig): Promise<void> {
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

async function handleApprovalShow(config: CliConfig): Promise<void> {
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

async function handleApprovalApprove(config: CliConfig): Promise<void> {
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

async function handleApprovalDeny(config: CliConfig): Promise<void> {
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
    const resolved = path.resolve(filePath);
    let content: string;
    try {
      content = fs.readFileSync(resolved, "utf-8");
    } catch {
      console.error(`Error: cannot read file: ${resolved}`);
      process.exit(1);
    }
    const result = await verifyIdentityFile(content);
    if (result.valid && result.identity) {
      const pubKey = result.identity.identity.public_key;
      const fingerprint = pubKey.slice(0, 16) + "...";
      console.log(`Identity:    ${result.identity.motebit_id}`);
      console.log(`Public key:  ${fingerprint}`);
      console.log(`Signature:   valid`);
      process.exit(0);
    } else {
      console.error(`Signature:   invalid`);
      if (result.error != null && result.error !== "")
        console.error(`Error:       ${result.error}`);
      process.exit(1);
    }
  }

  if (subcommand === "doctor") {
    await handleDoctor();
    return;
  }

  if (subcommand === "export") {
    await handleExport(config);
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
  const runtimeRef: { current: MotebitRuntime | null } = { current: null };
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
