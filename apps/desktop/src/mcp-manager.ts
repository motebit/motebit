/**
 * MCP manager — owns the desktop's registered MCP servers and the
 * connect / disconnect / tool-dispatch lifecycle.
 *
 * Extracted from the DesktopApp god class as Target 7 of the desktop
 * extraction plan (see `desktop_extraction_plan.md`). MCP is the motebit
 * tool-dispatch boundary: every external capability the motebit can
 * invoke (GitHub MCP, file ops, web search, code review, …) enters via
 * an MCP server connection. Giving it a dedicated home makes the goal
 * scheduler (Target 8) a clean downstream consumer — the scheduler
 * calls the runtime's tool registry for dispatch and never needs to
 * know about MCP internals.
 *
 * ### State ownership
 *
 * The manager owns three per-server maps:
 *
 *   - `adapters`    — live connection objects (disconnect handle)
 *   - `configs`     — the persistent `McpServerConfig` records for every
 *                     known server, whether currently connected or not
 *   - `toolCounts`  — cache of tool counts per connected server, used by
 *                     the settings UI to render the "{N} tools" badge
 *
 * ### Two connection paths
 *
 *   1. **Native** (`addMcpServer`): dynamic-imports `@motebit/mcp-client`
 *      and constructs a real `McpClientAdapter`. Works in the Tauri
 *      sidecar context where Node APIs (node:stream, node:child_process)
 *      are available. Uses `AdvisoryManifestVerifier` — always accepts
 *      on first connect, revokes trust if the manifest changes.
 *
 *   2. **Tauri IPC bridge** (`connectMcpServerViaTauri`): fallback for
 *      pure-webview contexts where the dynamic import fails. Spawns the
 *      MCP server via `shell_exec_tool`, sends JSON-RPC init +
 *      tools/list via stdin, parses the tool manifest from stdout, and
 *      registers a proxied tool handler that re-spawns the server for
 *      each invocation. Slower than native but works where native fails.
 *
 * ### Runtime dependency
 *
 * The manager needs to call `runtime.registerExternalTools(key, reg)`
 * and `runtime.unregisterExternalTools(key)` to plumb discovered tools
 * into the agentic loop. The runtime reference can change over time
 * (it's `null` before `initAI` is called, set after), so the manager
 * reads it via a getter function passed in the constructor. This keeps
 * the manager honest about runtime lifecycle without requiring a
 * re-binding call from DesktopApp.
 */

import { SimpleToolRegistry, type MotebitRuntime } from "@motebit/runtime";
import type { McpServerConfig, ServerVerifier } from "@motebit/runtime";
import type { InvokeFn } from "./tauri-storage.js";

/**
 * Status projection of a registered MCP server. Consumed by the settings
 * UI to render the server list with connection state + tool count.
 *
 * `manifestChanged` / `manifestDiff` are populated only on the connect
 * call that detected a change (via `AdvisoryManifestVerifier`). Used by
 * the settings UI to surface a "this server's tool surface changed"
 * banner so the operator can review before trusting.
 */
export interface McpServerStatus {
  name: string;
  transport: string;
  trusted: boolean;
  connected: boolean;
  toolCount: number;
  manifestChanged?: boolean;
  /** If manifest changed, tools added/removed since last pin. */
  manifestDiff?: { added: string[]; removed: string[] };
}

export class McpManager {
  private adapters = new Map<string, { disconnect(): Promise<void> }>();
  private configs = new Map<string, McpServerConfig>();
  private toolCounts = new Map<string, number>();

  /**
   * @param getRuntime — getter for the current `MotebitRuntime`. Returns
   *   `null` before `initAI` has been called. The manager reads the
   *   runtime lazily via this getter instead of holding a direct
   *   reference, so DesktopApp can swap the runtime without re-binding
   *   the manager.
   */
  constructor(private getRuntime: () => MotebitRuntime | null) {}

