/**
 * Slash command definitions and parsing for the desktop chat input.
 *
 * Pure data + parsing logic — no DOM dependencies. This module is testable
 * independently of the browser environment.
 */

export interface SlashCommandDef {
  /** The command name (without leading slash). */
  name: string;
  /** Short description shown in autocomplete and /help. */
  description: string;
  /** Whether this command accepts arguments. */
  hasArgs?: boolean;
  /** Placeholder hint for the argument (shown in autocomplete). */
  argHint?: string;
}

/** All registered slash commands, in display order. */
export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "model", description: "Show or switch AI model", hasArgs: true, argHint: "<name>" },
  { name: "memories", description: "Browse memories" },
  { name: "skills", description: "Browse and install skills" },
  {
    name: "activity",
    description: "View signed deletions, consents, and other audit-grade events",
  },
  { name: "state", description: "Show current state vector" },
  { name: "forget", description: "Delete a memory by ID", hasArgs: true, argHint: "<nodeId>" },
  { name: "export", description: "Export all data as JSON" },
  { name: "clear", description: "Clear chat, start new conversation" },
  { name: "conversations", description: "Browse past conversations" },
  { name: "goals", description: "View and manage goals" },
  { name: "computer", description: "Motebit Computer — reveal or hide the slab" },
  { name: "tools", description: "List registered tools" },
  { name: "settings", description: "Open settings" },
  { name: "operator", description: "Show operator mode status" },
  { name: "summarize", description: "Summarize current conversation" },
  { name: "sync", description: "Sync with relay server" },
  { name: "help", description: "Show available commands" },
  { name: "graph", description: "Memory graph stats" },
  { name: "curious", description: "Show curiosity targets" },
  { name: "reflect", description: "Trigger self-reflection" },
  { name: "gradient", description: "Intelligence gradient" },
  { name: "agents", description: "List known agents" },
  { name: "discover", description: "Discover agents on relay" },
  { name: "approvals", description: "Show pending approvals" },
  { name: "balance", description: "Show account balance" },
  { name: "deposits", description: "Show deposit history" },
  { name: "proposals", description: "List active proposals" },
  { name: "delegate", description: "Delegate task to agent" },
  { name: "propose", description: "Propose collaborative plan" },
  { name: "withdraw", description: "Request withdrawal" },
  { name: "mcp", description: "MCP server management" },
  { name: "serve", description: "Toggle accepting delegations from network" },
  {
    name: "sensitivity",
    description:
      "Show or set session sensitivity (none|personal|medical|financial|secret) — high tiers fail-close external AI + outbound tools",
    hasArgs: true,
    argHint: "[<level>]",
  },
];

/** Map of command name to definition for O(1) lookup. */
export const COMMAND_MAP = new Map<string, SlashCommandDef>(
  SLASH_COMMANDS.map((cmd) => [cmd.name, cmd]),
);

/**
 * Check whether the input is a slash command.
 */
export function isSlashCommand(input: string): boolean {
  return input.startsWith("/");
}

/**
 * Parse a slash command string into command name and arguments.
 * Input should start with "/".
 */
export function parseSlashCommand(input: string): { command: string; args: string } {
  const trimmed = input.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { command: trimmed.slice(1).toLowerCase(), args: "" };
  return {
    command: trimmed.slice(1, spaceIdx).toLowerCase(),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

/**
 * Filter commands that match a partial input.
 * `partial` is the text after "/" (may be empty).
 */
export function filterCommands(partial: string): SlashCommandDef[] {
  const lower = partial.toLowerCase();
  if (!lower) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(lower));
}

/**
 * Format the /help text from command definitions.
 */
export function formatHelpText(): string {
  const lines = ["Available commands:"];
  for (const cmd of SLASH_COMMANDS) {
    const argText = cmd.hasArgs === true ? ` ${cmd.argHint ?? "<arg>"}` : "";
    lines.push(`/${cmd.name}${argText} — ${cmd.description}`);
  }
  return lines.join("\n");
}
