// --- CLI argument parsing, help, version, banner ---

import { parseArgs } from "node:util";
import { VERSION } from "./config.js";
import { bold, dim, cyan, green, command } from "./colors.js";

/**
 * CLI provider flag union. Flat shape mapped onto the three-mode architecture:
 *   motebit-cloud → "proxy"
 *   byok          → "anthropic" | "openai" | "google"
 *   on-device     → "local-server"  (Ollama, LM Studio, llama.cpp, etc.)
 *
 * `--provider ollama` is accepted as an ergonomic alias for `local-server`
 * and silently normalized at parse time.
 */
export type CliProvider = "anthropic" | "openai" | "google" | "local-server" | "proxy";

export interface CliConfig {
  provider: CliProvider;
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
  capability: string | undefined;
  target: string | undefined;
  budget: string | undefined;
  price: string | undefined;
  plan: boolean;
  sovereign: boolean;
  serveTransport: string | undefined;
  servePort: string | undefined;
  tools: string | undefined;
  selfTest: boolean;
  direct: boolean;
  maxTokens?: number;
  routingStrategy?: "cost" | "quality" | "balanced";
  allowedCommands: string[];
  blockedCommands: string[];
  json: boolean;
  presentation: boolean;
  all?: boolean;
  /** Solana RPC endpoint override for `motebit wallet`. */
  solanaRpcUrl?: string;
  /** Skip the balance query in `motebit wallet` (address-only). */
  walletAddressOnly?: boolean;
  /** Enable TTS voice output at REPL startup. */
  voice?: boolean;
  /** `motebit up`/`init` — yaml file path override. */
  file?: string;
  /** `motebit up` — print the plan without applying. */
  dryRun?: boolean;
  /** `motebit up` — actually delete routines removed from yaml. */
  prune?: boolean;
  /** `motebit init` — overwrite an existing motebit.yaml. */
  force?: boolean;
  /** `motebit logs` — follow mode, polls for new outcomes. */
  tail?: boolean;
  /** `motebit logs` — max number of outcomes to show. */
  limit?: number;
  /** `motebit migrate` — forfeit remaining relay balance instead of withdrawing. */
  waive?: boolean;
  /** `motebit relay up` — HTTP port the relay binds to (default 3000). */
  port?: string;
  /** `motebit relay up` — x402 payout address (enables the x402 settlement rail). */
  payToAddress?: string;
  /** `motebit relay up` — x402 CAIP-2 network id (default eip155:84532 / Base Sepolia). */
  network?: string;
  /** `motebit relay up` — x402 facilitator URL override. */
  facilitatorUrl?: string;
  /** `motebit relay up` — public URL to announce; enables federation. */
  federationUrl?: string;
  /** `motebit relay up` — prompt interactively for the relay key passphrase. */
  passphrase?: boolean;
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
      capability: { type: "string" },
      target: { type: "string" },
      budget: { type: "string" },
      price: { type: "string" },
      plan: { type: "boolean", default: false },
      sovereign: { type: "boolean", default: false },
      "serve-transport": { type: "string" },
      "serve-port": { type: "string" },
      tools: { type: "string" },
      "self-test": { type: "boolean", default: false },
      "max-tokens": { type: "string" },
      "routing-strategy": { type: "string" },
      direct: { type: "boolean", default: false },
      "allow-commands": { type: "string" },
      "block-commands": { type: "string" },
      json: { type: "boolean", default: false },
      presentation: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      "solana-rpc-url": { type: "string" },
      "address-only": { type: "boolean", default: false },
      voice: { type: "boolean", default: false },
      file: { type: "string", short: "f" },
      "dry-run": { type: "boolean", default: false },
      prune: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      tail: { type: "boolean", default: false },
      limit: { type: "string" },
      waive: { type: "boolean", default: false },
      port: { type: "string" },
      "pay-to-address": { type: "string" },
      network: { type: "string" },
      "facilitator-url": { type: "string" },
      "federation-url": { type: "string" },
      passphrase: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  // Accept "ollama" as an ergonomic alias for "local-server" — old muscle
  // memory + the de-facto-standard local inference server. The internal
  // representation is always "local-server" so the rest of the system stays
  // vendor-agnostic.
  //
  // @deprecated since 1.0.0, removed in 2.0.0. Use `--provider local-server` instead.
  //
  // Reason: muscle-memory accommodation for users coming from the pre-1.0
  // Ollama-specific provider name. Vendor-neutral CLI flag aligns with
  // the internal `local-server` representation. The persisted-value
  // migration in `extractPersonality` (config.ts) has a separate
  // lifecycle — it's @permanent and reads legacy `default_provider:
  // "ollama"` entries from every config.json that ever shipped.
  const rawProvider = values.provider === "ollama" ? "local-server" : values.provider;
  const VALID_PROVIDERS: readonly CliProvider[] = [
    "anthropic",
    "openai",
    "google",
    "local-server",
    "proxy",
  ];
  if (!VALID_PROVIDERS.includes(rawProvider as CliProvider)) {
    throw new Error(
      `Unknown provider "${values.provider}". Use one of: ${VALID_PROVIDERS.join(", ")} (or the alias "ollama" for local-server).`,
    );
  }
  const cliProvider = rawProvider as CliProvider;

