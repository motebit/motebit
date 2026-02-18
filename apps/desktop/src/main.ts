import { DesktopApp, COLOR_PRESETS, isSlashCommand, parseSlashCommand, type DesktopAIConfig, type InvokeFn, type McpServerConfig, type PolicyConfig, type PairingSession } from "./index";
import { stripTags } from "@motebit/ai-core";

const canvas = document.getElementById("motebit-canvas") as HTMLCanvasElement;
if (!canvas) {
  throw new Error("Canvas element #motebit-canvas not found");
}

const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;

const app = new DesktopApp();
let currentConfig: DesktopAIConfig | null = null;

// === Chat Helpers ===

const toolStatusElements = new Map<string, HTMLElement>();

function addMessage(role: "user" | "assistant" | "system", text: string): void {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function showToolStatus(name: string): void {
  const el = document.createElement("div");
  el.className = "tool-status";
  el.textContent = `${name}...`;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  toolStatusElements.set(name, el);
}

function completeToolStatus(name: string): void {
  const el = toolStatusElements.get(name);
  if (!el) return;
  el.textContent = `${name} done`;
  el.classList.add("done");
  setTimeout(() => {
    el.classList.add("fade-out");
    setTimeout(() => { el.remove(); toolStatusElements.delete(name); }, 500);
  }, 1000);
}

function showApprovalCard(name: string, args: Record<string, unknown>): void {
  const card = document.createElement("div");
  card.className = "approval-card";

  const toolDiv = document.createElement("div");
  toolDiv.className = "approval-tool";
  toolDiv.textContent = name;
  card.appendChild(toolDiv);

  const argsDiv = document.createElement("div");
  argsDiv.className = "approval-args";
  argsDiv.textContent = JSON.stringify(args).slice(0, 120);
  card.appendChild(argsDiv);

  const btns = document.createElement("div");
  btns.className = "approval-buttons";

  const allowBtn = document.createElement("button");
  allowBtn.className = "btn-allow";
  allowBtn.textContent = "Allow";

  const denyBtn = document.createElement("button");
  denyBtn.className = "btn-deny";
  denyBtn.textContent = "Deny";

  const disableButtons = (): void => {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
  };

  allowBtn.addEventListener("click", () => {
    disableButtons();
    void consumeApproval(true);
  });

  denyBtn.addEventListener("click", () => {
    disableButtons();
    void consumeApproval(false);
  });

  btns.appendChild(allowBtn);
  btns.appendChild(denyBtn);
  card.appendChild(btns);

  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function consumeApproval(approved: boolean): Promise<void> {
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble assistant";
  bubble.textContent = "";
  chatLog.appendChild(bubble);

  let accumulated = "";
  try {
    for await (const chunk of app.resumeAfterApproval(approved)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
        bubble.textContent = stripTags(accumulated);
        chatLog.scrollTop = chatLog.scrollHeight;
      } else if (chunk.type === "tool_status") {
        if (chunk.status === "calling") {
          showToolStatus(chunk.name);
        } else if (chunk.status === "done") {
          completeToolStatus(chunk.name);
        }
      } else if (chunk.type === "approval_request") {
        showApprovalCard(chunk.name, chunk.args);
      } else if (chunk.type === "injection_warning") {
        addMessage("system", `Warning: suspicious content detected in ${chunk.tool_name} results`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!bubble.textContent) {
      bubble.remove();
    }
    addMessage("system", `Error: ${msg}`);
  }
}

function handleSlashCommand(command: string, args: string): void {
  switch (command) {
    case "model":
      if (!args) {
        const current = app.currentModel ?? "none";
        addMessage("system", `Current model: ${current}`);
      } else {
        try {
          app.setModel(args);
          addMessage("system", `Model switched to: ${args}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          addMessage("system", `Error: ${msg}`);
        }
      }
      break;
    case "settings":
      openSettings();
      break;
    case "help":
      addMessage("system",
        "Available commands:\n" +
        "/model — show current model\n" +
        "/model <name> — switch model\n" +
        "/settings — open settings panel\n" +
        "/help — show this message"
      );
      break;
    default:
      addMessage("system", `Unknown command: /${command}`);
  }
}

async function handleSend(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text || app.isProcessing) return;

  chatInput.value = "";

  if (isSlashCommand(text)) {
    const { command, args } = parseSlashCommand(text);
    handleSlashCommand(command, args);
    return;
  }

  addMessage("user", text);

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble assistant";
  bubble.textContent = "";
  chatLog.appendChild(bubble);

  let accumulated = "";
  try {
    for await (const chunk of app.sendMessageStreaming(text)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
        bubble.textContent = stripTags(accumulated);
        chatLog.scrollTop = chatLog.scrollHeight;
      } else if (chunk.type === "tool_status") {
        if (chunk.status === "calling") {
          showToolStatus(chunk.name);
        } else if (chunk.status === "done") {
          completeToolStatus(chunk.name);
        }
      } else if (chunk.type === "approval_request") {
        showApprovalCard(chunk.name, chunk.args);
      } else if (chunk.type === "injection_warning") {
        addMessage("system", `Warning: suspicious content detected in ${chunk.tool_name} results`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!bubble.textContent) {
      bubble.remove();
    }
    addMessage("system", `Error: ${msg}`);
  }
}

// === Config Loading ===

async function loadDesktopConfig(): Promise<DesktopAIConfig> {
  const isTauri = typeof window !== "undefined" && !!window.__TAURI__;

  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke<string>("read_config");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const provider = (parsed.default_provider as DesktopAIConfig["provider"]) || "ollama";
    const model = (parsed.default_model as string) || undefined;

    // Try keyring first, fall back to config file
    let apiKey: string | undefined;
    try {
      const keyringVal = await invoke<string | null>("keyring_get", { key: "api_key" });
      apiKey = keyringVal ?? undefined;
    } catch {
      // Keyring unavailable — fall through
    }
    if (!apiKey) {
      apiKey = (parsed.api_key as string) || undefined;
    }

    // Sync relay config (optional)
    const syncUrl = (parsed.sync_url as string) || undefined;
    let syncMasterToken: string | undefined;
    if (syncUrl) {
      try {
        const keyringVal = await invoke<string | null>("keyring_get", { key: "sync_master_token" });
        syncMasterToken = keyringVal ?? undefined;
      } catch {
        // Keyring unavailable
      }
    }

    return { provider, model, apiKey, isTauri: true, invoke: invoke as InvokeFn, syncUrl, syncMasterToken };
  }

  // Vite dev mode — read from env vars
  const provider = (import.meta.env.VITE_AI_PROVIDER as DesktopAIConfig["provider"]) || "ollama";
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY || undefined;

  return { provider, apiKey, isTauri: false };
}

// === Settings Modal ===

const settingsBackdrop = document.getElementById("settings-backdrop") as HTMLDivElement;
const settingsModal = document.getElementById("settings-modal") as HTMLDivElement;
const settingsProvider = document.getElementById("settings-provider") as HTMLSelectElement;
const settingsModel = document.getElementById("settings-model") as HTMLInputElement;
const settingsApiKey = document.getElementById("settings-apikey") as HTMLInputElement;
const settingsApiKeyToggle = document.getElementById("settings-apikey-toggle") as HTMLButtonElement;
const settingsOperatorMode = document.getElementById("settings-operator-mode") as HTMLInputElement;
const colorPresetGrid = document.getElementById("color-preset-grid") as HTMLDivElement;
const mcpServerList = document.getElementById("mcp-server-list") as HTMLDivElement;
const persistenceThreshold = document.getElementById("settings-persistence-threshold") as HTMLInputElement;
const persistenceThresholdValue = document.getElementById("persistence-threshold-value") as HTMLSpanElement;
const rejectSecrets = document.getElementById("settings-reject-secrets") as HTMLInputElement;
const maxCalls = document.getElementById("settings-max-calls") as HTMLInputElement;

// Settings state
let selectedColorPreset = "borosilicate";
let previousColorPreset = "borosilicate";
let selectedApprovalPreset = "balanced";
let mcpServersConfig: McpServerConfig[] = [];
let hasApiKeyInKeyring = false;

// === Tab Switching ===

function switchTab(tabName: string): void {
  document.querySelectorAll(".settings-tab").forEach(tab => {
    tab.classList.toggle("active", (tab as HTMLElement).dataset.tab === tabName);
  });
  document.querySelectorAll(".settings-pane").forEach(pane => {
    pane.classList.toggle("active", pane.id === `pane-${tabName}`);
  });
  if (tabName === "identity") populateIdentityTab();
}

document.querySelectorAll(".settings-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    const name = (tab as HTMLElement).dataset.tab;
    if (name) switchTab(name);
  });
});

// === Color Presets ===

function buildColorSwatches(): void {
  colorPresetGrid.innerHTML = "";
  for (const [name, preset] of Object.entries(COLOR_PRESETS)) {
    const btn = document.createElement("button");
    btn.className = "color-swatch" + (name === selectedColorPreset ? " selected" : "");
    btn.dataset.preset = name;
    const t = preset.tint;
    const g = preset.glow;
    btn.style.background = `radial-gradient(circle at 40% 40%, rgba(${Math.round(g[0] * 255)},${Math.round(g[1] * 255)},${Math.round(g[2] * 255)},0.6), rgba(${Math.round(t[0] * 200)},${Math.round(t[1] * 200)},${Math.round(t[2] * 200)},0.8))`;
    const label = document.createElement("span");
    label.className = "swatch-name";
    label.textContent = name.charAt(0).toUpperCase() + name.slice(1);
    btn.appendChild(label);
    btn.addEventListener("click", () => selectColorPreset(name));
    colorPresetGrid.appendChild(btn);
  }
}

function selectColorPreset(name: string): void {
  selectedColorPreset = name;
  document.querySelectorAll(".color-swatch").forEach(el => {
    el.classList.toggle("selected", (el as HTMLElement).dataset.preset === name);
  });
  app.setInteriorColor(name);
}

// === MCP Server List ===

function renderMcpServerList(): void {
  mcpServerList.innerHTML = "";
  const servers = app.getMcpStatus();
  if (mcpServersConfig.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:12px;color:rgba(255,255,255,0.3);padding:8px 0;";
    empty.textContent = "No MCP servers configured";
    mcpServerList.appendChild(empty);
    return;
  }
  for (const config of mcpServersConfig) {
    const status = servers.find(s => s.name === config.name);
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

    if (config.trusted) {
      const trustedBadge = document.createElement("span");
      trustedBadge.className = "mcp-badge trusted";
      trustedBadge.textContent = "trusted";
      row.appendChild(trustedBadge);
    }

    const statusDot = document.createElement("span");
    statusDot.className = "mcp-status-dot" + (status?.connected ? " connected" : "");
    row.appendChild(statusDot);

    const removeBtn = document.createElement("button");
    removeBtn.className = "mcp-remove-btn";
    removeBtn.textContent = "\u00d7";
    removeBtn.addEventListener("click", () => {
      mcpServersConfig = mcpServersConfig.filter(s => s.name !== config.name);
      void app.removeMcpServer(config.name);
      renderMcpServerList();
    });
    row.appendChild(removeBtn);
    mcpServerList.appendChild(row);
  }
}

// MCP add form
const mcpAddToggle = document.getElementById("mcp-add-toggle") as HTMLButtonElement;
const mcpAddForm = document.getElementById("mcp-add-form") as HTMLDivElement;
const mcpTransport = document.getElementById("mcp-transport") as HTMLSelectElement;
const mcpCommandField = document.getElementById("mcp-command-field") as HTMLDivElement;
const mcpUrlField = document.getElementById("mcp-url-field") as HTMLDivElement;

mcpAddToggle.addEventListener("click", () => {
  mcpAddForm.style.display = mcpAddForm.style.display === "none" ? "block" : "none";
});

mcpTransport.addEventListener("change", () => {
  mcpCommandField.style.display = mcpTransport.value === "stdio" ? "flex" : "none";
  mcpUrlField.style.display = mcpTransport.value === "http" ? "flex" : "none";
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

  const config: McpServerConfig = { name, transport, trusted };
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
});

// === Approval Presets ===

const APPROVAL_PRESET_CONFIGS: Record<string, Partial<PolicyConfig>> = {
  cautious: { maxRiskLevel: 3, requireApprovalAbove: 0, denyAbove: 3 },
  balanced: { maxRiskLevel: 3, requireApprovalAbove: 1, denyAbove: 3 },
  autonomous: { maxRiskLevel: 4, requireApprovalAbove: 3, denyAbove: 4 },
};

function selectApprovalPreset(preset: string): void {
  selectedApprovalPreset = preset;
  document.querySelectorAll(".preset-option").forEach(el => {
    const match = (el as HTMLElement).dataset.preset === preset;
    el.classList.toggle("selected", match);
    const radio = el.querySelector("input[type=radio]") as HTMLInputElement;
    if (radio) radio.checked = match;
  });
}

document.querySelectorAll(".preset-option").forEach(el => {
  el.addEventListener("click", () => {
    const preset = (el as HTMLElement).dataset.preset;
    if (preset) selectApprovalPreset(preset);
  });
});

// Persistence threshold live display
persistenceThreshold.addEventListener("input", () => {
  persistenceThresholdValue.textContent = parseFloat(persistenceThreshold.value).toFixed(2);
});

// === Identity Tab ===

function populateIdentityTab(): void {
  const info = app.getIdentityInfo();
  (document.getElementById("identity-motebit-id") as HTMLElement).textContent = info.motebitId || "-";
  (document.getElementById("identity-device-id") as HTMLElement).textContent = info.deviceId || "-";
  (document.getElementById("identity-public-key") as HTMLElement).textContent =
    info.publicKey ? info.publicKey.slice(0, 16) + "..." : "-";
  const syncBadge = document.getElementById("identity-sync-status") as HTMLElement;
  syncBadge.className = "sync-badge disconnected";
  syncBadge.textContent = "Not connected";
}

// Copy buttons
document.querySelectorAll(".copy-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const targetId = (btn as HTMLElement).dataset.copy;
    if (!targetId) return;
    const el = document.getElementById(targetId);
    if (el) {
      void navigator.clipboard.writeText(el.textContent || "").then(() => {
        const prev = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = prev; }, 1500);
      });
    }
  });
});

// Export button
document.getElementById("settings-export")!.addEventListener("click", () => {
  void app.exportAllData().then(json => {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `motebit-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

// Documentation button
document.getElementById("settings-docs")!.addEventListener("click", () => {
  window.open("https://docs.motebit.dev", "_blank");
});

// === Pairing Dialog ===

const pairingBackdrop = document.getElementById("pairing-backdrop") as HTMLDivElement;
const pairingTitle = document.getElementById("pairing-title") as HTMLDivElement;
const pairingCodeDisplay = document.getElementById("pairing-code-display") as HTMLDivElement;
const pairingInputRow = document.getElementById("pairing-input-row") as HTMLDivElement;
const pairingCodeInput = document.getElementById("pairing-code-input") as HTMLInputElement;
const pairingClaimInfo = document.getElementById("pairing-claim-info") as HTMLDivElement;
const pairingStatus = document.getElementById("pairing-status") as HTMLDivElement;
const pairingActions = document.getElementById("pairing-actions") as HTMLDivElement;

let pairingPollTimer: ReturnType<typeof setInterval> | null = null;

function closePairingDialog(): void {
  pairingBackdrop.classList.remove("open");
  if (pairingPollTimer) {
    clearInterval(pairingPollTimer);
    pairingPollTimer = null;
  }
}

function resetPairingDialog(): void {
  pairingCodeDisplay.style.display = "none";
  pairingCodeDisplay.textContent = "";
  pairingInputRow.style.display = "none";
  pairingCodeInput.value = "";
  pairingClaimInfo.style.display = "none";
  pairingClaimInfo.textContent = "";
  pairingStatus.textContent = "";
  pairingActions.innerHTML = '<button class="pairing-btn-cancel" id="pairing-cancel">Cancel</button>';
  document.getElementById("pairing-cancel")!.addEventListener("click", closePairingDialog);
}

// Device A: "Link Another Device" from settings
document.getElementById("settings-link-device")!.addEventListener("click", () => {
  if (!currentConfig?.isTauri || !currentConfig?.invoke) {
    addMessage("system", "Pairing requires Tauri (not available in dev mode)");
    return;
  }
  const syncUrl = currentConfig.syncUrl;
  if (!syncUrl) {
    addMessage("system", "No sync relay configured — set sync_url in config");
    return;
  }

  closeSettings();
  resetPairingDialog();
  pairingTitle.textContent = "Link Another Device";
  pairingStatus.textContent = "Generating code...";
  pairingBackdrop.classList.add("open");

  const invoke = currentConfig.invoke;

  void (async () => {
    try {
      const { pairingCode, pairingId } = await app.initiatePairing(invoke, syncUrl);


      pairingCodeDisplay.textContent = pairingCode;
      pairingCodeDisplay.style.display = "block";
      pairingStatus.textContent = "Enter this code on the other device";

      // Poll for claim every 2s
      pairingPollTimer = setInterval(() => {
        void pollForClaim(invoke, syncUrl, pairingId);
      }, 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      pairingStatus.textContent = `Error: ${msg}`;
    }
  })();
});

async function pollForClaim(invoke: InvokeFn, syncUrl: string, pairingId: string): Promise<void> {
  try {
    const session: PairingSession = await app.getPairingSession(invoke, syncUrl, pairingId);

    if (session.status === "claimed") {
      // Stop polling, show approve/deny
      if (pairingPollTimer) {
        clearInterval(pairingPollTimer);
        pairingPollTimer = null;
      }

      pairingCodeDisplay.style.display = "none";
      pairingClaimInfo.style.display = "block";
      pairingClaimInfo.textContent = `"${session.claiming_device_name}" wants to join`;
      pairingStatus.textContent = "";

      pairingActions.innerHTML = "";
      const denyBtn = document.createElement("button");
      denyBtn.className = "pairing-btn-deny";
      denyBtn.textContent = "Deny";
      denyBtn.addEventListener("click", () => {
        void (async () => {
          try {
            await app.denyPairing(invoke, syncUrl, pairingId);
            closePairingDialog();
            addMessage("system", "Pairing denied");
          } catch (err: unknown) {
            pairingStatus.textContent = err instanceof Error ? err.message : String(err);
          }
        })();
      });

      const approveBtn = document.createElement("button");
      approveBtn.className = "pairing-btn-approve";
      approveBtn.textContent = "Approve";
      approveBtn.addEventListener("click", () => {
        void (async () => {
          try {
            approveBtn.disabled = true;
            denyBtn.disabled = true;
            pairingStatus.textContent = "Approving...";
            const result = await app.approvePairing(invoke, syncUrl, pairingId);
            closePairingDialog();
            addMessage("system", `Device linked (${result.deviceId.slice(0, 8)}...)`);
          } catch (err: unknown) {
            pairingStatus.textContent = err instanceof Error ? err.message : String(err);
            approveBtn.disabled = false;
            denyBtn.disabled = false;
          }
        })();
      });

      pairingActions.appendChild(denyBtn);
      pairingActions.appendChild(approveBtn);
    }
  } catch {
    // Polling errors are non-fatal
  }
}

// Device B: "I have an existing motebit" from welcome
function startPairingClaim(invoke: InvokeFn, syncUrl: string): void {
  resetPairingDialog();
  pairingTitle.textContent = "Link Existing Motebit";
  pairingInputRow.style.display = "block";
  pairingStatus.textContent = "Enter the code from your other device";

  const submitBtn = document.createElement("button");
  submitBtn.className = "pairing-btn-approve";
  submitBtn.textContent = "Submit";

  pairingActions.innerHTML = "";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "pairing-btn-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closePairingDialog);

  submitBtn.addEventListener("click", () => {
    const code = pairingCodeInput.value.trim().toUpperCase();
    if (code.length !== 6) {
      pairingStatus.textContent = "Code must be 6 characters";
      return;
    }
    void handlePairingClaim(invoke, syncUrl, code);
  });

  pairingCodeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitBtn.click();
  });

  pairingActions.appendChild(cancelBtn);
  pairingActions.appendChild(submitBtn);
  pairingBackdrop.classList.add("open");
  pairingCodeInput.focus();
}

async function handlePairingClaim(invoke: InvokeFn, syncUrl: string, code: string): Promise<void> {
  pairingStatus.textContent = "Claiming...";
  pairingInputRow.style.display = "none";

  try {
    const { pairingId } = await app.claimPairing(syncUrl, code);
    pairingStatus.textContent = "Waiting for approval...";

    // Remove submit button, keep only cancel
    pairingActions.innerHTML = "";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "pairing-btn-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", closePairingDialog);
    pairingActions.appendChild(cancelBtn);

    // Poll for approval every 2s
    pairingPollTimer = setInterval(() => {
      void (async () => {
        try {
          const status = await app.pollPairingStatus(syncUrl, pairingId);
          if (status.status === "approved" && status.device_id && status.motebit_id) {
            if (pairingPollTimer) {
              clearInterval(pairingPollTimer);
              pairingPollTimer = null;
            }
            await app.completePairing(invoke, {
              motebitId: status.motebit_id,
              deviceId: status.device_id,
              deviceToken: status.device_token || "",
            });
            closePairingDialog();
            // Close welcome if still open
            const welcomeBackdrop = document.getElementById("welcome-backdrop") as HTMLDivElement;
            welcomeBackdrop.classList.remove("open");
            addMessage("system", "Linked to existing motebit");
          } else if (status.status === "denied") {
            if (pairingPollTimer) {
              clearInterval(pairingPollTimer);
              pairingPollTimer = null;
            }
            pairingStatus.textContent = "Pairing was denied by the other device";
          }
        } catch {
          // Polling errors are non-fatal
        }
      })();
    }, 2000);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    pairingStatus.textContent = `Error: ${msg}`;
    pairingInputRow.style.display = "block";
  }
}

document.getElementById("pairing-cancel")!.addEventListener("click", closePairingDialog);

// === Settings Open / Close ===

function openSettings(): void {
  // Intelligence tab: populate from current config
  if (currentConfig) {
    settingsProvider.value = currentConfig.provider;
    settingsModel.value = currentConfig.model || "";
  }
  // API key: never rehydrate into DOM
  settingsApiKey.value = "";
  settingsApiKey.type = "password";
  settingsApiKeyToggle.textContent = "Show";
  settingsApiKey.placeholder = hasApiKeyInKeyring ? "API key stored" : "sk-ant-...";

  // Operator mode
  settingsOperatorMode.checked = app.isOperatorMode;

  // Appearance: track previous for cancel
  previousColorPreset = selectedColorPreset;
  buildColorSwatches();

  // MCP
  renderMcpServerList();

  // Governance
  selectApprovalPreset(selectedApprovalPreset);

  // Start on first tab
  switchTab("appearance");

  settingsBackdrop.classList.add("open");
  settingsModal.classList.add("open");
}

function closeSettings(): void {
  settingsBackdrop.classList.remove("open");
  settingsModal.classList.remove("open");
}

function cancelSettings(): void {
  // Restore previous color on cancel
  if (selectedColorPreset !== previousColorPreset) {
    selectedColorPreset = previousColorPreset;
    app.setInteriorColor(previousColorPreset);
  }
  closeSettings();
}

// === Save Settings ===

async function saveSettings(): Promise<void> {
  const provider = settingsProvider.value as DesktopAIConfig["provider"];
  const model = settingsModel.value.trim() || undefined;
  const apiKey = settingsApiKey.value.trim() || undefined;
  const isTauri = typeof window !== "undefined" && !!window.__TAURI__;

  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");

    // Build config object with all settings
    const configData: Record<string, unknown> = {
      default_provider: provider,
      interior_color_preset: selectedColorPreset,
      approval_preset: selectedApprovalPreset,
      mcp_servers: mcpServersConfig,
      memory_governance: {
        persistence_threshold: parseFloat(persistenceThreshold.value),
        reject_secrets: rejectSecrets.checked,
      },
      budget: {
        maxCallsPerTurn: parseInt(maxCalls.value, 10) || 10,
      },
    };
    if (model) configData.default_model = model;
    await invoke("write_config", { json: JSON.stringify(configData) });

    // API key goes to keyring exclusively
    if (apiKey) {
      await invoke("keyring_set", { key: "api_key", value: apiKey });
      hasApiKeyInKeyring = true;
    }
  }

  // Apply governance settings
  const approvalConfig = APPROVAL_PRESET_CONFIGS[selectedApprovalPreset];
  if (approvalConfig) {
    app.updatePolicyConfig({
      ...approvalConfig,
      operatorMode: settingsOperatorMode.checked,
      budget: { maxCallsPerTurn: parseInt(maxCalls.value, 10) || 10 },
    });
  }
  app.updateMemoryGovernance({
    persistenceThreshold: parseFloat(persistenceThreshold.value),
    rejectSecrets: rejectSecrets.checked,
  });

  // Apply operator mode (with PIN flow if enabling)
  const wantsOperator = settingsOperatorMode.checked;
  if (wantsOperator && !app.isOperatorMode) {
    const result = await app.setOperatorMode(true);
    if (!result.success) {
      if (result.needsSetup) {
        showPinDialog("setup");
      } else {
        showPinDialog("verify");
      }
      pendingSettingsSave = { provider, model, apiKey, isTauri };
      return;
    }
  } else if (!wantsOperator && app.isOperatorMode) {
    await app.setOperatorMode(false);
  }

  finishSaveSettings(provider, model, apiKey, isTauri);
}

interface PendingSave {
  provider: DesktopAIConfig["provider"];
  model?: string;
  apiKey?: string;
  isTauri: boolean;
}
let pendingSettingsSave: PendingSave | null = null;

function finishSaveSettings(
  provider: DesktopAIConfig["provider"],
  model?: string,
  apiKey?: string,
  isTauri = false,
): void {
  const newConfig: DesktopAIConfig = {
    provider,
    model,
    apiKey: apiKey || currentConfig?.apiKey,
    isTauri,
    invoke: currentConfig?.invoke,
  };
  currentConfig = newConfig;

  if (app.initAI(newConfig)) {
    const label = provider === "ollama" ? "Ollama" : "Anthropic";
    addMessage("system", `Settings saved — AI reconnected (${label})`);
  } else {
    addMessage("system", "Settings saved — AI initialization failed (check API key)");
  }

  closeSettings();
}

// === PIN Dialog ===

const pinBackdrop = document.getElementById("pin-backdrop") as HTMLDivElement;
const pinInput = document.getElementById("pin-input") as HTMLInputElement;
const pinConfirmInput = document.getElementById("pin-confirm-input") as HTMLInputElement;
const pinConfirmText = document.getElementById("pin-confirm-text") as HTMLDivElement;
const pinError = document.getElementById("pin-error") as HTMLDivElement;
const pinTitle = document.getElementById("pin-title") as HTMLDivElement;
let pinMode: "setup" | "verify" | "reset" = "verify";

function showPinDialog(mode: "setup" | "verify" | "reset"): void {
  pinMode = mode;
  pinInput.value = "";
  pinConfirmInput.value = "";
  pinError.textContent = "";
  pinConfirmText.style.display = "none";
  pinConfirmText.textContent = "";
  if (mode === "setup") {
    pinTitle.textContent = "Set Operator PIN";
    pinInput.style.display = "block";
    pinConfirmInput.style.display = "block";
    (document.getElementById("pin-submit") as HTMLButtonElement).textContent = "OK";
  } else if (mode === "reset") {
    pinTitle.textContent = "Reset Operator PIN?";
    pinInput.style.display = "none";
    pinConfirmInput.style.display = "none";
    pinConfirmText.style.display = "block";
    pinConfirmText.textContent = "This will clear your PIN and disable operator mode.";
    (document.getElementById("pin-submit") as HTMLButtonElement).textContent = "Reset";
  } else {
    pinTitle.textContent = "Enter Operator PIN";
    pinInput.style.display = "block";
    pinConfirmInput.style.display = "none";
    (document.getElementById("pin-submit") as HTMLButtonElement).textContent = "OK";
  }
  pinBackdrop.classList.add("open");
  if (mode !== "reset") pinInput.focus();
}

function closePinDialog(): void {
  pinBackdrop.classList.remove("open");
  pinInput.value = "";
  pinConfirmInput.value = "";
  pinError.textContent = "";
  settingsOperatorMode.checked = app.isOperatorMode;
}

async function handlePinSubmit(): Promise<void> {
  pinError.textContent = "";

  if (pinMode === "reset") {
    try {
      await app.resetOperatorPin();
    } catch (err: unknown) {
      pinError.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    pinBackdrop.classList.remove("open");
    settingsOperatorMode.checked = false;
    addMessage("system", "Operator PIN reset");
    return;
  }

  const pin = pinInput.value.trim();

  if (!/^\d{4,6}$/.test(pin)) {
    pinError.textContent = "PIN must be 4-6 digits";
    return;
  }

  if (pinMode === "setup") {
    const confirm = pinConfirmInput.value.trim();
    if (pin !== confirm) {
      pinError.textContent = "PINs do not match";
      return;
    }
    try {
      await app.setupOperatorPin(pin);
    } catch (err: unknown) {
      pinError.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
  }

  const result = await app.setOperatorMode(true, pin);
  if (!result.success) {
    pinError.textContent = result.error || "Failed to enable operator mode";
    return;
  }

  pinBackdrop.classList.remove("open");
  if (pendingSettingsSave) {
    const s = pendingSettingsSave;
    pendingSettingsSave = null;
    finishSaveSettings(s.provider, s.model, s.apiKey, s.isTauri);
  }
}

document.getElementById("pin-cancel")!.addEventListener("click", closePinDialog);
document.getElementById("pin-submit")!.addEventListener("click", () => { void handlePinSubmit(); });
pinInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { void handlePinSubmit(); }
});
pinConfirmInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { void handlePinSubmit(); }
});

// Reset PIN button
document.getElementById("settings-reset-pin")!.addEventListener("click", () => {
  showPinDialog("reset");
});

// Settings event listeners
settingsBackdrop.addEventListener("click", cancelSettings);
document.getElementById("settings-btn")!.addEventListener("click", openSettings);
document.getElementById("settings-cancel")!.addEventListener("click", cancelSettings);
document.getElementById("settings-save")!.addEventListener("click", () => {
  void saveSettings();
});
settingsApiKeyToggle.addEventListener("click", () => {
  if (settingsApiKey.type === "password") {
    settingsApiKey.type = "text";
    settingsApiKeyToggle.textContent = "Hide";
  } else {
    settingsApiKey.type = "password";
    settingsApiKeyToggle.textContent = "Show";
  }
});

// Escape key closes settings
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (pinBackdrop.classList.contains("open")) {
      closePinDialog();
    } else if (settingsModal.classList.contains("open")) {
      cancelSettings();
    }
  }
});

