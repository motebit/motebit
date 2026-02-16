#!/usr/bin/env node

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseArgs } from "node:util";
import { CloudProvider, OllamaProvider, runTurn, runTurnStreaming, loadConfig, formatBodyAwareness } from "@motebit/ai-core";
import type { MotebitLoopDependencies, StreamingProvider, MotebitPersonalityConfig } from "@motebit/ai-core";
import type { BehaviorCues } from "@motebit/sdk";
import { EventStore } from "@motebit/event-log";
import { MemoryGraph } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { createMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import { SyncEngine, HttpEventStoreAdapter } from "@motebit/sync-engine";

// --- Constants ---

const MOTEBIT_ID = "motebit-cli";
const MAX_HISTORY_EXCHANGES = 20;
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
  // Strip leading "--" that pnpm injects when using `pnpm start -- --flag`
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

  const provider = values.provider as string;
  if (provider !== "anthropic" && provider !== "ollama") {
    throw new Error(`Unknown provider "${provider}". Use "anthropic" or "ollama".`);
  }

  const defaultModel = provider === "ollama" ? "llama3.2" : "claude-sonnet-4-5-20250514";

  return {
    provider,
    model: (values.model as string | undefined) ?? defaultModel,
    dbPath: values["db-path"] as string | undefined,
    noStream: values["no-stream"] as boolean,
    syncUrl: values["sync-url"] as string | undefined,
    syncToken: values["sync-token"] as string | undefined,
    version: values.version as boolean,
    help: values.help as boolean,
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
  const maxMessages = MAX_HISTORY_EXCHANGES * 2;
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

// --- Bootstrap Dependencies ---

interface CliDeps {
  loopDeps: MotebitLoopDependencies;
  moteDb: MotebitDatabase;
  stateEngine: StateVectorEngine;
  behaviorEngine: BehaviorEngine;
  memoryGraph: MemoryGraph;
  provider: StreamingProvider;
  syncEngine: SyncEngine | null;
}

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

function createDependencies(config: CliConfig, personalityConfig?: MotebitPersonalityConfig): CliDeps {
  const dbPath = getDbPath(config.dbPath);
  const moteDb = createMotebitDatabase(dbPath);

  const eventStore = new EventStore(moteDb.eventStore);
  const memoryGraph = new MemoryGraph(moteDb.memoryStorage, eventStore, MOTEBIT_ID);
  const stateEngine = new StateVectorEngine();

  const savedState = moteDb.stateSnapshot.loadState(MOTEBIT_ID);
  if (savedState) {
    stateEngine.deserialize(savedState);
  }

  const behaviorEngine = new BehaviorEngine();
  const provider = createProvider(config, personalityConfig);

  console.log(`Data: ${dbPath}`);
  console.log(`Provider: ${config.provider} (${provider.model})`);

  let syncEngine: SyncEngine | null = null;
  const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
  const syncToken = config.syncToken ?? process.env["MOTEBIT_SYNC_TOKEN"];

  if (syncUrl) {
    syncEngine = new SyncEngine(moteDb.eventStore, MOTEBIT_ID);
    const remoteStore = new HttpEventStoreAdapter({
      baseUrl: syncUrl,
      motebitId: MOTEBIT_ID,
      authToken: syncToken,
    });
    syncEngine.connectRemote(remoteStore);
    console.log(`Sync: ${syncUrl}`);
  } else {
    console.log("Sync: disabled (set MOTEBIT_SYNC_URL to enable)");
  }

  return {
    loopDeps: {
      motebitId: MOTEBIT_ID,
      eventStore,
      memoryGraph,
      stateEngine,
      behaviorEngine,
      provider,
    },
    moteDb,
    stateEngine,
    behaviorEngine,
    memoryGraph,
    provider,
    syncEngine,
  };
}

// --- Slash Command Handlers ---

async function handleSlashCommand(
  cmd: string,
  args: string,
  deps: CliDeps,
  history: { role: "user" | "assistant"; content: string }[],
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
      const data = await deps.memoryGraph.exportAll();
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
      const state = deps.stateEngine.getState();
      console.log("\nState vector:\n" + formatState(state as unknown as Record<string, unknown>));
      break;
    }

    case "forget": {
      if (!args) {
        console.log("Usage: /forget <nodeId>");
        break;
      }
      try {
        await deps.memoryGraph.deleteMemory(args);
        console.log(`Deleted memory: ${args}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to delete memory: ${message}`);
      }
      break;
    }

    case "export": {
      const memories = await deps.memoryGraph.exportAll();
      const state = deps.stateEngine.getState();
      const exportData = { memories, state };
      console.log(JSON.stringify(exportData, null, 2));
      break;
    }

    case "clear":
      history.length = 0;
      console.log("Conversation history cleared.");
      break;

    case "model": {
      if (!args) {
        console.log(`Current model: ${deps.provider.model}`);
        break;
      }
      deps.provider.setModel(args);
      console.log(`Model switched to: ${args}`);
      break;
    }

    case "sync": {
      if (!deps.syncEngine) {
        console.log("Sync is disabled. Set MOTEBIT_SYNC_URL to enable.");
        break;
      }
      try {
        console.log("Syncing...");
        const result = await deps.syncEngine.sync();
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

  if (config.help) {
    printHelp();
    return;
  }

  if (config.version) {
    printVersion();
    return;
  }

  // Load personality config from ~/.motebit/config.json
  const personalityConfig = loadConfig();

  // Apply config defaults when CLI flags weren't explicit
  if (personalityConfig.default_provider && !process.argv.includes("--provider")) {
    const validProviders = ["anthropic", "ollama"] as const;
    if (validProviders.includes(personalityConfig.default_provider as typeof validProviders[number])) {
      config.provider = personalityConfig.default_provider as "anthropic" | "ollama";
    }
  }
  if (personalityConfig.default_model && !process.argv.includes("--model")) {
    config.model = personalityConfig.default_model;
  }

  const deps = createDependencies(config, personalityConfig);

  if (deps.syncEngine) {
    try {
      console.log("Syncing...");
      const result = await deps.syncEngine.sync();
      console.log(`Synced: pulled ${result.pulled} events, pushed ${result.pushed} events`);
      if (result.conflicts.length > 0) {
        console.log(`  [${result.conflicts.length} conflicts detected]`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Sync failed (continuing offline): ${message}`);
    }
  }

  const history: { role: "user" | "assistant"; content: string }[] = [];
  let lastCues: BehaviorCues = deps.behaviorEngine.compute(deps.stateEngine.getState());

  const shutdown = async (): Promise<void> => {
    deps.moteDb.stateSnapshot.saveState(MOTEBIT_ID, deps.stateEngine.serialize());
    if (deps.syncEngine) {
      try {
        const result = await deps.syncEngine.sync();
        console.log(`Synced on exit: pushed ${result.pushed}, pulled ${result.pulled}`);
      } catch {
        console.warn("Sync on exit failed (changes saved locally)");
      }
    }
    deps.moteDb.close();
  };

  process.on("SIGINT", () => {
    console.log("\nGoodbye!");
    void shutdown().then(() => process.exit(0));
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Motebit CLI — type a message, /help for commands, or quit to exit\n");

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
      await handleSlashCommand(command, args, deps, history);
      console.log();
      prompt();
      return;
    }

    try {
      if (config.noStream) {
        // Blocking mode
        const result = await runTurn(deps.loopDeps, trimmed, {
          conversationHistory: history.length > 0 ? history : undefined,
          previousCues: lastCues,
        });

        console.log(`\nmote> ${result.response}\n`);
        lastCues = result.cues;

        history.push({ role: "user", content: trimmed });
        history.push({ role: "assistant", content: result.response });
        const trimmedHistory = trimHistory(history);
        history.length = 0;
        history.push(...trimmedHistory);

        if (result.memoriesFormed.length > 0) {
          console.log(
            `  [memories: ${result.memoriesFormed.map((m) => m.content).join(", ")}]`,
          );
        }

        const s = result.stateAfter;
        console.log(
          `  [state: attention=${s.attention.toFixed(2)} confidence=${s.confidence.toFixed(2)} valence=${s.affect_valence.toFixed(2)} curiosity=${s.curiosity.toFixed(2)}]`,
        );
        const bodyLine = formatBodyAwareness(result.cues);
        if (bodyLine) {
          console.log(`  ${bodyLine}`);
        }
        console.log();
      } else {
        // Streaming mode
        process.stdout.write("\nmote> ");
        let responseText = "";

        for await (const chunk of runTurnStreaming(deps.loopDeps, trimmed, {
          conversationHistory: history.length > 0 ? history : undefined,
          previousCues: lastCues,
        })) {
          if (chunk.type === "text") {
            process.stdout.write(chunk.text);
            responseText += chunk.text;
          } else {
            const result = chunk.result;
            lastCues = result.cues;
            console.log("\n");

            // Use streamed text for history (stripped of tags)
            history.push({ role: "user", content: trimmed });
            history.push({ role: "assistant", content: result.response });
            const trimmedHistory = trimHistory(history);
            history.length = 0;
            history.push(...trimmedHistory);

            if (result.memoriesFormed.length > 0) {
              console.log(
                `  [memories: ${result.memoriesFormed.map((m) => m.content).join(", ")}]`,
              );
            }

            const s = result.stateAfter;
            console.log(
              `  [state: attention=${s.attention.toFixed(2)} confidence=${s.confidence.toFixed(2)} valence=${s.affect_valence.toFixed(2)} curiosity=${s.curiosity.toFixed(2)}]`,
            );
            const bodyLine = formatBodyAwareness(result.cues);
            if (bodyLine) {
              console.log(`  ${bodyLine}`);
            }
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

// Only run when executed directly, not when imported for testing
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