  const defaultModel =
    cliProvider === "local-server"
      ? "llama3.2"
      : cliProvider === "openai"
        ? "gpt-5.4-mini"
        : cliProvider === "google"
          ? "gemini-2.5-flash"
          : "claude-sonnet-4-6";
  const allowedPaths =
    values["allowed-paths"] != null && values["allowed-paths"] !== ""
      ? values["allowed-paths"].split(",").map((p) => p.trim())
      : [process.cwd()];

  return {
    provider: cliProvider,
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
    capability: values.capability,
    target: values.target,
    budget: values.budget,
    price: values.price,
    plan: values.plan,
    sovereign: values.sovereign,
    serveTransport: values["serve-transport"],
    servePort: values["serve-port"],
    tools: values.tools,
    selfTest: values["self-test"],
    maxTokens: values["max-tokens"] != null ? parseInt(values["max-tokens"], 10) : undefined,
    routingStrategy: parseRoutingStrategy(values["routing-strategy"]),
    direct: values.direct,
    allowedCommands:
      values["allow-commands"] != null && values["allow-commands"] !== ""
        ? values["allow-commands"].split(",").map((s) => s.trim())
        : [],
    blockedCommands:
      values["block-commands"] != null && values["block-commands"] !== ""
        ? values["block-commands"].split(",").map((s) => s.trim())
        : [],
    json: values.json,
    presentation: values.presentation,
    all: values.all,
    solanaRpcUrl: values["solana-rpc-url"],
    walletAddressOnly: values["address-only"],
    voice: values.voice,
    file: values.file,
    dryRun: values["dry-run"],
    prune: values.prune,
    force: values.force,
    tail: values.tail,
    limit: values.limit != null ? parseInt(values.limit, 10) : undefined,
    waive: values.waive,
    port: values.port,
    payToAddress: values["pay-to-address"],
    network: values.network,
    facilitatorUrl: values["facilitator-url"],
    federationUrl: values["federation-url"],
    passphrase: values.passphrase,
    version: values.version,
    help: values.help,
    positionals,
  };
}

function parseRoutingStrategy(
  value: string | undefined,
): "cost" | "quality" | "balanced" | undefined {
  if (value == null || value === "") return undefined;
  if (value === "cost" || value === "quality" || value === "balanced") return value;
  throw new Error(`Unknown routing strategy "${value}". Use "cost", "quality", or "balanced".`);
}

/** Command metadata — single source of truth for REPL /help and CLI --help. */
export interface CommandEntry {
  /** Usage pattern, e.g. "/goal add \"<prompt>\" --every <interval>" */
  usage: string;
  /** Short description */
  desc: string;
}

/**
 * Slash command registry. Order here = order in help output.
 * Adding a command? Add an entry here — both /help and --help self-generate.
 */