// === Bootstrap ===

async function bootstrap(): Promise<void> {
  await app.init(canvas);
  app.start();

  // Resize handler
  const onResize = (): void => {
    app.resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", onResize);
  onResize();

  // Animation loop
  let lastTime = 0;
  const loop = (timestamp: number): void => {
    const time = timestamp / 1000;
    const deltaTime = lastTime === 0 ? 1 / 60 : time - lastTime;
    lastTime = time;

    app.renderFrame(deltaTime, time);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // Identity bootstrap (Tauri only)
  const config = await loadDesktopConfig();
  currentConfig = config;

  const welcomeBackdrop = document.getElementById("welcome-backdrop") as HTMLDivElement;

  if (config.isTauri && config.invoke) {
    const invoke = config.invoke;
    const raw = await invoke<string>("read_config");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (parsed.motebit_id) {
      // Returning user — skip welcome, bootstrap directly
      welcomeBackdrop.classList.remove("open");
      try {
        await app.bootstrap(invoke);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        addMessage("system", `Identity bootstrap failed: ${msg}`);
      }
    } else {
      // First launch — wait for consent or link existing
      const action = await new Promise<"create" | "link">((resolve) => {
        document.getElementById("welcome-start")!.addEventListener("click", () => resolve("create"));
        document.getElementById("welcome-link-existing")!.addEventListener("click", () => resolve("link"));
      });

      if (action === "link") {
        // Need sync URL for pairing
        const linkSyncUrl = (parsed.sync_url as string) || "";
        if (!linkSyncUrl) {
          welcomeBackdrop.classList.remove("open");
          addMessage("system", "No sync relay configured — set sync_url in config to link devices");
          // Fall through to create identity
          try {
            const result = await app.bootstrap(invoke);
            if (result.isFirstLaunch) {
              addMessage("system", "Your mote has been created");
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            addMessage("system", `Identity bootstrap failed: ${msg}`);
          }
        } else {
          // Bootstrap to generate keypair, then start pairing claim
          try {
            await app.bootstrap(invoke);
          } catch {
            // Non-fatal — we just need the keypair
          }
          startPairingClaim(invoke, linkSyncUrl);
          // Don't close welcome backdrop yet — pairing dialog sits on top
          // The completePairing flow will close it
        }
      } else {
        welcomeBackdrop.classList.remove("open");

        try {
          const result = await app.bootstrap(invoke);
          if (result.isFirstLaunch) {
            addMessage("system", "Your mote has been created");
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          addMessage("system", `Identity bootstrap failed: ${msg}`);
        }

        // Sync relay registration (if configured)
        if (config.syncUrl && config.syncMasterToken) {
          try {
            await app.registerWithRelay(invoke, config.syncUrl, config.syncMasterToken);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            addMessage("system", `Sync relay registration failed: ${msg}`);
          }
        }
      }
    }

    // Load persisted settings from config
    if (typeof parsed.interior_color_preset === "string" && COLOR_PRESETS[parsed.interior_color_preset]) {
      selectedColorPreset = parsed.interior_color_preset;
      app.setInteriorColor(selectedColorPreset);
    }
    if (typeof parsed.approval_preset === "string") {
      selectedApprovalPreset = parsed.approval_preset;
    }
    if (Array.isArray(parsed.mcp_servers)) {
      mcpServersConfig = parsed.mcp_servers as McpServerConfig[];
    }
    if (parsed.memory_governance && typeof parsed.memory_governance === "object") {
      const mg = parsed.memory_governance as Record<string, unknown>;
      if (typeof mg.persistence_threshold === "number") {
        persistenceThreshold.value = String(mg.persistence_threshold);
        persistenceThresholdValue.textContent = mg.persistence_threshold.toFixed(2);
      }
      if (typeof mg.reject_secrets === "boolean") {
        rejectSecrets.checked = mg.reject_secrets;
      }
    }
    if (parsed.budget && typeof parsed.budget === "object") {
      const b = parsed.budget as Record<string, unknown>;
      if (typeof b.maxCallsPerTurn === "number") {
        maxCalls.value = String(b.maxCallsPerTurn);
      }
    }

    // Check if API key exists in keyring (for placeholder display)
    try {
      const keyVal = await invoke<string | null>("keyring_get", { key: "api_key" });
      hasApiKeyInKeyring = !!keyVal;
    } catch {
      // Keyring unavailable
    }
  } else {
    // Non-Tauri (dev mode) — no identity bootstrap
    welcomeBackdrop.classList.remove("open");
  }

  // AI init
  if (app.initAI(config)) {
    const label = config.provider === "ollama" ? "Ollama" : "Anthropic";
    addMessage("system", `AI connected (${label})`);
  } else {
    if (config.provider === "anthropic") {
      addMessage("system", "No API key — set VITE_ANTHROPIC_API_KEY in .env or api_key in ~/.motebit/config.json");
    } else {
      addMessage("system", "AI initialization failed");
    }
  }

  // Chat input
  chatInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  });
}

bootstrap().catch((err: unknown) => {
  console.error("Motebit bootstrap failed:", err);
});
