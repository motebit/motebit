import type { McpServerConfig } from "./index.js";

export interface DiscoveryResult {
  servers: McpServerConfig[];
  source: string;
}

/**
 * Parse Claude Desktop config.
 * Path: ~/Library/Application Support/Claude/claude_desktop_config.json
 * Format: { "mcpServers": { "name": { "command": "...", "args": [...], "env": {...} } } }
 */
export function parseClaudeDesktopConfig(content: string): McpServerConfig[] {
  try {
    const json = JSON.parse(content) as Record<string, unknown>;
    const mcpServers = json.mcpServers as Record<string, unknown> | undefined;
    if (!mcpServers || typeof mcpServers !== "object") return [];
    return parseServerEntries(mcpServers, "Claude Desktop");
  } catch {
    return [];
  }
}

/**
 * Parse Claude Code config.
 * Path: ~/.claude.json
 * Format: { "mcpServers": { "name": { "command": "...", "args": [...], "env": {...} } } }
 */
export function parseClaudeCodeConfig(content: string): McpServerConfig[] {
  try {
    const json = JSON.parse(content) as Record<string, unknown>;
    const mcpServers = json.mcpServers as Record<string, unknown> | undefined;
    if (!mcpServers || typeof mcpServers !== "object") return [];
    return parseServerEntries(mcpServers, "Claude Code");
  } catch {
    return [];
  }
}

/**
 * Parse VS Code MCP settings.
 * Path: ~/Library/Application Support/Code/User/settings.json
 * Format: { "mcp": { "servers": { "name": { "command": "...", "args": [...], "env": {...} } } } }
 *    or:  { "mcp.servers": { "name": { ... } } }
 */
export function parseVSCodeMcpConfig(content: string): McpServerConfig[] {
  try {
    const json = JSON.parse(content) as Record<string, unknown>;

    // Try nested mcp.servers first
    const mcp = json.mcp as Record<string, unknown> | undefined;
    if (mcp && typeof mcp === "object") {
      const servers = mcp.servers as Record<string, unknown> | undefined;
      if (servers && typeof servers === "object") {
        return parseServerEntries(servers, "VS Code");
      }
    }

    // Try flat "mcp.servers" key
    const flat = json["mcp.servers"] as Record<string, unknown> | undefined;
    if (flat && typeof flat === "object") {
      return parseServerEntries(flat, "VS Code");
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * Convert a { name: { command, args, env, url } } object into McpServerConfig[].
 */
function parseServerEntries(entries: Record<string, unknown>, source: string): McpServerConfig[] {
  const results: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(entries)) {
    if (value == null || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;

    const config: McpServerConfig = {
      name,
      transport: typeof entry.url === "string" ? "http" : "stdio",
      trusted: false,
      source,
    };

    if (typeof entry.command === "string") config.command = entry.command;
    if (Array.isArray(entry.args))
      config.args = entry.args.filter((a): a is string => typeof a === "string");
    if (typeof entry.url === "string") config.url = entry.url;
    if (entry.env != null && typeof entry.env === "object") {
      config.env = Object.fromEntries(
        Object.entries(entry.env as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string")
          .map(([k, v]) => [k, v as string]),
      );
    }

    // Skip entries that have neither command nor url — not connectable
    if (
      (config.command == null || config.command === "") &&
      (config.url == null || config.url === "")
    )
      continue;

    results.push(config);
  }
  return results;
}

export interface NameCollision {
  name: string;
  existingCommand?: string;
  discoveredCommand?: string;
  discoveredSource: string;
}

/**
 * Merge discovered servers with existing config.
 * Existing servers (by name) take precedence — no overwriting user customizations.
 * Discovered servers are marked trusted: false by default.
 * Returns collisions where a discovered server shares a name with an existing
 * server but differs in command/url, for diagnostic logging.
 */
export function mergeDiscoveredServers(
  existing: McpServerConfig[],
  discovered: DiscoveryResult[],
): { merged: McpServerConfig[]; newServers: McpServerConfig[]; collisions: NameCollision[] } {
  const existingByName = new Map(existing.map((s) => [s.name, s]));
  const seenNew = new Set<string>();
  const newServers: McpServerConfig[] = [];
  const collisions: NameCollision[] = [];

  for (const result of discovered) {
    for (const server of result.servers) {
      if (seenNew.has(server.name)) continue;

      const existingServer = existingByName.get(server.name);
      if (existingServer) {
        // Name collision — check if the config actually differs
        const existingKey = existingServer.command ?? existingServer.url ?? "";
        const discoveredKey = server.command ?? server.url ?? "";
        if (existingKey !== discoveredKey) {
          collisions.push({
            name: server.name,
            existingCommand: existingServer.command ?? existingServer.url,
            discoveredCommand: server.command ?? server.url,
            discoveredSource: server.source ?? result.source,
          });
        }
        continue;
      }

      seenNew.add(server.name);
      newServers.push(server);
    }
  }

  return {
    merged: [...existing, ...newServers],
    newServers,
    collisions,
  };
}