export const COMMANDS: CommandEntry[] = [
  { usage: "/help", desc: "Show this help" },
  { usage: "/memories", desc: "List all memories" },
  { usage: "/graph", desc: "Memory graph stats — compounding health" },
  { usage: "/curious", desc: "Show decaying memories the agent is curious about" },
  { usage: "/state", desc: "Show current state vector" },
  { usage: "/forget <nodeId>", desc: "Delete a memory by ID" },
  { usage: "/export", desc: "Export all memories and state as JSON" },
  { usage: "/clear", desc: "Clear conversation history" },
  { usage: "/summarize", desc: "Summarize current conversation" },
  { usage: "/conversations", desc: "List recent conversations" },
  { usage: "/conversation <id>", desc: "Load a past conversation" },
  { usage: "/model <name>", desc: "Switch AI model (persists across sessions)" },
  { usage: "/connect <url>", desc: "Connect to a relay" },
  { usage: "/serve [port]", desc: "Start MCP server — accept delegations" },
  { usage: "/sync", desc: "Sync events and conversations" },
  { usage: "/tools", desc: "List registered tools" },
  { usage: "/goals", desc: "List all scheduled goals" },
  { usage: '/goal add "<prompt>" --every <interval>', desc: "Add a scheduled goal" },
  { usage: "/goal remove <id>", desc: "Remove a goal" },
  { usage: "/goal pause <id>", desc: "Pause a goal" },
  { usage: "/goal resume <id>", desc: "Resume a paused goal" },
  { usage: "/goal outcomes <id>", desc: "Show execution history" },
  { usage: "/approvals", desc: "Show pending approval queue" },
  { usage: "/balance", desc: "Show balance and transactions" },
  { usage: "/withdraw <amount>", desc: "Request a withdrawal" },
  { usage: "/deposits", desc: "Show recent deposit transactions" },
  { usage: "/reflect", desc: "Trigger reflection — see what the agent learned" },
  { usage: "/audit", desc: "Audit memory integrity — phantom certainties, conflicts" },
  { usage: "/mcp list", desc: "List MCP servers and trust status" },
  { usage: "/mcp add <name> <url>", desc: "Add an HTTP MCP server" },
  { usage: "/mcp remove <name>", desc: "Remove an MCP server" },
  { usage: "/mcp trust <name>", desc: "Trust an MCP server" },
  { usage: "/mcp untrust <name>", desc: "Untrust an MCP server" },
  { usage: "/agents", desc: "List agents with trust and reputation" },
  { usage: "/agents info <id>", desc: "Full trust record detail" },
  { usage: "/agents trust <id> <level>", desc: "Set trust level" },
  { usage: "/agents block <id>", desc: "Shorthand for Blocked" },
  { usage: "/discover [cap]", desc: "Discover agents on the relay" },
  { usage: "/delegate <id> <prompt>", desc: "Delegate a task via relay" },
  { usage: "/propose <ids> <goal>", desc: "Propose a collaborative plan" },
  { usage: "/proposals", desc: "List active proposals" },
  { usage: "/proposal <id> [accept|reject|counter]", desc: "Respond to a proposal" },
  { usage: "/operator", desc: "Show operator mode status" },
  { usage: "/invoke <cap> <prompt>", desc: "Invoke a capability deterministically (no AI loop)" },
  { usage: "/receipt <task-id>", desc: "Re-render an archived receipt (offline-verified)" },
  { usage: "/voice [on|off]", desc: "Toggle TTS voice output (opt-in, off by default)" },
  { usage: "/say <text>", desc: "Speak text via TTS (requires voice provider)" },
];

