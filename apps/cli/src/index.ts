#!/usr/bin/env node

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseArgs } from "node:util";
import { CloudProvider, runTurn, runTurnStreaming } from "@motebit/ai-core";
import type { MotebitLoopDependencies } from "@motebit/ai-core";
import { EventStore } from "@motebit/event-log";
import { MemoryGraph } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { createMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";

// --- Constants ---

const MOTEBIT_ID = "motebit-cli";
const MAX_HISTORY_EXCHANGES = 20;
const VERSION = "0.1.0";

// --- Arg Parsing ---

export interface CliConfig {
  model: string;
  dbPath: string | undefined;
  noStream: boolean;
  version: boolean;
  help: boolean;
}

export function parseCliArgs(args: string[] = process.argv.slice(2)): CliConfig {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: "string", default: "claude-sonnet-4-5-20250514" },
      "db-path": { type: "string" },
      "no-stream": { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  return {
    model: values.model as string,
    dbPath: values["db-path"] as string | undefined,
    noStream: values["no-stream"] as boolean,
    version: values.version as boolean,
    help: values.help as boolean,
  };
}

// --- Help / Version ---

export function printHelp(): void {
  console.log(`
Usage: motebit [options]

Options:
  --model <model>    AI model to use (default: claude-sonnet-4-5-20250514)
  --db-path <path>   Database file path (default: ~/.motebit/motebit.db)
  --no-stream        Disable streaming (use blocking mode)
  -v, --version      Print version and exit
  -h, --help         Print this help and exit

Slash commands (in REPL):
  /help              Show available commands
  /memories          List all memories
  /state             Show current state vector
  /forget <nodeId>   Delete a memory by ID
  /export            Export all memories and state as JSON
  /clear             Clear conversation history
  /model <name>      Switch AI model mid-session
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
  memoryGraph: MemoryGraph;
  cloudProvider: CloudProvider;
}

function createDependencies(apiKey: string, config: CliConfig): CliDeps {
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
  const cloudProvider = new CloudProvider({
    provider: "anthropic",
    api_key: apiKey,
    model: config.model,
    max_tokens: 1024,
    temperature: 0.7,
  });

  console.log(`Data: ${dbPath}`);

  return {
    loopDeps: {
      motebitId: MOTEBIT_ID,
      eventStore,
      memoryGraph,
      stateEngine,
      behaviorEngine,
      cloudProvider,
    },
    moteDb,
    stateEngine,
    memoryGraph,
    cloudProvider,
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
        console.log(`Current model: ${deps.cloudProvider.model}`);
        break;
      }
      deps.cloudProvider.setModel(args);
      console.log(`Model switched to: ${args}`);
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

  const apiKey = getApiKey();
  const deps = createDependencies(apiKey, config);
  const history: { role: "user" | "assistant"; content: string }[] = [];

  const shutdown = (): void => {
    deps.moteDb.stateSnapshot.saveState(MOTEBIT_ID, deps.stateEngine.serialize());
    deps.moteDb.close();
  };

  process.on("SIGINT", () => {
    console.log("\nGoodbye!");
    shutdown();
    process.exit(0);
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
      shutdown();
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
        });

        console.log(`\nmote> ${result.response}\n`);

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
        console.log();
      } else {
        // Streaming mode
        process.stdout.write("\nmote> ");
        let responseText = "";

        for await (const chunk of runTurnStreaming(deps.loopDeps, trimmed, {
          conversationHistory: history.length > 0 ? history : undefined,
        })) {
          if (chunk.type === "text") {
            process.stdout.write(chunk.text);
            responseText += chunk.text;
          } else {
            const result = chunk.result;
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
