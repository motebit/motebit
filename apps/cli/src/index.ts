import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseArgs } from "node:util";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import type { StorageAdapters, StreamChunk } from "@motebit/runtime";
import { CloudProvider, OllamaProvider, formatBodyAwareness } from "@motebit/ai-core";
import type { StreamingProvider, MotebitPersonalityConfig } from "@motebit/ai-core";
import { DEFAULT_CONFIG } from "@motebit/ai-core";
import { createMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import { HttpEventStoreAdapter } from "@motebit/sync-engine";
import { EventStore } from "@motebit/event-log";
import { EventType, RiskLevel } from "@motebit/sdk";
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
} from "@motebit/tools";
import { connectMcpServers, type McpServerConfig } from "@motebit/mcp-client";
import { deriveKey, encrypt, decrypt, generateNonce } from "@motebit/crypto";
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
    nonce: string;      // hex
    tag: string;        // hex
    salt: string;       // hex
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
  reason: string | undefined;
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
      reason: { type: "string" },
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
  const allowedPaths = values["allowed-paths"]
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
    reason: values.reason,
    version: values.version,
    help: values.help,
    positionals,
  };
}

// --- Help / Version ---

export function printHelp(): void {
  console.log(`
Usage: motebit [command] [options]

Commands:
  doctor                    Check system readiness (Node, SQLite, config)
  export [--output <path>]  Export a signed motebit.md (portable identity for daemon mode)
  verify <path>             Verify a motebit.md identity file signature
  run [--identity <path>]   Start daemon mode (uses exported motebit.md)
  goal add "<prompt>" --every <interval>   Add a scheduled goal
  goal list                 List all scheduled goals
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
  /model <name>      Switch AI model mid-session
  /sync              Sync with remote server
  /tools             List registered tools
  /mcp list          List MCP servers and trust status
  /mcp trust <name>  Mark MCP server as trusted (tools skip approval)
  /mcp untrust <name> Mark MCP server as untrusted (tools require approval)
  /operator          Show operator mode status
  quit, exit         Exit the REPL
`.trim());
}

export function printVersion(): void {
  console.log(VERSION);
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
  if (!key) {
    console.error(
      "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
        "Set it with: export ANTHROPIC_API_KEY=sk-ant-...",
    );
    process.exit(1);
  }
  return key;
}

function getDbPath(override?: string): string {
  if (override) return override;
  const envPath = process.env["MOTEBIT_DB_PATH"];
  if (envPath) return envPath;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  return path.join(CONFIG_DIR, "motebit.db");
}

// --- Provider Factory ---

