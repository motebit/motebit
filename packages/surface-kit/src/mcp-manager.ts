/**
 * Surface-agnostic MCP manager — the connect / disconnect / trust /
 * tool-registration lifecycle for HTTP MCP servers, shared by every flat
 * surface (mobile, spatial, …). Previously this logic was forked per
 * surface (`MobileMcpManager`, `SpatialMcpManager`) differing ONLY in
 * storage backend, tool-registry build variant, and naming — identical
 * state machine otherwise. This is the canonical owner; surfaces inject
 * their platform adapters through the ports below and keep a thin subclass.
 *
 * ### State ownership
 *   - `adapters`              — live `McpClientAdapter` per server
 *   - `configs`              — persistent `McpServerConfig[]` mirror of storage
 *   - `_toolsChangedCallback`— notified after every add/remove/trust change so
 *                              the surface can re-render the tool badge count
 *
 * ### Security
 * Every connect attaches an `AdvisoryManifestVerifier` — accepts on first
 * connect, revokes trust if the tool manifest changes. Trusted servers
 * register tools without `requiresApproval`; untrusted servers force per-tool
 * approval through the runtime's `PolicyGate`. The trust toggle re-registers
 * tools with updated approval flags in one atomic move.
 *
 * ### Ports (dependency inversion — no upward layer dependency)
 *   - `KeyValueStore`    — async get/set; mobile wraps AsyncStorage, spatial
 *                          wraps localStorage, desktop its own store.
 *   - `ExternalToolHost` — the runtime's external-tools registration surface.
 *                          `MotebitRuntime` satisfies it structurally, so the
 *                          package never imports `@motebit/runtime` (L5) and
 *                          stays at L3.
 *   - `createToolRegistry` — factory so each surface supplies the build variant
 *                          it needs (`@motebit/tools` vs `@motebit/tools/web-safe`).
 */

import { McpClientAdapter, AdvisoryManifestVerifier } from "@motebit/mcp-client";
import type { McpServerConfig } from "@motebit/mcp-client";
import type { ToolRegistry } from "@motebit/sdk";

/** Async key-value persistence port. AsyncStorage is already this shape; a
 *  synchronous localStorage is wrapped with `Promise.resolve`. */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** The runtime's external-tools registration surface. `MotebitRuntime`
 *  satisfies this structurally — surfaces pass their runtime getter directly. */
export interface ExternalToolHost {
  registerExternalTools(key: string, registry: ToolRegistry): void;
  unregisterExternalTools(key: string): void;
}

export interface McpServerStatus {
  name: string;
  url: string;
  connected: boolean;
  toolCount: number;
  trusted: boolean;
  motebit: boolean;
  motebitPublicKey?: string;
}

export interface McpManagerCoreDeps {
  /** Persistent store for the server config mirror. */
  storage: KeyValueStore;
  /** The storage key (surface-owned; see storage-key conventions). */
  storageKey: string;
  /** Lazily read the runtime — null before the runtime is ready. */
  getToolHost: () => ExternalToolHost | null;
  /** Build a fresh tool registry (surface supplies the node/web-safe variant). */
  createToolRegistry: () => ToolRegistry;
}

export class McpManager {
  private adapters = new Map<string, McpClientAdapter>();
  private configs: McpServerConfig[] = [];
  private _toolsChangedCallback: (() => void) | null = null;

  constructor(private deps: McpManagerCoreDeps) {}

  private async persist(): Promise<void> {
    await this.deps.storage.setItem(this.deps.storageKey, JSON.stringify(this.configs));
  }

  /**
   * Connect an HTTP MCP server and register its tools on the runtime. Only
   * HTTP transport is supported here — stdio needs `node:child_process`, which
   * neither React Native nor the browser provides (use the desktop or CLI app).
   */
  async addMcpServer(config: McpServerConfig): Promise<void> {
    if (config.transport !== "http") {
      throw new Error(
        "This surface only supports HTTP MCP servers. Use the desktop or CLI app for stdio servers.",
      );
    }
    if (config.url == null || config.url === "") {
      throw new Error("HTTP MCP server requires a url");
    }

    // Attach advisory verifier: always accepts, revokes trust on manifest change
    config.serverVerifier = new AdvisoryManifestVerifier();
    const adapter = new McpClientAdapter(config);
    await adapter.connect();

    this.applyVerifierUpdates(adapter, config);
    this.registerMcpTools(adapter, config);

    this.adapters.set(config.name, adapter);
    this.configs = this.configs.filter((s) => s.name !== config.name);
    this.configs.push(config);

    await this.persist();
    this._toolsChangedCallback?.();
  }

  async removeMcpServer(name: string): Promise<void> {
    const adapter = this.adapters.get(name);
    if (adapter) {
      await adapter.disconnect();
      this.adapters.delete(name);
    }
    this.deps.getToolHost()?.unregisterExternalTools(`mcp:${name}`);

    this.configs = this.configs.filter((s) => s.name !== name);
    await this.persist();
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

    const adapter = this.adapters.get(name);
    const host = this.deps.getToolHost();
    if (adapter && host) {
      host.unregisterExternalTools(`mcp:${name}`);
      this.registerMcpTools(adapter, config);
    }

    await this.persist();
    this._toolsChangedCallback?.();
  }

  onToolsChanged(callback: () => void): void {
    this._toolsChangedCallback = callback;
  }

  /**
   * Disconnect every live adapter. Surfaces call this on teardown, often
   * without awaiting. Every `disconnect()` is invoked synchronously (before
   * the first await yields) so a non-awaiting caller still tears all of them
   * down; the returned promise settles once they all complete.
   */
  async dispose(): Promise<void> {
    const pending = [...this.adapters.values()].map((adapter) =>
      Promise.resolve(adapter.disconnect()).catch(() => {
        // best-effort teardown
      }),
    );
    this.adapters.clear();
    await Promise.all(pending);
  }

  /** Persist verifier-applied config updates after a connect. */
  private applyVerifierUpdates(adapter: McpClientAdapter, config: McpServerConfig): void {
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
  }

  /** Register MCP tools into the runtime with trust-aware approval flags. */
  private registerMcpTools(adapter: McpClientAdapter, config: McpServerConfig): void {
    const tempRegistry = this.deps.createToolRegistry();
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
    this.deps.getToolHost()?.registerExternalTools(`mcp:${config.name}`, tempRegistry);
  }

  /**
   * Reconnect MCP servers from persistent storage. Called once from `initAI`
   * after the runtime is ready. Silent per-server failures — a single flaky
   * server doesn't break the whole set.
   */
  async reconnectMcpServers(): Promise<void> {
    const raw = await this.deps.storage.getItem(this.deps.storageKey);
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

          this.applyVerifierUpdates(adapter, config);
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
        await this.persist();
        this._toolsChangedCallback?.();
      }
    } catch {
      // Non-fatal — corrupted storage
    }
  }
}
