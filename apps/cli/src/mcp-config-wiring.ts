/**
 * The CLI REPL's config-listed MCP servers (`mcp_servers`) — ONE connection
 * per server, ONE owner of its lifecycle (#943).
 *
 * The REPL connects each server itself (it needs the adapters: key pinning,
 * `/mcp list`, `/mcp remove`) and registers each server's tools with the
 * runtime as an owner-connected source `mcp:<name>` — `registerExternalTools`
 * forces `localOnly`, so a foreign turn is never offered them and an attached
 * `motebit serve` never serves them. The runtime is therefore NOT also given
 * the servers (`runtimeMcpServersForRepl` returns none): a second, runtime-
 * owned connection would win the tool handlers and keep answering after
 * `/mcp remove` disconnected the REPL's adapter.
 */
import { connectMcpServers } from "@motebit/mcp-client";
import type { McpServerConfig } from "@motebit/mcp-client";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { ToolRegistry } from "@motebit/sdk";

type McpAdapters = Awaited<ReturnType<typeof connectMcpServers>>;

/** The owner-connected-tool surface of the runtime this wiring needs. */
export interface OwnerToolHost {
  registerExternalTools(sourceId: string, registry: ToolRegistry): void;
  unregisterExternalTools(sourceId: string): void;
  /** Delegation visibility for a motebit server's tools (see the runtime). */
  registerMotebitToolServer(serverName: string, toolNames: string[]): void;
  unregisterMotebitToolServer(serverName: string): void;
}

/**
 * The servers the REPL hands the runtime's own `mcpServers` path: none. The
 * REPL is the one owner of each connection.
 */
export function runtimeMcpServersForRepl(_servers: McpServerConfig[]): McpServerConfig[] {
  return [];
}

/**
 * Connect the config's servers and register each one's tools under its own
 * source `mcp:<name>` (owner-connected, `localOnly`). Returns the adapters —
 * the REPL keeps them to disconnect on `/mcp remove` — and the tool count.
 */
export async function connectConfigMcpServers(
  host: OwnerToolHost,
  servers: McpServerConfig[],
): Promise<{ adapters: McpAdapters; toolCount: number }> {
  // Discovery into a throwaway registry; each adapter then registers its own
  // tools into a per-server registry so `/mcp remove <name>` finds them.
  const adapters = await connectMcpServers(servers, new InMemoryToolRegistry());
  let toolCount = 0;
  for (const adapter of adapters) {
    const perServer = new InMemoryToolRegistry();
    adapter.registerInto(perServer);
    host.registerExternalTools(`mcp:${adapter.serverName}`, perServer);
    // A motebit server's tool calls are delegations — the runtime renders
    // them as such only when it knows the mapping.
    if (adapter.isMotebit) {
      host.registerMotebitToolServer(
        adapter.serverName,
        adapter.getTools().map((t) => t.name),
      );
    }
    toolCount += perServer.size;
  }
  return { adapters, toolCount };
}

/**
 * Take one server out of service: disconnect its (single) adapter and
 * unregister its `mcp:<name>` tools. Returns whether an adapter was found.
 */
export async function disconnectMcpServer(
  host: OwnerToolHost,
  adapters: McpAdapters,
  name: string,
): Promise<boolean> {
  const idx = adapters.findIndex((a) => a.serverName === name);
  if (idx >= 0) {
    const adapter = adapters[idx];
    try {
      await adapter?.disconnect();
    } catch {
      /* best effort */
    }
    adapters.splice(idx, 1);
  }
  host.unregisterExternalTools(`mcp:${name}`);
  host.unregisterMotebitToolServer(name);
  return idx >= 0;
}
