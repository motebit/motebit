// --- CLI argument parsing, help, version, banner ---

import { parseArgs } from "node:util";
import { VERSION } from "./config.js";

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

export function printHelp(): void {
  console.log(
    `
Usage: motebit [command] [options]

Commands:
  id                        Show your identity (motebit_id, did:key, public key)
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

export function printBanner(opts: {
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

export function trimHistory(
  history: { role: "user" | "assistant"; content: string }[],
): { role: "user" | "assistant"; content: string }[] {
  const maxMessages = 40;
  if (history.length > maxMessages) {
    return history.slice(history.length - maxMessages);
  }
  return history;
}
