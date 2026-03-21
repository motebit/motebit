// --- CLI argument parsing, help, version, banner ---

import { parseArgs } from "node:util";
import { VERSION } from "./config.js";

export interface CliConfig {
  provider: "anthropic" | "openai" | "ollama";
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
  destination: string | undefined;
  serveTransport: string | undefined;
  servePort: string | undefined;
  tools: string | undefined;
  selfTest: boolean;
  direct: boolean;
  maxTokens?: number;
  json: boolean;
  presentation: boolean;
  all?: boolean;
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
      destination: { type: "string" },
      "serve-transport": { type: "string" },
      "serve-port": { type: "string" },
      tools: { type: "string" },
      "self-test": { type: "boolean", default: false },
      "max-tokens": { type: "string" },
      direct: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      presentation: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const provider = values.provider;
  if (provider !== "anthropic" && provider !== "openai" && provider !== "ollama") {
    throw new Error(`Unknown provider "${provider}". Use "anthropic", "openai", or "ollama".`);
  }

  const defaultModel =
    provider === "ollama"
      ? "llama3.2"
      : provider === "openai"
        ? "gpt-4o"
        : "claude-sonnet-4-5-20250929";
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
    destination: values.destination,
    serveTransport: values["serve-transport"],
    servePort: values["serve-port"],
    tools: values.tools,
    selfTest: values["self-test"],
    maxTokens: values["max-tokens"] != null ? parseInt(values["max-tokens"], 10) : undefined,
    direct: values.direct,
    json: values.json,
    presentation: values.presentation,
    all: values.all,
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
  export [--output <dir>]   Export identity bundle (motebit.md, credentials, budget, gradient)
    --all                   Include sensitive memories (medical/financial/secret) in export
  verify <path>             Verify a motebit.md identity file signature
  register [--sync-url <url>]  Register this identity with the relay (enables discovery)
  rotate [--reason "..."]   Rotate Ed25519 keypair with cryptographic succession chain
  run [--identity <path>]   Start daemon mode (uses exported motebit.md)
  serve [--identity <path>] Start as MCP server (stdio by default)
    --serve-transport <mode>  Transport: "stdio" (default) or "http"
    --serve-port <port>       HTTP port (default: 3100)
    --tools <path>            JS module exporting tool definitions (array of {definition, handler})
    --direct                  Direct tool execution (no AI loop)
    --self-test               Run self-test after relay registration
  goal add "<prompt>" --every <interval> [--once] [--wall-clock <duration>] [--project <id>]
                            Add a scheduled goal
  goal list                 List all scheduled goals with status
  goal outcomes <goal_id>   Show execution history for a goal
  goal remove <goal_id>     Remove a scheduled goal
  goal pause <goal_id>      Pause a scheduled goal
  goal resume <goal_id>     Resume a paused goal
  ledger <goal_id>          Show execution ledger for a goal [--json]
  credentials               List credentials from relay [--presentation]
  balance                   Show virtual account balance and recent transactions
  withdraw <amount> [--destination <addr>]  Request a withdrawal
  approvals list            List approval queue items
  approvals show <id>       Show approval detail
  approvals approve <id>    Approve a pending tool call
  approvals deny <id> [--reason <text>]  Deny a pending tool call

Options:
  --provider <name>       AI provider: "anthropic", "openai", or "ollama" (default: anthropic)
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
                          Default model: claude-sonnet-4-5-20250929
  openai                  Uses OpenAI API (requires OPENAI_API_KEY)
                          Default model: gpt-4o
  ollama                  Uses local Ollama server (no API key needed)
                          Default model: llama3.2

Slash commands (in REPL):
  /help              Show available commands
  /memories          List all memories (with decay indicators)
  /graph             Memory graph stats — compounding health
  /curious           Show decaying memories the agent is curious about
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
  /balance           Show virtual account balance and recent transactions
  /withdraw <amount> [destination]  Request a withdrawal
  /deposits          Show recent deposit transactions
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

/** Terminal inner width, clamped to [40, 120]. Accounts for box border padding. */
export function termWidth(): number {
  const cols = process.stdout.columns ?? 80;
  return Math.max(40, Math.min(cols - 4, 120)); // -4 for "  ╭" + "╮"
}

export function printBanner(opts: {
  motebitId: string;
  provider: string;
  model: string;
  toolCount: number;
  goalCount: number;
  operator: boolean;
}): void {
  const W = termWidth();
  const pad = (s: string) => s + " ".repeat(Math.max(0, W - s.length));
  const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "\u2026" : s);
  const id = opts.motebitId.slice(0, 8);
  const maxInfo = Math.max(10, W - 24); // 24 = creature art width
  const model = opts.model.replace(/^claude-/, "");
  const providerInfo = clip(`${opts.provider} \u00b7 ${model}`, maxInfo);
  const toolGoal = `${opts.toolCount} tools \u00b7 ${opts.goalCount} goals`;
  const op = opts.operator ? " \u00b7 operator" : "";
  const header = `\u2500 motebit v${VERSION} `;
  const headerPad = "\u2500".repeat(Math.max(0, W - header.length));

  console.log(`  \u256d${header}${headerPad}\u256e`);
  console.log(`  \u2502${pad("")}\u2502`);
  console.log(`  \u2502${pad("          .")}\u2502`);
  console.log(`  \u2502${pad(`        .:::.          ${id}`)}\u2502`);
  console.log(`  \u2502${pad(`       .:::::.         ${providerInfo}`)}\u2502`);
  console.log(`  \u2502${pad(`       :::::::         ${clip(toolGoal + op, maxInfo)}`)}\u2502`);
  console.log(`  \u2502${pad("       ':::::'")}\u2502`);
  console.log(`  \u2502${pad("         '''")}\u2502`);
  console.log(`  \u2502${pad("")}\u2502`);
  console.log(`  \u2502${pad("   /help for commands \u00b7 /goals to manage")}\u2502`);
  console.log(`  \u2570${"\u2500".repeat(W)}\u256f`);
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
