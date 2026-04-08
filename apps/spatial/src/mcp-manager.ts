/**
 * Spatial MCP manager — owns the registered HTTP MCP servers, their
 * live adapters, and the connect/disconnect/tool-registration
 * lifecycle. Browser-only (HTTP transport only) — stdio MCP servers
 * need the desktop or CLI app because React Native and the browser
 * have no node:child_process.
 *
 * Mirrors the mobile McpManager — same shape, same vocabulary,
 * different storage (localStorage instead of AsyncStorage).
 *
 * ### State ownership
 *
 *   - `adapters`  — live `McpClientAdapter` per server
 *   - `configs`   — persistent `McpServerConfig[]` mirror of localStorage
 *
 * ### Security
 *
 * Every connect attaches an `AdvisoryManifestVerifier` — always accepts
 * on first connect, revokes trust if the tool manifest changes.
 * Trusted servers register tools without `requiresApproval`; untrusted
 * servers force per-tool approval through `PolicyGate`.
 */

import type { MotebitRuntime } from "@motebit/runtime";
import { McpClientAdapter, AdvisoryManifestVerifier } from "@motebit/mcp-client";
import type { McpServerConfig } from "@motebit/mcp-client";
import { InMemoryToolRegistry } from "@motebit/tools/web-safe";

const MCP_SERVERS_KEY = "motebit:mcp_servers";

export interface SpatialMcpServerStatus {
  name: string;
  url: string;
  connected: boolean;
  toolCount: number;
  trusted: boolean;
  motebit: boolean;
}

export interface SpatialMcpManagerDeps {
  getRuntime: () => MotebitRuntime | null;
}

export class SpatialMcpManager {
  private adapters = new Map<string, McpClientAdapter>();
  private configs: McpServerConfig[] = [];

  constructor(private deps: SpatialMcpManagerDeps) {}

  async addMcpServer(config: McpServerConfig): Promise<void> {
    if (config.transport !== "http") {
      throw new Error(
        "Spatial only supports HTTP MCP servers. Use the desktop or CLI app for stdio servers.",
      );
    }
    if (config.url == null || config.url === "") {
      throw new Error("HTTP MCP server requires a url");
    }

    // Attach advisory verifier: always accepts, revokes trust on manifest change
    config.serverVerifier = new AdvisoryManifestVerifier();
    const adapter = new McpClientAdapter(config);
    await adapter.connect();

    // Persist verifier-applied config updates
    config.toolManifestHash = adapter.serverConfig.toolManifestHash;
    config.pinnedToolNames = adapter.serverConfig.pinnedToolNames;
    if (adapter.serverConfig.trusted === false) {
      config.trusted = false;
    }

    // Persist motebit public key if newly pinned during connect
    if (adapter.isMotebit && adapter.verifiedIdentity?.verified) {
      const pinnedKey = adapter.serverConfig.motebitPublicKey;
      if (pinnedKey && !config.motebitPublicKey) {
        config.motebitPublicKey = pinnedKey;
      }
    }

    this.registerMcpTools(adapter, config);

    this.adapters.set(config.name, adapter);
    this.configs = this.configs.filter((s) => s.name !== config.name);
    this.configs.push(config);
    this.persistMcpServers();
  }

  async removeMcpServer(name: string): Promise<void> {
    const adapter = this.adapters.get(name);
    if (adapter) {
      await adapter.disconnect();
      this.adapters.delete(name);
    }
    const runtime = this.deps.getRuntime();
    if (runtime) {
      runtime.unregisterExternalTools(`mcp:${name}`);
    }
    this.configs = this.configs.filter((s) => s.name !== name);
    this.persistMcpServers();
  }

  getMcpServers(): SpatialMcpServerStatus[] {
    return this.configs.map((config) => {
      const adapter = this.adapters.get(config.name);
      return {
        name: config.name,
        url: config.url ?? "",
        connected: adapter?.isConnected ?? false,
        toolCount: adapter?.getTools().length ?? 0,
        trusted: config.trusted ?? false,
        motebit: config.motebit ?? false,
      };
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async interface
  async setMcpServerTrust(name: string, trusted: boolean): Promise<void> {
    const config = this.configs.find((s) => s.name === name);
    if (!config) return;
    config.trusted = trusted;

    const adapter = this.adapters.get(name);
    const runtime = this.deps.getRuntime();
    if (adapter && runtime) {
      runtime.unregisterExternalTools(`mcp:${name}`);
      this.registerMcpTools(adapter, config);
    }

    this.persistMcpServers();
  }

  /** Register MCP tools into the runtime with trust-aware approval flags. */
  private registerMcpTools(adapter: McpClientAdapter, config: McpServerConfig): void {
    const tempRegistry = new InMemoryToolRegistry();
    for (const mcpTool of adapter.getTools()) {
      const def = {
        name: mcpTool.name,
        description: `[${config.name}] ${mcpTool.description ?? mcpTool.name}`,
        inputSchema: mcpTool.inputSchema ?? { type: "object", properties: {} },
        ...(config.trusted === true ? {} : { requiresApproval: true as const }),
      };
      tempRegistry.register(def, (args: Record<string, unknown>) =>
        adapter.executeTool(mcpTool.name, args),
      );
    }
    const runtime = this.deps.getRuntime();
    if (runtime) {
      runtime.registerExternalTools(`mcp:${config.name}`, tempRegistry);
    }
  }

  /**
   * Reconnect MCP servers from localStorage. Called once from initAI
   * after the runtime is ready. Silent per-server failures — a single
   * flaky server doesn't break the whole set.
   */
  async reconnectMcpServers(): Promise<void> {
    const raw = localStorage.getItem(MCP_SERVERS_KEY);
    if (raw == null || raw === "") return;
    try {
      const configs = JSON.parse(raw) as McpServerConfig[];
      this.configs = configs;
      let changed = false;
      for (const config of configs) {
        try {
          config.serverVerifier = new AdvisoryManifestVerifier();
          const adapter = new McpClientAdapter(config);
          await adapter.connect();

          // Persist verifier-applied config updates
          config.toolManifestHash = adapter.serverConfig.toolManifestHash;
          config.pinnedToolNames = adapter.serverConfig.pinnedToolNames;
          if (adapter.serverConfig.trusted === false) {
            config.trusted = false;
          }

          if (adapter.isMotebit && adapter.verifiedIdentity?.verified) {
            const pinnedKey = adapter.serverConfig.motebitPublicKey;
            if (pinnedKey && !config.motebitPublicKey) {
              config.motebitPublicKey = pinnedKey;
            }
          }

          this.registerMcpTools(adapter, config);
          this.adapters.set(config.name, adapter);
          changed = true;
        } catch {
          // Non-fatal — server may be offline
        }
      }
      if (changed) {
        this.persistMcpServers();
      }
    } catch {
      // Non-fatal — corrupted localStorage
    }
  }

  private persistMcpServers(): void {
    localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(this.configs));
  }

  /** Disconnect every MCP adapter. Called from SpatialApp.dispose(). */
  dispose(): void {
    for (const adapter of this.adapters.values()) {
      void adapter.disconnect();
    }
    this.adapters.clear();
  }
}