function createProvider(config: CliConfig, personalityConfig?: MotebitPersonalityConfig): StreamingProvider {
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
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
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
  const salt = generateNonce(); // 12 bytes
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
    async read() {
      if (!fullConfig.motebit_id) return null;
      return {
        motebit_id: fullConfig.motebit_id,
        device_id: fullConfig.device_id ?? "",
        device_public_key: fullConfig.device_public_key ?? "",
      };
    },
    async write(state) {
      fullConfig.motebit_id = state.motebit_id;
      fullConfig.device_id = state.device_id;
      fullConfig.device_public_key = state.device_public_key;
      saveFullConfig(fullConfig);
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
  registry.register(webSearchDefinition, createWebSearchHandler());
  registry.register(readUrlDefinition, createReadUrlHandler());

  // Deferred handlers for memory/events (need runtime, which needs registry)
  const memorySearchFn = async (query: string, limit: number) => {
    if (!runtimeRef.current) return [];
    const all = await runtimeRef.current.memory.exportAll();
    const queryLower = query.toLowerCase();
    const matched = all.nodes
      .filter((n) => !n.tombstoned && n.content.toLowerCase().includes(queryLower))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);
    return matched.map((n) => ({ content: n.content, confidence: n.confidence }));
  };
  const eventQueryFn = async (limit: number, eventType?: string) => {
    if (!runtimeRef.current) return [];
    const filter: { motebit_id: string; limit: number; event_types?: import("@motebit/sdk").EventType[] } = {
      motebit_id: motebitId,
      limit,
    };
    if (eventType) {
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

function createRuntime(
  config: CliConfig,
  motebitId: string,
  toolRegistry: InMemoryToolRegistry,
  mcpServers: McpServerConfig[],
  personalityConfig?: MotebitPersonalityConfig,
): { runtime: MotebitRuntime; moteDb: MotebitDatabase } {
  const dbPath = getDbPath(config.dbPath);
  const moteDb = createMotebitDatabase(dbPath);
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

  if (syncUrl) {
    const remoteStore = new HttpEventStoreAdapter({
      baseUrl: syncUrl,
      motebitId,
      authToken: syncToken,
    });
    runtime.connectSync(remoteStore);
    console.log(`Sync: ${syncUrl}`);
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
  let pendingApproval: { tool_call_id: string; name: string; args: Record<string, unknown> } | null = null;

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
          console.log(`  [memories: ${result.memoriesFormed.map((m: { content: string }) => m.content).join(", ")}]`);
        }

        const s = result.stateAfter;
        console.log(`  [state: attention=${s.attention.toFixed(2)} confidence=${s.confidence.toFixed(2)} valence=${s.affect_valence.toFixed(2)} curiosity=${s.curiosity.toFixed(2)}]`);
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

async function handleSlashCommand(
  cmd: string,
  args: string,
  runtime: MotebitRuntime,
  config: CliConfig,
  fullConfig?: FullConfig,
): Promise<void> {
  switch (cmd) {
    case "help":
      console.log(`
Available commands:
  /help              Show this help
  /memories          List all memories
  /state             Show current state vector
  /forget <nodeId>   Delete a memory by ID
  /export            Export all memories and state as JSON
  /clear             Clear conversation history
  /model <name>      Switch AI model
  /sync              Sync with remote server
  /tools             List registered tools
  /mcp list          List MCP servers and trust status
  /mcp trust <name>  Trust an MCP server
  /mcp untrust <name> Untrust an MCP server
  /operator          Show operator mode status
  quit, exit         Exit
`.trim());
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
        console.log("Syncing...");
        const result = await runtime.sync.sync();
        console.log(`Pushed: ${result.pushed}, Pulled: ${result.pulled}`);
        if (result.conflicts.length > 0) {
          console.log(`Conflicts: ${result.conflicts.length}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Sync failed: ${message}`);
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

    case "operator":
      console.log(`Operator mode: ${config.operator ? "enabled" : "disabled"}`);
      if (!config.operator) {
        console.log("  Start with --operator to enable write/exec tools");
      }
      break;

    case "mcp": {
      if (!fullConfig) {
        console.log("MCP config not available.");
        break;
      }
      const [subCmd, ...subArgs] = args.split(/\s+/);
      const serverName = subArgs.join(" ");

      if (!subCmd || subCmd === "list") {
        const servers = fullConfig.mcp_servers ?? [];
        const trusted = fullConfig.mcp_trusted_servers ?? [];
        if (servers.length === 0) {
          console.log("No MCP servers configured.");
        } else {
          console.log(`\nMCP servers (${servers.length}):\n`);
          for (const s of servers) {
            const isTrusted = trusted.includes(s.name);
            console.log(`  ${s.name.padEnd(24)} ${isTrusted ? "trusted" : "untrusted"}`);
          }
        }
      } else if (subCmd === "trust") {
        if (!serverName) { console.log("Usage: /mcp trust <server-name>"); break; }
        const trusted = fullConfig.mcp_trusted_servers ?? [];
        if (!trusted.includes(serverName)) {
          fullConfig.mcp_trusted_servers = [...trusted, serverName];
          saveFullConfig(fullConfig);
        }
        console.log(`Marked "${serverName}" as trusted. Restart to apply.`);
      } else if (subCmd === "untrust") {
        if (!serverName) { console.log("Usage: /mcp untrust <server-name>"); break; }
        const trusted = fullConfig.mcp_trusted_servers ?? [];
        fullConfig.mcp_trusted_servers = trusted.filter((n) => n !== serverName);
        saveFullConfig(fullConfig);
        console.log(`Marked "${serverName}" as untrusted. Restart to apply.`);
      } else {
        console.log("Usage: /mcp [list|trust <name>|untrust <name>]");
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

  // better-sqlite3 / SQLite
  try {
    const tmpDbPath = path.join(CONFIG_DIR, ".doctor-test.db");
    const db = createMotebitDatabase(tmpDbPath);
    db.close();
    fs.unlinkSync(tmpDbPath);
    try { fs.unlinkSync(tmpDbPath + "-wal"); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpDbPath + "-shm"); } catch { /* ignore */ }
    checks.push({ name: "SQLite", ok: true, detail: "better-sqlite3 loaded and functional" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: "SQLite", ok: false, detail: msg });
  }

  // @xenova/transformers (optional)
  try {
    await import("@xenova/transformers");
    checks.push({ name: "Embeddings", ok: true, detail: "@xenova/transformers available (local embeddings)" });
  } catch {
    checks.push({ name: "Embeddings", ok: true, detail: "not installed (optional — hash-based fallback active)" });
  }

  // Existing identity
  const fullCfg = loadFullConfig();
  if (fullCfg.motebit_id) {
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
    passphrase = envPassphrase ?? await promptPassphrase(rl, "Passphrase: ");
    try {
      await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
    } catch {
      console.error("Error: incorrect passphrase.");
      rl.close();
      process.exit(1);
    }
  } else if (fullConfig.cli_private_key) {
    passphrase = envPassphrase ?? await promptPassphrase(rl, "Set a passphrase for key encryption: ");
    if (!passphrase) { console.error("Error: passphrase cannot be empty."); rl.close(); process.exit(1); }
    fullConfig.cli_encrypted_key = await encryptPrivateKey(fullConfig.cli_private_key, passphrase);
    delete fullConfig.cli_private_key;
    saveFullConfig(fullConfig);
  } else {
    passphrase = envPassphrase ?? await promptPassphrase(rl, "Set a passphrase for your mote's key: ");
    if (!passphrase) { console.error("Error: passphrase cannot be empty."); rl.close(); process.exit(1); }
  }

  // Bootstrap identity if needed
  const dbPath = getDbPath(config.dbPath);
  const moteDb = createMotebitDatabase(dbPath);
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
  if (updatedConfig.device_id && updatedConfig.device_public_key) {
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
  const outputPath = config.output
    ? path.resolve(config.output)
    : path.resolve("motebit.md");

  fs.writeFileSync(outputPath, content, "utf-8");
  console.log(`Your agent identity file has been created: ${outputPath}`);
  rl.close();
}

// --- Subcommand: run (daemon mode) ---

async function handleRun(config: CliConfig): Promise<void> {
  const identityPath = config.identity
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
    if (verifyResult.error) console.error(`  ${verifyResult.error}`);
    process.exit(1);
  }

  const identity = verifyResult.identity;
  const gov = identity.governance;

  // Fail-closed: require all three governance thresholds before starting daemon mode.
  // Without explicit thresholds, the daemon cannot make safe auto-allow / deny decisions.
  const requiredFields = ["max_risk_auto", "require_approval_above", "deny_above"] as const;
  for (const field of requiredFields) {
    if (!gov[field]) {
      console.error(`Error: motebit.md governance.${field} is missing or empty. All three governance thresholds are required for daemon mode.`);
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
    if (validProviders.includes(personalityConfig.default_provider!)) {
      config.provider = personalityConfig.default_provider!;
    }
  }
  if (personalityConfig.default_model && !process.argv.includes("--model")) {
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
  const moteDb = createMotebitDatabase(dbPath);
  const provider = createProvider(config, personalityConfig);

  const storage: StorageAdapters = {
    eventStore: moteDb.eventStore,
    memoryStorage: moteDb.memoryStorage,
    identityStorage: moteDb.identityStorage,
    auditLog: moteDb.auditLog,
    stateSnapshot: moteDb.stateSnapshot,
    toolAuditSink: moteDb.toolAuditSink,
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
  const scheduler = new GoalScheduler(runtime, moteDb.goalStore, moteDb.approvalStore, motebitId, denyAbove);
  scheduler.start();

  console.log(`Daemon running. motebit_id: ${motebitId.slice(0, 8)}... Goals: ${goals.length}. Policy: max_risk_auto=${RiskLevel[maxRiskAuto]}, deny_above=${RiskLevel[denyAbove]}`);

  // Graceful shutdown on SIGINT/SIGTERM
  const shutdown = (): void => {
    console.log("\nShutting down...");
    scheduler.stop();
    runtime.stop();
    moteDb.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// --- Subcommand: goal add/list/remove ---

async function handleGoalAdd(config: CliConfig): Promise<void> {
  // positionals: ["goal", "add", "<prompt>"]
  const prompt = config.positionals[2];
  if (!prompt) {
    console.error('Usage: motebit goal add "<prompt>" --every <interval>');
    process.exit(1);
  }
  if (!config.every) {
    console.error('Error: --every <interval> is required. E.g. --every 30m');
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
  if (!motebitId) {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = createMotebitDatabase(dbPath);

  const goalId = crypto.randomUUID();
  moteDb.goalStore.add({
    goal_id: goalId,
    motebit_id: motebitId,
    prompt,
    interval_ms: intervalMs,
    last_run_at: null,
    enabled: true,
    created_at: Date.now(),
  });

  // Log event
  const eventStore = new EventStore(moteDb.eventStore);
  await eventStore.append({
    event_id: crypto.randomUUID(),
    motebit_id: motebitId,
    timestamp: Date.now(),
    event_type: EventType.GoalCreated,
    payload: { goal_id: goalId, prompt, interval_ms: intervalMs },
    version_clock: await moteDb.eventStore.getLatestClock(motebitId) + 1,
    tombstoned: false,
  });

  moteDb.close();
  console.log(`Goal added: ${goalId.slice(0, 8)} — "${prompt}" every ${config.every}`);
}

function handleGoalList(config: CliConfig): void {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (!motebitId) {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = createMotebitDatabase(dbPath);
  const goals = moteDb.goalStore.list(motebitId);
  moteDb.close();

  if (goals.length === 0) {
    console.log("No goals scheduled.");
    return;
  }

  console.log(`\nGoals (${goals.length}):\n`);
  console.log("  ID        Prompt                                     Interval    Last Run            Enabled");
  console.log("  " + "-".repeat(100));

  for (const g of goals) {
    const id = g.goal_id.slice(0, 8);
    const prompt = g.prompt.length > 40 ? g.prompt.slice(0, 37) + "..." : g.prompt.padEnd(40);
    const interval = formatMs(g.interval_ms).padEnd(11);
    const lastRun = g.last_run_at ? new Date(g.last_run_at).toISOString().slice(0, 19) : "never".padEnd(19);
    const enabled = g.enabled ? "yes" : "no";
    console.log(`  ${id}  ${prompt} ${interval} ${lastRun} ${enabled}`);
  }
  console.log();
}

function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  return `${ms / 60_000}m`;
}

async function handleGoalRemove(config: CliConfig): Promise<void> {
  const goalId = config.positionals[2];
  if (!goalId) {
    console.error("Usage: motebit goal remove <goal_id>");
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (!motebitId) {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = createMotebitDatabase(dbPath);

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
    version_clock: await moteDb.eventStore.getLatestClock(motebitId) + 1,
    tombstoned: false,
  });

  moteDb.close();
  console.log(`Goal removed: ${match.goal_id.slice(0, 8)}`);
}

function handleGoalSetEnabled(config: CliConfig, enabled: boolean): void {
  const goalId = config.positionals[2];
  const verb = enabled ? "resume" : "pause";
  if (!goalId) {
    console.error(`Usage: motebit goal ${verb} <goal_id>`);
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (!motebitId) {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = createMotebitDatabase(dbPath);

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

function handleApprovalList(config: CliConfig): void {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (!motebitId) {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = createMotebitDatabase(dbPath);
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

function handleApprovalShow(config: CliConfig): void {
  const approvalId = config.positionals[2];
  if (!approvalId) {
    console.error("Usage: motebit approvals show <approval_id>");
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (!motebitId) {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = createMotebitDatabase(dbPath);

  // Support prefix match
  const all = moteDb.approvalStore.listAll(motebitId);
  const match = all.find((a) => a.approval_id === approvalId || a.approval_id.startsWith(approvalId));
  moteDb.close();

  if (!match) {
    console.error(`Error: no approval found matching "${approvalId}".`);
    process.exit(1);
  }

  console.log(`Approval ID:    ${match.approval_id}`);
  console.log(`Status:         ${match.status}`);
  console.log(`Tool:           ${match.tool_name}`);
  console.log(`Risk Level:     ${match.risk_level >= 0 ? RiskLevel[match.risk_level] ?? match.risk_level : "unknown"}`);
  console.log(`Goal ID:        ${match.goal_id}`);
  console.log(`Args Preview:   ${match.args_preview.slice(0, 100)}`);
  console.log(`Args Hash:      ${match.args_hash.slice(0, 16)}...`);
  console.log(`Created:        ${new Date(match.created_at).toISOString()}`);
  console.log(`Expires:        ${new Date(match.expires_at).toISOString()}`);
  if (match.resolved_at) {
    console.log(`Resolved:       ${new Date(match.resolved_at).toISOString()}`);
  }
  if (match.denied_reason) {
    console.log(`Denied Reason:  ${match.denied_reason}`);
  }
}

function handleApprovalApprove(config: CliConfig): void {
  const approvalId = config.positionals[2];
  if (!approvalId) {
    console.error("Usage: motebit approvals approve <approval_id>");
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (!motebitId) {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = createMotebitDatabase(dbPath);

  const all = moteDb.approvalStore.listAll(motebitId);
  const match = all.find((a) => a.approval_id === approvalId || a.approval_id.startsWith(approvalId));

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

function handleApprovalDeny(config: CliConfig): void {
  const approvalId = config.positionals[2];
  if (!approvalId) {
    console.error("Usage: motebit approvals deny <approval_id> [--reason <text>]");
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (!motebitId) {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const dbPath = getDbPath(config.dbPath);
  const moteDb = createMotebitDatabase(dbPath);

  const all = moteDb.approvalStore.listAll(motebitId);
  const match = all.find((a) => a.approval_id === approvalId || a.approval_id.startsWith(approvalId));

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
  if (config.reason) {
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

  if (config.help) { printHelp(); return; }
  if (config.version) { printVersion(); return; }

  // --- Subcommands: export / verify ---

  const subcommand = config.positionals[0];

  if (subcommand === "verify") {
    const filePath = config.positionals[1];
    if (!filePath) {
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
      if (result.error) console.error(`Error:       ${result.error}`);
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

  if (subcommand === "approvals") {
    const approvalCmd = config.positionals[1];
    if (approvalCmd === "list") {
      handleApprovalList(config);
    } else if (approvalCmd === "show") {
      handleApprovalShow(config);
    } else if (approvalCmd === "approve") {
      handleApprovalApprove(config);
    } else if (approvalCmd === "deny") {
      handleApprovalDeny(config);
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
      handleGoalList(config);
    } else if (goalCmd === "remove") {
      await handleGoalRemove(config);
    } else if (goalCmd === "pause") {
      handleGoalSetEnabled(config, false);
    } else if (goalCmd === "resume") {
      handleGoalSetEnabled(config, true);
    } else {
      console.error('Usage: motebit goal [add|list|remove|pause|resume]');
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
    if (validProviders.includes(personalityConfig.default_provider!)) {
      config.provider = personalityConfig.default_provider!;
    }
  }
  if (personalityConfig.default_model && !process.argv.includes("--model")) {
    config.model = personalityConfig.default_model;
  }

  // Create readline early for passphrase prompts
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Resolve passphrase for key encryption
  const envPassphrase = process.env["MOTEBIT_PASSPHRASE"];
  let passphrase: string;

  if (fullConfig.cli_encrypted_key) {
    // Existing encrypted key — need passphrase to decrypt
    passphrase = envPassphrase ?? await promptPassphrase(rl, "Passphrase: ");
    try {
      await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
    } catch {
      console.error("Error: incorrect passphrase.");
      rl.close();
      process.exit(1);
    }
  } else if (fullConfig.cli_private_key) {
    // Migration: plaintext key exists — encrypt it
    console.log("Migrating private key to encrypted storage...");
    passphrase = envPassphrase ?? await promptPassphrase(rl, "Set a passphrase for key encryption: ");
    if (!passphrase) {
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
    passphrase = envPassphrase ?? await promptPassphrase(rl, "Set a passphrase for your mote's key: ");
    if (!passphrase) {
      console.error("Error: passphrase cannot be empty.");
      rl.close();
      process.exit(1);
    }
  }

  // Bootstrap identity — need DB first for identity storage
  const dbPath = getDbPath(config.dbPath);
  const tempDb = createMotebitDatabase(dbPath);
  const { motebitId, isFirstLaunch } = await bootstrapIdentity(tempDb, fullConfig, passphrase);
  tempDb.close();

  if (isFirstLaunch) {
    console.log(`\nYour mote has been created: ${motebitId.slice(0, 8)}...`);
    console.log("Identity and encrypted keypair stored in ~/.motebit/config.json\n");
  }

  // Build tool registry with deferred runtime ref
  const runtimeRef: { current: MotebitRuntime | null } = { current: null };
  const toolRegistry = buildToolRegistry(config, runtimeRef, motebitId);

  // MCP servers from config — overlay trust from trusted list
  const trustedServers = fullConfig.mcp_trusted_servers ?? [];
  const mcpServers = (fullConfig.mcp_servers ?? []).map((s) => ({
    ...s,
    trusted: trustedServers.includes(s.name),
  }));

  // Create runtime with tools, policy, MCP config
  const { runtime, moteDb } = createRuntime(config, motebitId, toolRegistry, mcpServers, personalityConfig);
  runtimeRef.current = runtime;

  // Connect MCP servers
  let mcpAdapters: Awaited<ReturnType<typeof connectMcpServers>> = [];
  if (mcpServers.length > 0) {
    try {
      mcpAdapters = await connectMcpServers(mcpServers, toolRegistry);
      // Re-wire loop deps since registry grew
      runtime.getToolRegistry().merge(toolRegistry);
      console.log(`MCP: connected to ${mcpAdapters.length} server(s)`);
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
  console.log(`Tools: ${toolCount} registered${config.operator ? " (operator mode)" : ""}`);
  console.log("Motebit CLI — type a message, /help for commands, or quit to exit\n");

  const prompt = (): void => {
    rl.question("you> ", (line) => { void handleLine(line); });
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();

    if (trimmed === "quit" || trimmed === "exit") {
      console.log("Goodbye!");
      await shutdown();
      rl.close();
      return;
    }

    if (trimmed === "") { prompt(); return; }

    if (isSlashCommand(trimmed)) {
      const { command, args } = parseSlashCommand(trimmed);
      await handleSlashCommand(command, args, runtime, config, fullConfig);
      console.log();
      prompt();
      return;
    }

    try {
      if (config.noStream) {
        const result = await runtime.sendMessage(trimmed);

        console.log(`\nmote> ${result.response}\n`);

        if (result.memoriesFormed.length > 0) {
          console.log(`  [memories: ${result.memoriesFormed.map((m) => m.content).join(", ")}]`);
        }

        const s = result.stateAfter;
        console.log(`  [state: attention=${s.attention.toFixed(2)} confidence=${s.confidence.toFixed(2)} valence=${s.affect_valence.toFixed(2)} curiosity=${s.curiosity.toFixed(2)}]`);
        const bodyLine = formatBodyAwareness(result.cues);
        if (bodyLine) console.log(`  ${bodyLine}`);
        console.log();
      } else {
        process.stdout.write("\nmote> ");
        await consumeStream(runtime.sendMessageStreaming(trimmed), runtime, rl);
      }
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