export function printHelp(): void {
  const col = Math.max(...COMMANDS.map((c) => c.usage.length)) + 2;
  console.log(
    `
Usage: motebit [command] [options]

First run:
  motebit                   Interactive setup — creates a new Ed25519 identity
                            (encrypted with a passphrase you choose) and drops
                            you into a REPL. Same command from then on opens
                            the REPL against your existing identity.

Commands:
  id                        Show your identity (motebit_id, did:key, public key)
  wallet                    Show your sovereign Solana wallet (address, USDC balance)
    --solana-rpc-url <url>    Solana RPC endpoint (default: mainnet-beta public RPC)
    --address-only            Skip the balance query (address-only)
  doctor                    Check system readiness (Node, SQLite, config)
  export [--output <dir>]   Export identity bundle (motebit.md, credentials, budget, gradient)
    --all                   Include sensitive memories (medical/financial/secret) in export
  verify <path>             Verify a motebit.md identity file signature
  verify <kind> <path>      Verify a wire-format artifact against the
                            published @motebit/wire-schemas contract.
                            Kinds: receipt | token | listing | identity.
                            Validates schema + suite + Ed25519 signature
                            (+ time window for tokens). [--json]
  register [--sync-url <url>]  Register this identity with the relay (enables discovery)
  rotate [--reason "..."]   Rotate Ed25519 keypair with cryptographic succession chain
  migrate-keyring [--force] Re-encrypt a plaintext ~/.motebit/dev-keyring.json
                            under a passphrase (recovery path when
                            cli_encrypted_key was lost from config but
                            the private key remains on disk)
  run [--identity <path>]   Start daemon mode (uses exported motebit.md)
    --price <amount>          Set per-task price in USD (enables earning from delegated tasks)
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
  lsp                       Start the motebit.yaml Language Server over stdio
                            (LSP-speaking editors — VS Code, Cursor, Vim/
                            Neovim, JetBrains — get diagnostics, hover, and
                            completion for motebit.yaml)
  schema                    Print the motebit.yaml JSON Schema to stdout
                            (vendor into your project for IDE validation
                            without fetching from GitHub)
  ledger <goal_id>          Show execution ledger for a goal [--json]
  credentials               List credentials from relay [--presentation]
  balance                   Show virtual account balance and recent transactions
  fund <amount>             Deposit via Stripe Checkout (opens browser)
  delegate "<prompt>"       Delegate a task to a worker agent
    --capability <cap>        Required capability (default: web_search)
    --target <id>             Skip discovery, delegate to specific agent
    --budget <amount>         Max spend in USD (default: from listing price)
    --plan                    Decompose into multi-step plan, delegate each to specialists
    --sovereign               Pay agents directly via Solana wallet (no relay settlement)
  withdraw <amount> [--destination <addr>]  Request a withdrawal
  approvals list            List approval queue items
  approvals show <id>       Show approval detail
  approvals approve <id>    Approve a pending tool call
  approvals deny <id> [--reason <text>]  Deny a pending tool call
  federation status           Show relay identity (motebit_id, DID, public key)
  federation peers            List active federation peers
  federation peer <url>       Peer with another relay (mutual handshake)
  relay up                    Start a local sync relay (your own, on your machine)
    --port <n>                  HTTP port (default: 3000)
    --db-path <path>            SQLite path (default: ~/.motebit/relay/relay.db)
    --pay-to-address <addr>     x402 payout address — enables paid task settlement
    --network <caip2>           x402 network (default: eip155:84532, Base Sepolia)
    --facilitator-url <url>     x402 facilitator override
    --federation-url <url>      Public URL for this relay — enables federation (default: off)
    --passphrase                Prompt for relay key encryption passphrase
                                (or set MOTEBIT_RELAY_KEY_PASSPHRASE)

Options:
  --provider <name>       AI provider (default: anthropic)
  --model <model>         AI model to use (default depends on provider)
  --routing-strategy <s>  Agent delegation routing: "cost", "quality", or "balanced"
  --db-path <path>        Database file path (default: ~/.motebit/motebit.db)
  --no-stream             Disable streaming (use blocking mode)
  --sync-url <url>        Remote sync server URL (or set MOTEBIT_SYNC_URL)
  --sync-token <tok>      Auth token for sync server (or set MOTEBIT_SYNC_TOKEN)
  --once                  Create a one-shot goal (runs once then completes)
  --wall-clock <duration> Max wall-clock time per goal run (e.g. '30m', '1h'). Default: 10m
  --project <id>          Project ID for grouping related goals (shared context)
  --operator              Enable operator mode (write/exec tools)
  --allowed-paths <paths> Comma-separated allowed file paths (default: cwd)
  --allow-commands <cmds> Comma-separated shell commands to allow (e.g. node,npm,git)
  --block-commands <cmds> Comma-separated shell commands to always block (e.g. rm,mkfs)
  -v, --version           Print version and exit
  -h, --help              Print this help and exit

Providers:
  anthropic               Uses Anthropic API (requires ANTHROPIC_API_KEY)
                          Default model: claude-sonnet-4-6
  openai                  Uses OpenAI API (requires OPENAI_API_KEY)
                          Default model: gpt-5.4-mini
  google                  Uses Google API (requires GOOGLE_API_KEY)
                          Default model: gemini-2.5-flash
  local-server            Uses a local inference server — Ollama, LM Studio,
                          llama.cpp, Jan, vLLM, or any OpenAI-compatible
                          endpoint (no API key needed). Default model: llama3.2.
                          Alias: --provider ollama
  proxy                   Motebit Cloud (subscription via the relay)

Routing strategies (--routing-strategy):
  cost                    Cheapest agent first (cost-primary lexicographic)
  quality                 Most trusted agent first (trust-primary lexicographic)
  balanced                Weighted sum: trust, cost, latency, reliability, risk (default)

Slash commands (in REPL):`,
  );
  for (const { usage, desc } of COMMANDS) {
    const gap = " ".repeat(Math.max(1, col - usage.length));
    console.log(`  ${usage}${gap}${desc}`);
  }
  console.log("  quit, exit         Exit the REPL");
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
  const W = 56;
  const pad = (s: string, visibleLen: number) => s + " ".repeat(Math.max(0, W - visibleLen));
  const padPlain = (s: string) => s + " ".repeat(Math.max(0, W - s.length));
  const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "\u2026" : s);
  const id = opts.motebitId.slice(0, 8);
  const maxInfo = Math.max(10, W - 24); // 24 = creature art width
  const model = opts.model.replace(/^claude-/, "");
  const providerInfo = clip(`${opts.provider} \u00b7 ${model}`, maxInfo);
  const toolGoalPlain = `${opts.toolCount} tools \u00b7 ${opts.goalCount} goals`;
  const op = opts.operator ? " \u00b7 operator" : "";
  const toolGoalClipped = clip(toolGoalPlain + op, maxInfo);
  const headerPlain = `\u2500 motebit v${VERSION} `;
  const headerPad = "\u2500".repeat(Math.max(0, W - headerPlain.length));
  const header = `\u2500 ${bold("motebit")}${dim(" v" + VERSION)} `;

  const b = dim; // border shorthand
  console.log(`  ${b("\u256d")}${header}${b(headerPad)}${b("\u256e")}`);
  console.log(`  ${b("\u2502")}${padPlain("")}${b("\u2502")}`);
  console.log(`  ${b("\u2502")}${padPlain("          .")}${b("\u2502")}`);
  console.log(
    `  ${b("\u2502")}${pad(`        .:::.          ${cyan(id)}`, `        .:::.          ${id}`.length)}${b("\u2502")}`,
  );
  console.log(
    `  ${b("\u2502")}${padPlain(`       .:::::.         ${providerInfo}`)}${b("\u2502")}`,
  );
  console.log(
    `  ${b("\u2502")}${pad(`       :::::::         ${green(toolGoalClipped)}`, `       :::::::         ${toolGoalClipped}`.length)}${b("\u2502")}`,
  );
  console.log(`  ${b("\u2502")}${padPlain("       ':::::'")}` + b("\u2502"));
  console.log(`  ${b("\u2502")}${padPlain("         '''")}${b("\u2502")}`);
  console.log(`  ${b("\u2502")}${padPlain("")}${b("\u2502")}`);
  const helpPlain = "   /help for commands \u00b7 /goals to manage";
  const helpStyled = `   ${command("/help")}${dim(" for commands \u00b7 ")}${command("/goals")}${dim(" to manage")}`;
  console.log(`  ${b("\u2502")}${pad(helpStyled, helpPlain.length)}${b("\u2502")}`);
  console.log(`  ${b("\u2570")}${b("\u2500".repeat(W))}${b("\u256f")}`);
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
