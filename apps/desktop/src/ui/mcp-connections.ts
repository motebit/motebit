/**
 * MCP Connections — desktop. Owns the in-memory `McpServerConfig[]` array
 * and the `NameCollision[]` set produced by discovery, and renders both
 * inside the Connections sub-tab of the Capabilities panel.
 *
 * Lifted from `settings.ts` during the Capabilities-panel migration
 * (2026-05-13). The Skills sub-tab and Connections sub-tab are siblings
 * on the capability-primitive panel per
 * `docs/doctrine/panel-temporal-registers.md` substrate-vs-accumulation.
 *
 * Storage path stays put — the JSON config file (`mcp_servers` key) is
 * still the persistence surface; this module only owns the in-memory
 * cache + the UI. `main.ts` reads and writes the array via the exported
 * accessors at the same callsites it previously used through the
 * `settings` API.
 */

import type { McpServerConfig } from "../index";
import type { NameCollision } from "../mcp-discovery";
import type { DesktopContext } from "../types";

// ---------------------------------------------------------------------------
// In-memory state — owned here, accessed from main.ts (boot + discover +
// reconnect cascade) and from the renderer below.
// ---------------------------------------------------------------------------

let mcpServersConfig: McpServerConfig[] = [];
let discoveryCollisions: NameCollision[] = [];
let renderListener: (() => void) | null = null;

export function getMcpServersConfig(): McpServerConfig[] {
  return mcpServersConfig;
}

export function setMcpServersConfig(v: McpServerConfig[]): void {
  mcpServersConfig = v;
  renderListener?.();
}

export function setDiscoveryCollisions(v: NameCollision[]): void {
  discoveryCollisions = v;
  renderListener?.();
}

// ---------------------------------------------------------------------------
// Init — wires the form handlers and exposes a render trigger that the
// Capabilities panel calls when the Connections sub-tab opens.
// ---------------------------------------------------------------------------

export interface McpConnectionsAPI {
  /** Re-render the server list. Capabilities calls on tab show. */
  render(): void;
}