  /**
   * Connect to an MCP server via the native client path. Works when
   * `@motebit/mcp-client` can be dynamically imported (Tauri sidecar
   * context). Returns a status record describing the connection outcome
   * including any manifest-diff if the server's tool surface changed
   * since the last pinned state.
   *
   * Side effects: mutates `config` in place to persist the verifier's
   * applied updates (`toolManifestHash`, `pinnedToolNames`, `trusted`,
   * `motebitPublicKey` on first verified motebit connect). This is
   * deliberate — the caller passes a config record expected to be
   * persisted back to the config store after this call returns.
   */
  async addMcpServer(config: McpServerConfig): Promise<McpServerStatus> {
    // Dynamic import to avoid bundling Node-only dependencies into the webview
    const mcpModule = await (import("@motebit/mcp-client") as Promise<{
      McpClientAdapter: new (config: McpServerConfig) => {
        connect(): Promise<void>;
        disconnect(): Promise<void>;
        getTools(): unknown[];
        registerInto(registry: unknown): void;
        readonly isMotebit: boolean;
        readonly verifiedIdentity: {
          verified: boolean;
          motebit_id?: string;
          public_key?: string;
        } | null;
        readonly serverConfig: McpServerConfig;
      };
      AdvisoryManifestVerifier: new () => ServerVerifier;
    }>);
    // Attach advisory verifier: always accepts, revokes trust on manifest change
    config.serverVerifier = new mcpModule.AdvisoryManifestVerifier();
    const adapter = new mcpModule.McpClientAdapter(config);
    await adapter.connect();

    // Read verifier-applied config updates
    const manifestChanged = adapter.serverConfig.trusted === false && config.trusted !== false;
    let manifestDiff: { added: string[]; removed: string[] } | undefined;
    if (manifestChanged) {
      const prevSet = new Set(config.pinnedToolNames ?? []);
      const currNames = adapter.serverConfig.pinnedToolNames ?? [];
      const added = currNames.filter((n: string) => !prevSet.has(n));
      const removed = (config.pinnedToolNames ?? []).filter(
        (n: string) => !new Set(currNames).has(n),
      );
      manifestDiff = { added, removed };
    }
    // Persist updated manifest hash and tool names from verifier
    config.toolManifestHash = adapter.serverConfig.toolManifestHash;
    config.pinnedToolNames = adapter.serverConfig.pinnedToolNames;
    config.trusted = adapter.serverConfig.trusted;

    // Pin motebit public key on first verified connect
    if (adapter.isMotebit && adapter.verifiedIdentity?.verified === true) {
      const verifiedKey = adapter.verifiedIdentity.public_key;
      if (verifiedKey && !config.motebitPublicKey) {
        config.motebitPublicKey = verifiedKey;
      }
    }

    // Register tools into a temporary registry, then merge into runtime
    const tempRegistry = new SimpleToolRegistry();
    adapter.registerInto(tempRegistry);

    const runtime = this.getRuntime();
    if (runtime) {
      runtime.registerExternalTools(`mcp:${config.name}`, tempRegistry);
    }

    this.adapters.set(config.name, adapter);
    this.configs.set(config.name, config);
    const toolCount = adapter.getTools().length;
    this.toolCounts.set(config.name, toolCount);

    return {
      name: config.name,
      transport: config.transport,
      trusted: config.trusted ?? false,
      connected: true,
      toolCount,
      manifestChanged,
      manifestDiff,
    };
  }

  /**
   * Disconnect from a server and forget its config + tool count. Also
   * unregisters the tools from the runtime's external tool registry so
   * the agentic loop stops seeing them.
   */
  async removeMcpServer(name: string): Promise<void> {
    const adapter = this.adapters.get(name);
    if (adapter) {
      await adapter.disconnect();
      this.adapters.delete(name);
    }
    this.configs.delete(name);
    this.toolCounts.delete(name);
    const runtime = this.getRuntime();
    if (runtime) {
      runtime.unregisterExternalTools(`mcp:${name}`);
    }
  }

  /** Return a status snapshot of every registered MCP server. */
  getMcpStatus(): McpServerStatus[] {
    const result: McpServerStatus[] = [];
    for (const [name, config] of this.configs) {
      result.push({
        name,
        transport: config.transport,
        trusted: config.trusted ?? false,
        connected: this.adapters.has(name),
        toolCount: this.toolCounts.get(name) ?? 0,
      });
    }
    return result;
  }

