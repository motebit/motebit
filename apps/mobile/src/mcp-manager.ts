/**
 * Mobile MCP manager — owns the registered MCP servers, their live
 * adapters, and the connect/disconnect/tool-registration lifecycle.
 * Mobile is HTTP-only (no stdio transport — no node:child_process in
 * React Native), so this is simpler than the desktop MCP manager.
 *
 * Extracted from `mobile-app.ts` as Target 3 of the mobile extraction
 * plan. Mirrors the desktop `McpManager` pattern — class owns the
 * `adapters` + `configs` maps and a `_toolsChangedCallback` slot;
 * runtime is read lazily via a getter closure.
 *
 * ### State ownership
 *
 *   - `adapters`                — live `McpClientAdapter` per server
 *   - `configs`                 — persistent `McpServerConfig[]` mirror
 *                                 of what's in AsyncStorage
 *   - `_toolsChangedCallback`   — notified after every add/remove/trust
 *                                 change so the UI can re-render the
 *                                 tool badge count
 *
 * ### Security
 *
 * Every connect attaches an `AdvisoryManifestVerifier` — always accepts
 * on first connect, revokes trust if the tool manifest changes. Trusted
 * servers have tools registered without `requiresApproval`; untrusted
 * servers force per-tool approval through `PolicyGate`. Trust toggle
 * re-registers tools with updated approval flags in one atomic move.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { MotebitRuntime } from "@motebit/runtime";
import { McpClientAdapter, AdvisoryManifestVerifier } from "@motebit/mcp-client";
import type { McpServerConfig } from "@motebit/mcp-client";
import { InMemoryToolRegistry } from "@motebit/tools";
import { ASYNC_STORAGE_KEYS } from "./storage-keys";

const MCP_SERVERS_KEY = ASYNC_STORAGE_KEYS.mcpServers;

export interface McpServerStatus {
  name: string;
  url: string;
  connected: boolean;
  toolCount: number;
  trusted: boolean;
  motebit: boolean;
  motebitPublicKey?: string;
}

export interface McpManagerDeps {
  getRuntime: () => MotebitRuntime | null;
}

export class MobileMcpManager {
  private adapters = new Map<string, McpClientAdapter>();
  private configs: McpServerConfig[] = [];
  private _toolsChangedCallback: (() => void) | null = null;

  constructor(private deps: McpManagerDeps) {}

  /**
   * Connect an HTTP MCP server and register its tools on the runtime.
   * Mobile only supports HTTP transport — stdio is rejected because
   * React Native has no node:child_process.
   */
  async addMcpServer(config: McpServerConfig): Promise<void> {
    if (config.transport !== "http") {
      throw new Error(
        "Mobile only supports HTTP MCP servers. Use the desktop or CLI app for stdio servers.",
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

    // Register tools with trust-aware approval flags
    this.registerMcpTools(adapter, config);

    this.adapters.set(config.name, adapter);
    this.configs = this.configs.filter((s) => s.name !== config.name);
    this.configs.push(config);

    // Persist
    await AsyncStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(this.configs));
    this._toolsChangedCallback?.();
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
    await AsyncStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(this.configs));
    this._toolsChangedCallback?.();
  }

  getMcpServers(): McpServerStatus[] {
    return this.configs.map((config) => {
      const adapter = this.adapters.get(config.name);
      return {
        name: config.name,
        url: config.url ?? "",
        connected: adapter?.isConnected ?? false,
        toolCount: adapter?.getTools().length ?? 0,
        trusted: config.trusted ?? false,
        motebit: config.motebit ?? false,
        motebitPublicKey: config.motebitPublicKey,
      };
    });
  }

  /** Toggle trust for an MCP server. Re-registers tools with updated approval requirements. */
  async setMcpServerTrust(name: string, trusted: boolean): Promise<void> {
    const config = this.configs.find((s) => s.name === name);
    if (!config) return;
    config.trusted = trusted;

    // Re-register tools with updated approval flags
    const adapter = this.adapters.get(name);
    const runtime = this.deps.getRuntime();
    if (adapter && runtime) {
      runtime.unregisterExternalTools(`mcp:${name}`);
      this.registerMcpTools(adapter, config);
    }

    await AsyncStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(this.configs));
    this._toolsChangedCallback?.();
  }

  onToolsChanged(callback: () => void): void {
    this._toolsChangedCallback = callback;
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
   * Reconnect MCP servers from persistent storage. Called once from
   * `initAI` after the runtime is ready. Silent per-server failures —
   * a single flaky server doesn't break the whole set.
   */
  async reconnectMcpServers(): Promise<void> {
    const raw = await AsyncStorage.getItem(MCP_SERVERS_KEY);
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

          // Persist motebit public key if newly pinned during connect
          if (adapter.isMotebit && adapter.verifiedIdentity?.verified) {
            const pinnedKey = adapter.serverConfig.motebitPublicKey;
            if (pinnedKey && !config.motebitPublicKey) {
              config.motebitPublicKey = pinnedKey;
            }
          }

          this.registerMcpTools(adapter, config);
          this.adapters.set(config.name, adapter);
          changed = true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.warn(`Failed to reconnect MCP server "${config.name}": ${msg}`);
        }
      }
      if (changed) {
        // Persist any manifest hash / trust updates
        await AsyncStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(this.configs));
        this._toolsChangedCallback?.();
      }
    } catch {
      // Non-fatal — corrupted storage
    }
  }
}
