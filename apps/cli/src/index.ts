#!/usr/bin/env node

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseArgs } from "node:util";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import type { StorageAdapters } from "@motebit/runtime";
import { CloudProvider, OllamaProvider, loadConfig, formatBodyAwareness } from "@motebit/ai-core";
import type { StreamingProvider, MotebitPersonalityConfig } from "@motebit/ai-core";
import { createMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import { HttpEventStoreAdapter } from "@motebit/sync-engine";

// --- Constants ---

const MOTEBIT_ID = "motebit-cli";
const VERSION = "0.1.0";

// --- Arg Parsing ---

export interface CliConfig {
  provider: "anthropic" | "ollama";
  model: string;
  dbPath: string | undefined;
  noStream: boolean;
  syncUrl: string | undefined;
  syncToken: string | undefined;
  version: boolean;
  help: boolean;
}

export function parseCliArgs(args: string[] = process.argv.slice(2)): CliConfig {
  const cleanArgs = args[0] === "--" ? args.slice(1) : args;
  const { values } = parseArgs({
    args: cleanArgs,
    options: {
      provider: { type: "string", default: "anthropic" },
      model: { type: "string" },
      "db-path": { type: "string" },
      "no-stream": { type: "boolean", default: false },
      "sync-url": { type: "string" },
      "sync-token": { type: "string" },
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

  return {
    provider,
    model: values.model ?? defaultModel,
    dbPath: values["db-path"],
    noStream: values["no-stream"],
    syncUrl: values["sync-url"],
    syncToken: values["sync-token"],
    version: values.version,
    help: values.help,
  };
}

// --- Help / Version ---

export function printHelp(): void {
  console.log(`
Usage: motebit [options]

Options:
  --provider <name>  AI provider: "anthropic" or "ollama" (default: anthropic)
  --model <model>    AI model to use (default depends on provider)
  --db-path <path>   Database file path (default: ~/.motebit/motebit.db)
  --no-stream        Disable streaming (use blocking mode)
  --sync-url <url>   Remote sync server URL (or set MOTEBIT_SYNC_URL)
  --sync-token <tok> Auth token for sync server (or set MOTEBIT_SYNC_TOKEN)
  -v, --version      Print version and exit
  -h, --help         Print this help and exit

Providers:
  anthropic          Uses Anthropic API (requires ANTHROPIC_API_KEY)
                     Default model: claude-sonnet-4-5-20250514
  ollama             Uses local Ollama server (no API key needed)
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
  const dir = path.join(os.homedir(), ".motebit");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "motebit.db");
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

// --- Bootstrap ---

function createRuntime(config: CliConfig, personalityConfig?: MotebitPersonalityConfig): { runtime: MotebitRuntime; moteDb: MotebitDatabase } {
  const dbPath = getDbPath(config.dbPath);
  const moteDb = createMotebitDatabase(dbPath);
  const provider = createProvider(config, personalityConfig);

  console.log(`Data: ${dbPath}`);
  console.log(`Provider: ${config.provider} (${provider.model})`);

  const storage: StorageAdapters = {
    eventStore: moteDb.eventStore,
    memoryStorage: moteDb.memoryStorage,
    identityStorage: moteDb.identityStorage,
    auditLog: moteDb.auditLog,
    stateSnapshot: moteDb.stateSnapshot,
  };

  const runtime = new MotebitRuntime(
    { motebitId: MOTEBIT_ID },
    { storage, renderer: new NullRenderer(), ai: provider },
  );

  // Wire sync if configured
  const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
  const syncToken = config.syncToken ?? process.env["MOTEBIT_SYNC_TOKEN"];

  if (syncUrl) {
    const remoteStore = new HttpEventStoreAdapter({
      baseUrl: syncUrl,
      motebitId: MOTEBIT_ID,
      authToken: syncToken,
    });
    runtime.connectSync(remoteStore);
    console.log(`Sync: ${syncUrl}`);
  } else {
    console.log("Sync: disabled (set MOTEBIT_SYNC_URL to enable)");
  }

  return { runtime, moteDb };
}

// --- Slash Command Handlers ---

async function handleSlashCommand(
  cmd: string,
  args: string,
  runtime: MotebitRuntime,
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

    default:
      console.log(`Unknown command: /${cmd}. Type /help for available commands.`);
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

  const personalityConfig = loadConfig();

  if (personalityConfig.default_provider && !process.argv.includes("--provider")) {
    const validProviders = ["anthropic", "ollama"] as const;
    if (validProviders.includes(personalityConfig.default_provider)) {
      config.provider = personalityConfig.default_provider;
    }
  }
  if (personalityConfig.default_model && !process.argv.includes("--model")) {
    config.model = personalityConfig.default_model;
  }

  const { runtime, moteDb } = createRuntime(config, personalityConfig);

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

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

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
      await handleSlashCommand(command, args, runtime);
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

        for await (const chunk of runtime.sendMessageStreaming(trimmed)) {
          if (chunk.type === "text") {
            process.stdout.write(chunk.text);
          } else if (chunk.type === "result") {
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
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  [error: ${message}]\n`);
    }

    prompt();
  };

  prompt();
}

const isMainModule =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url === `file://${process.argv[1].replace(/\.js$/, ".ts")}`);

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