export function initMcpConnections(ctx: DesktopContext): McpConnectionsAPI {
  const mcpServerList = document.getElementById("mcp-server-list") as HTMLDivElement;
  const mcpEmpty = document.getElementById("mcp-empty") as HTMLDivElement | null;
  const mcpAddToggle = document.getElementById("mcp-add-toggle") as HTMLButtonElement;
  const mcpAddForm = document.getElementById("mcp-add-form") as HTMLDivElement;
  const mcpTransport = document.getElementById("mcp-transport") as HTMLSelectElement;
  const mcpCommandField = document.getElementById("mcp-command-field") as HTMLDivElement;
  const mcpUrlField = document.getElementById("mcp-url-field") as HTMLDivElement;
  const mcpMotebitCheckbox = document.getElementById("mcp-motebit") as HTMLInputElement;
  const mcpPublicKeyField = document.getElementById("mcp-publickey-field") as HTMLDivElement;
  const mcpPublicKeyInput = document.getElementById("mcp-publickey") as HTMLInputElement;

  function renderMcpServerList(): void {
    mcpServerList.innerHTML = "";
    const servers = ctx.app.getMcpStatus();
    if (mcpServersConfig.length === 0) {
      if (mcpEmpty !== null) mcpEmpty.style.display = "";
      return;
    }
    if (mcpEmpty !== null) mcpEmpty.style.display = "none";
    for (const config of mcpServersConfig) {
      const status = servers.find((s) => s.name === config.name);
      const row = document.createElement("div");
      row.className = "mcp-server-row";

      const nameSpan = document.createElement("span");
      nameSpan.className = "mcp-server-name";
      nameSpan.textContent = config.name;
      row.appendChild(nameSpan);

      const transportBadge = document.createElement("span");
      transportBadge.className = "mcp-badge";
      transportBadge.textContent = config.transport;
      row.appendChild(transportBadge);

      if (config.source != null && config.source !== "") {
        const discoveredBadge = document.createElement("span");
        discoveredBadge.className = "mcp-badge discovered";
        discoveredBadge.textContent = "discovered";
        discoveredBadge.title = config.source;
        row.appendChild(discoveredBadge);
      }

      if (config.trusted === true) {
        const trustedBadge = document.createElement("span");
        trustedBadge.className = "mcp-badge trusted";
        trustedBadge.textContent = "trusted";
        row.appendChild(trustedBadge);
      }

      if (config.motebit === true) {
        const motebitBadge = document.createElement("span");
        motebitBadge.className = "mcp-badge motebit";
        motebitBadge.textContent = "motebit";
        if (config.motebitPublicKey) {
          motebitBadge.title = `Key: ${config.motebitPublicKey}`;
        }
        row.appendChild(motebitBadge);
      }

      const collision = discoveryCollisions.find((c) => c.name === config.name);
      if (collision) {
        const warnBadge = document.createElement("span");
        warnBadge.className = "mcp-badge collision";
        warnBadge.textContent = "collision";
        warnBadge.title = `Discovered different config from ${collision.discoveredSource} (${collision.discoveredCommand})`;
        row.appendChild(warnBadge);
      }

      const statusDot = document.createElement("span");
      statusDot.className = "mcp-status-dot" + (status?.connected === true ? " connected" : "");
      row.appendChild(statusDot);

      // Connect button for disconnected servers
      if (status?.connected !== true) {
        const connectBtn = document.createElement("button");
        connectBtn.className = "mcp-connect-btn";
        connectBtn.textContent = "Connect";
        connectBtn.addEventListener("click", () => {
          const appConfig = ctx.getConfig();
          if (appConfig?.invoke == null) return;
          const inv = appConfig.invoke;
          config.spawnApproved = true;
          // Persist spawnApproved so we don't re-prompt after restart
          void inv<string>("read_config")
            .then((raw) => {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              parsed.mcp_servers = mcpServersConfig;
              return inv("write_config", { json: JSON.stringify(parsed) });
            })
            .catch(() => {
              /* non-fatal */
            });
          void ctx.app
            .connectMcpServerViaTauri(config, inv)
            .then((status) => {
              if (status.manifestChanged === true) {
                const diff = status.manifestDiff;
                const parts = [`${config.name}: tools changed — trust revoked`];
                if (diff) {
                  if (diff.added.length) parts.push(`+${diff.added.length} added`);
                  if (diff.removed.length) parts.push(`-${diff.removed.length} removed`);
                }
                ctx.showToast(parts.join(", "));
              }
              // Persist updated manifest hash
              void inv<string>("read_config")
                .then((raw) => {
                  const parsed = JSON.parse(raw) as Record<string, unknown>;
                  parsed.mcp_servers = mcpServersConfig;
                  return inv("write_config", { json: JSON.stringify(parsed) });
                })
                .catch(() => {
                  /* non-fatal */
                });
              renderMcpServerList();
            })
            .catch(() => {
              renderMcpServerList();
            });
        });
        row.appendChild(connectBtn);
      }

      const removeBtn = document.createElement("button");
      removeBtn.className = "mcp-remove-btn";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        mcpServersConfig = mcpServersConfig.filter((s) => s.name !== config.name);
        void ctx.app.removeMcpServer(config.name);
        renderMcpServerList();
      });
      row.appendChild(removeBtn);
      mcpServerList.appendChild(row);
    }
  }

  renderListener = renderMcpServerList;

  // === Form handlers ===

  mcpAddToggle.addEventListener("click", () => {
    mcpAddForm.style.display = mcpAddForm.style.display === "none" ? "block" : "none";
  });

  mcpTransport.addEventListener("change", () => {
    mcpCommandField.style.display = mcpTransport.value === "stdio" ? "flex" : "none";
    mcpUrlField.style.display = mcpTransport.value === "http" ? "flex" : "none";
  });

  mcpMotebitCheckbox.addEventListener("change", () => {
    mcpPublicKeyField.style.display =
      mcpMotebitCheckbox.checked && mcpPublicKeyInput.value ? "flex" : "none";
  });

  document.getElementById("mcp-add-cancel")!.addEventListener("click", () => {
    mcpAddForm.style.display = "none";
  });

  document.getElementById("mcp-add-confirm")!.addEventListener("click", () => {
    const name = (document.getElementById("mcp-name") as HTMLInputElement).value.trim();
    if (!name) return;
    const transport = mcpTransport.value as "stdio" | "http";
    const command = (document.getElementById("mcp-command") as HTMLInputElement).value.trim();
    const url = (document.getElementById("mcp-url") as HTMLInputElement).value.trim();
    const trusted = (document.getElementById("mcp-trusted") as HTMLInputElement).checked;
    const motebit = mcpMotebitCheckbox.checked;

    const config: McpServerConfig = { name, transport, trusted };
    if (motebit) config.motebit = true;
    if (transport === "stdio" && command) {
      const parts = command.split(/\s+/);
      config.command = parts[0];
      config.args = parts.slice(1);
    } else if (transport === "http" && url) {
      config.url = url;
    }

    mcpServersConfig.push(config);
    renderMcpServerList();
    mcpAddForm.style.display = "none";
    (document.getElementById("mcp-name") as HTMLInputElement).value = "";
    (document.getElementById("mcp-command") as HTMLInputElement).value = "";
    (document.getElementById("mcp-url") as HTMLInputElement).value = "";
    (document.getElementById("mcp-trusted") as HTMLInputElement).checked = false;
    mcpMotebitCheckbox.checked = false;
    mcpPublicKeyField.style.display = "none";
    mcpPublicKeyInput.value = "";
  });

  return { render: renderMcpServerList };
}