  /**
   * Connect to an MCP server using Tauri IPC if the native path fails.
   *
   * First attempt: native `addMcpServer` (dynamic import of mcp-client).
   * Works in Tauri sidecar and falls through silently on failure.
   *
   * Fallback: Tauri IPC bridge. Spawns the MCP server via shell_exec_tool,
   * sends JSON-RPC init + tools/list via stdin, parses the tool manifest
   * from stdout, and registers a proxied tool handler that re-spawns the
   * server for each invocation. Higher latency than native but works in
   * pure-webview contexts where node:child_process isn't reachable.
   *
   * In either path, the config is persisted into `configs` so
   * `getMcpStatus` reports it. On total failure (stdio transport without
   * a command, init RPC error, unparseable stdout), the server is
   * registered as `connected: false` so the UI can show an error state.
   */
  async connectMcpServerViaTauri(
    config: McpServerConfig,
    invoke: InvokeFn,
  ): Promise<McpServerStatus> {
    // First try the existing dynamic import approach (works in Tauri sidecar context)
    try {
      return await this.addMcpServer(config);
    } catch {
      // Dynamic import failed (expected in pure webview) — use Tauri IPC bridge
    }

    // Tauri IPC bridge: spawn MCP server, discover tools, register as proxied tools
    if (config.transport !== "stdio" || config.command == null || config.command === "") {
      this.configs.set(config.name, config);
      return {
        name: config.name,
        transport: config.transport,
        trusted: config.trusted ?? false,
        connected: false,
        toolCount: 0,
      };
    }

    try {
      // Discover tools by running the MCP server and listing tools
      // We use shell_exec to start the server with a tools/list request
      const args = config.args ?? [];
      const fullCommand = [config.command, ...args].join(" ");

      // Try to spawn and get tool list via MCP init + tools/list
      // This is a simplified approach — full MCP stdio protocol would need a Rust command
      const initPayload = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "motebit-desktop", version: "0.1.0" },
        },
      });
      const listPayload = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });

      // Combine payloads, escape for safe shell interpolation (single quotes → '\'' break-and-rejoin)
      const stdinData = `${initPayload}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n${listPayload}`;
      const escaped = stdinData.replace(/'/g, "'\\''");

      // Send init + initialized notification + tools/list through stdin
      const shellResult = await invoke<{ stdout: string; stderr: string; exit_code: number }>(
        "shell_exec_tool",
        {
          command: `printf '%s' '${escaped}' | ${fullCommand}`,
          cwd: null,
        },
      );

      if (shellResult.exit_code === 0 && shellResult.stdout) {
        // Parse JSON-RPC responses from stdout
        const lines = shellResult.stdout.split("\n").filter((l) => l.trim());
        let toolCount = 0;

        for (const line of lines) {
          try {
            const response = JSON.parse(line) as {
              id?: number;
              result?: {
                tools?: Array<{
                  name: string;
                  description?: string;
                  inputSchema?: Record<string, unknown>;
                }>;
              };
            };
            if (response.id === 2 && response.result?.tools) {
              const tempRegistry = new SimpleToolRegistry();
              for (const mcpTool of response.result.tools) {
                const qualifiedName = `${config.name}__${mcpTool.name}`;
                const definition = {
                  name: qualifiedName,
                  description: `[${config.name}] ${mcpTool.description ?? mcpTool.name}`,
                  inputSchema: mcpTool.inputSchema ?? { type: "object" as const, properties: {} },
                  ...(config.trusted === true ? {} : { requiresApproval: true as const }),
                };

                // Create a handler that calls the tool via Tauri shell
                const toolHandler = this.createMcpToolHandler(config, mcpTool.name, invoke);
                tempRegistry.register(definition, toolHandler);
                toolCount++;
              }

              const runtime = this.getRuntime();
              if (runtime) {
                runtime.registerExternalTools(`mcp:${config.name}`, tempRegistry);
              }
            }
          } catch {
            // Skip unparseable lines
          }
        }

        this.configs.set(config.name, config);
        this.toolCounts.set(config.name, toolCount);
        return {
          name: config.name,
          transport: config.transport,
          trusted: config.trusted ?? false,
          connected: true,
          toolCount,
        };
      }
    } catch {
      // MCP connection failed — store config but mark as disconnected
    }

    this.configs.set(config.name, config);
    return {
      name: config.name,
      transport: config.transport,
      trusted: config.trusted ?? false,
      connected: false,
      toolCount: 0,
    };
  }

  /**
   * Create a tool handler closure that invokes an MCP tool by spawning
   * the server via Tauri `shell_exec_tool`. Each call re-runs the full
   * JSON-RPC handshake (init + initialized notification + tools/call)
   * over a single stdin blob, then parses the response from stdout.
   * Higher latency than native mcp-client but works in pure-webview
   * contexts.
   */
  private createMcpToolHandler(
    config: McpServerConfig,
    mcpToolName: string,
    invoke: InvokeFn,
  ): (args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }> {
    return async (args) => {
      try {
        const fullCommand = [config.command!, ...(config.args ?? [])].join(" ");
        const callPayload = [
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "motebit-desktop", version: "0.1.0" },
            },
          }),
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: mcpToolName, arguments: args },
          }),
        ].join("\n");

        const escapedPayload = callPayload.replace(/'/g, "'\\''");
        const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>(
          "shell_exec_tool",
          { command: `printf '%s' '${escapedPayload}' | ${fullCommand}`, cwd: null },
        );

        if (result.stdout) {
          const lines = result.stdout.split("\n").filter((l) => l.trim());
          for (const line of lines) {
            try {
              const response = JSON.parse(line) as {
                id?: number;
                result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
              };
              if (response.id === 2 && response.result) {
                const textContent = (response.result.content ?? [])
                  .filter((c) => c.type === "text")
                  .map((c) => c.text ?? "")
                  .join("\n");
                return {
                  ok: response.result.isError !== true,
                  data: textContent !== "" ? textContent : response.result.content,
                  error: response.result.isError === true ? textContent : undefined,
                };
              }
            } catch {
              /* skip */
            }
          }
        }

        return { ok: false, error: `MCP tool ${mcpToolName} returned no result` };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    };
  }
}
