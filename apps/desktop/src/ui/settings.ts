import type { DesktopAIConfig, InvokeFn, McpServerConfig, PolicyConfig } from "../index";
import type { DesktopContext } from "../types";
import { addMessage } from "./chat";
import type { ColorPickerAPI } from "./color-picker";
import type { VoiceAPI } from "./voice";
import type { PairingAPI } from "./pairing";

// === DOM Refs ===

const settingsBackdrop = document.getElementById("settings-backdrop") as HTMLDivElement;
const settingsModal = document.getElementById("settings-modal") as HTMLDivElement;
const settingsProvider = document.getElementById("settings-provider") as HTMLSelectElement;
const settingsModel = document.getElementById("settings-model") as HTMLInputElement;
const settingsApiKey = document.getElementById("settings-apikey") as HTMLInputElement;
const settingsApiKeyToggle = document.getElementById("settings-apikey-toggle") as HTMLButtonElement;
const settingsOperatorMode = document.getElementById("settings-operator-mode") as HTMLInputElement;
const mcpServerList = document.getElementById("mcp-server-list") as HTMLDivElement;
const persistenceThreshold = document.getElementById("settings-persistence-threshold") as HTMLInputElement;
const persistenceThresholdValue = document.getElementById("persistence-threshold-value") as HTMLSpanElement;
const rejectSecrets = document.getElementById("settings-reject-secrets") as HTMLInputElement;
const maxCalls = document.getElementById("settings-max-calls") as HTMLInputElement;

const settingsWhisperApiKey = document.getElementById("settings-whisper-apikey") as HTMLInputElement;
const settingsWhisperApiKeyToggle = document.getElementById("settings-whisper-apikey-toggle") as HTMLButtonElement;
const settingsVoiceAutoSend = document.getElementById("settings-voice-autosend") as HTMLInputElement;
const settingsVoiceResponse = document.getElementById("settings-voice-response") as HTMLInputElement;
const settingsTtsVoice = document.getElementById("settings-tts-voice") as HTMLSelectElement;

// === PIN Dialog DOM Refs ===

const pinBackdrop = document.getElementById("pin-backdrop") as HTMLDivElement;
const pinInput = document.getElementById("pin-input") as HTMLInputElement;
const pinConfirmInput = document.getElementById("pin-confirm-input") as HTMLInputElement;
const pinConfirmText = document.getElementById("pin-confirm-text") as HTMLDivElement;
const pinHint = document.getElementById("pin-hint") as HTMLDivElement;
const pinError = document.getElementById("pin-error") as HTMLDivElement;
const pinTitle = document.getElementById("pin-title") as HTMLDivElement;

// === MCP Add Form DOM Refs ===

const mcpAddToggle = document.getElementById("mcp-add-toggle") as HTMLButtonElement;
const mcpAddForm = document.getElementById("mcp-add-form") as HTMLDivElement;
const mcpTransport = document.getElementById("mcp-transport") as HTMLSelectElement;
const mcpCommandField = document.getElementById("mcp-command-field") as HTMLDivElement;
const mcpUrlField = document.getElementById("mcp-url-field") as HTMLDivElement;

// === Settings State ===

let hasApiKeyInKeyring = false;
let hasWhisperKeyInKeyring = false;
let selectedApprovalPreset = "balanced";
let mcpServersConfig: McpServerConfig[] = [];
let pinMode: "setup" | "verify" | "reset" = "verify";

interface PendingSave {
  provider: DesktopAIConfig["provider"];
  model?: string;
  apiKey?: string;
  isTauri: boolean;
}
let pendingSettingsSave: PendingSave | null = null;

// === Approval Presets ===

const APPROVAL_PRESET_CONFIGS: Record<string, Partial<PolicyConfig>> = {
  cautious: { maxRiskLevel: 3, requireApprovalAbove: 0, denyAbove: 3 },
  balanced: { maxRiskLevel: 3, requireApprovalAbove: 1, denyAbove: 3 },
  autonomous: { maxRiskLevel: 4, requireApprovalAbove: 3, denyAbove: 4 },
};

// === Settings API ===

export interface SettingsAPI {
  open(): void;
  close(): void;
  getHasApiKeyInKeyring(): boolean;
  setHasApiKeyInKeyring(v: boolean): void;
  getHasWhisperKeyInKeyring(): boolean;
  setHasWhisperKeyInKeyring(v: boolean): void;
  getSelectedApprovalPreset(): string;
  setSelectedApprovalPreset(v: string): void;
  getMcpServersConfig(): McpServerConfig[];
  setMcpServersConfig(v: McpServerConfig[]): void;
  isPinDialogOpen(): boolean;
  closePinDialog(): void;
}

export interface SettingsDeps {
  colorPicker: ColorPickerAPI;
  voice: VoiceAPI;
  pairing: PairingAPI;
}

export function initSettings(ctx: DesktopContext, deps: SettingsDeps): SettingsAPI {
  const { colorPicker, voice, pairing } = deps;

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

  // === Approval Presets ===

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

  persistenceThreshold.addEventListener("input", () => {
    persistenceThresholdValue.textContent = parseFloat(persistenceThreshold.value).toFixed(2);
  });

  // === Identity Tab ===

  function populateIdentityTab(): void {
    const info = ctx.app.getIdentityInfo();
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
    void ctx.app.exportAllData().then(json => {
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

  // === MCP Server List ===

  function renderMcpServerList(): void {
    mcpServerList.innerHTML = "";
    const servers = ctx.app.getMcpStatus();
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
        void ctx.app.removeMcpServer(config.name);
        renderMcpServerList();
      });
      row.appendChild(removeBtn);
      mcpServerList.appendChild(row);
    }
  }

  // MCP add form
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

  // === Link Device (Device A) ===

  document.getElementById("settings-link-device")!.addEventListener("click", () => {
    const config = ctx.getConfig();
    if (!config?.isTauri || !config?.invoke) {
      addMessage("system", "Pairing requires Tauri (not available in dev mode)");
      return;
    }
    const syncUrl = config.syncUrl;
    if (!syncUrl) {
      addMessage("system", "No sync relay configured — set sync_url in config");
      return;
    }

    close();
    pairing.startLinkDevice(config.invoke, syncUrl);
  });

  // === Settings Open / Close ===

  function open(): void {
    const config = ctx.getConfig();
    if (config) {
      settingsProvider.value = config.provider;
      settingsModel.value = config.model || "";
    }
    settingsApiKey.value = "";
    settingsApiKey.type = "password";
    settingsApiKeyToggle.textContent = "Show";
    settingsApiKey.placeholder = hasApiKeyInKeyring ? "API key stored" : "sk-ant-...";

    settingsOperatorMode.checked = ctx.app.isOperatorMode;

    settingsWhisperApiKey.value = "";
    settingsWhisperApiKey.type = "password";
    settingsWhisperApiKeyToggle.textContent = "Show";
    settingsWhisperApiKey.placeholder = hasWhisperKeyInKeyring ? "API key stored" : "sk-...";
    settingsVoiceAutoSend.checked = voice.getVoiceAutoSend();
    settingsVoiceResponse.checked = voice.getVoiceResponseEnabled();
    settingsTtsVoice.value = voice.getTtsVoice();

    colorPicker.savePreviousState();
    colorPicker.buildColorSwatches();

    renderMcpServerList();

    selectApprovalPreset(selectedApprovalPreset);

    switchTab("appearance");

    settingsBackdrop.classList.add("open");
    settingsModal.classList.add("open");
  }

  function close(): void {
    settingsBackdrop.classList.remove("open");
    settingsModal.classList.remove("open");
  }

  function cancel(): void {
    colorPicker.restorePreviousState();
    close();
  }

  // === Save Settings ===

  async function saveSettings(): Promise<void> {
    const provider = settingsProvider.value as DesktopAIConfig["provider"];
    const model = settingsModel.value.trim() || undefined;
    const apiKey = settingsApiKey.value.trim() || undefined;
    const whisperApiKey = settingsWhisperApiKey.value.trim() || undefined;
    const isTauri = typeof window !== "undefined" && !!window.__TAURI__;

    voice.setVoiceAutoSend(settingsVoiceAutoSend.checked);
    voice.setVoiceResponseEnabled(settingsVoiceResponse.checked);
    voice.setTtsVoice(settingsTtsVoice.value);

    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");

      const customColor = colorPicker.getCustomInteriorColor();
      const configData: Record<string, unknown> = {
        default_provider: provider,
        interior_color_preset: colorPicker.getSelectedPreset(),
        ...(colorPicker.getSelectedPreset() === "custom" && customColor ? {
          custom_soul_color: { hue: colorPicker.getCustomHue(), saturation: colorPicker.getCustomSaturation(), tint: customColor.tint, glow: customColor.glow },
        } : {}),
        approval_preset: selectedApprovalPreset,
        mcp_servers: mcpServersConfig,
        memory_governance: {
          persistence_threshold: parseFloat(persistenceThreshold.value),
          reject_secrets: rejectSecrets.checked,
        },
        budget: {
          maxCallsPerTurn: parseInt(maxCalls.value, 10) || 10,
        },
        voice: {
          auto_send: voice.getVoiceAutoSend(),
          voice_response: voice.getVoiceResponseEnabled(),
          tts_voice: voice.getTtsVoice(),
        },
      };
      if (model) configData.default_model = model;
      await invoke("write_config", { json: JSON.stringify(configData) });

      if (apiKey) {
        await invoke("keyring_set", { key: "api_key", value: apiKey });
        hasApiKeyInKeyring = true;
      }

      if (whisperApiKey) {
        await invoke("keyring_set", { key: "whisper_api_key", value: whisperApiKey });
        hasWhisperKeyInKeyring = true;
      }

      voice.rebuildTtsProvider(invoke as InvokeFn);
    }

    const approvalConfig = APPROVAL_PRESET_CONFIGS[selectedApprovalPreset];
    if (approvalConfig) {
      ctx.app.updatePolicyConfig({
        ...approvalConfig,
        operatorMode: settingsOperatorMode.checked,
        budget: { maxCallsPerTurn: parseInt(maxCalls.value, 10) || 10 },
      });
    }
    ctx.app.updateMemoryGovernance({
      persistenceThreshold: parseFloat(persistenceThreshold.value),
      rejectSecrets: rejectSecrets.checked,
    });

    const wantsOperator = settingsOperatorMode.checked;
    if (wantsOperator && !ctx.app.isOperatorMode) {
      const result = await ctx.app.setOperatorMode(true);
      if (!result.success) {
        if (result.needsSetup) {
          showPinDialog("setup");
        } else {
          showPinDialog("verify");
        }
        pendingSettingsSave = { provider, model, apiKey, isTauri };
        return;
      }
    } else if (!wantsOperator && ctx.app.isOperatorMode) {
      await ctx.app.setOperatorMode(false);
    }

    await finishSaveSettings(provider, model, apiKey, isTauri);
  }

  async function finishSaveSettings(
    provider: DesktopAIConfig["provider"],
    model?: string,
    apiKey?: string,
    isTauri = false,
  ): Promise<void> {
    const currentConfig = ctx.getConfig();
    const newConfig: DesktopAIConfig = {
      provider,
      model,
      apiKey: apiKey || currentConfig?.apiKey,
      isTauri,
      invoke: currentConfig?.invoke,
    };
    ctx.setConfig(newConfig);

    if (!await ctx.app.initAI(newConfig)) {
      addMessage("system", "Settings saved — AI initialization failed (check API key)");
    }

    close();
  }

  // === PIN Dialog ===

  function showPinDialog(mode: "setup" | "verify" | "reset"): void {
    pinMode = mode;
    pinInput.value = "";
    pinConfirmInput.value = "";
    pinError.textContent = "";
    pinConfirmText.style.display = "none";
    pinConfirmText.textContent = "";
    pinHint.style.display = mode === "reset" ? "none" : "block";
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
    settingsOperatorMode.checked = ctx.app.isOperatorMode;
  }

  async function handlePinSubmit(): Promise<void> {
    pinError.textContent = "";

    if (pinMode === "reset") {
      try {
        await ctx.app.resetOperatorPin();
      } catch (err: unknown) {
        pinError.textContent = err instanceof Error ? err.message : String(err);
        return;
      }
      pinBackdrop.classList.remove("open");
      settingsOperatorMode.checked = false;
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
        await ctx.app.setupOperatorPin(pin);
      } catch (err: unknown) {
        pinError.textContent = err instanceof Error ? err.message : String(err);
        return;
      }
    }

    const result = await ctx.app.setOperatorMode(true, pin);
    if (!result.success) {
      pinError.textContent = result.error || "Failed to enable operator mode";
      return;
    }

    pinBackdrop.classList.remove("open");
    if (pendingSettingsSave) {
      const s = pendingSettingsSave;
      pendingSettingsSave = null;
      await finishSaveSettings(s.provider, s.model, s.apiKey, s.isTauri);
    }
  }

  // === Event Listeners ===

  document.getElementById("pin-cancel")!.addEventListener("click", closePinDialog);
  document.getElementById("pin-submit")!.addEventListener("click", () => { void handlePinSubmit(); });
  pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { void handlePinSubmit(); }
  });
  pinConfirmInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { void handlePinSubmit(); }
  });

  settingsOperatorMode.addEventListener("change", () => {
    if (settingsOperatorMode.checked && !ctx.app.isOperatorMode) {
      const resultP = ctx.app.setOperatorMode(true);
      void resultP.then((result) => {
        if (!result.success) {
          showPinDialog(result.needsSetup ? "setup" : "verify");
        }
      });
    }
  });

  document.getElementById("settings-reset-pin")!.addEventListener("click", () => {
    showPinDialog("reset");
  });

  settingsBackdrop.addEventListener("click", cancel);
  document.getElementById("settings-btn")!.addEventListener("click", open);
  document.getElementById("settings-cancel")!.addEventListener("click", cancel);
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
  settingsWhisperApiKeyToggle.addEventListener("click", () => {
    if (settingsWhisperApiKey.type === "password") {
      settingsWhisperApiKey.type = "text";
      settingsWhisperApiKeyToggle.textContent = "Hide";
    } else {
      settingsWhisperApiKey.type = "password";
      settingsWhisperApiKeyToggle.textContent = "Show";
    }
  });

  return {
    open,
    close,
    getHasApiKeyInKeyring() { return hasApiKeyInKeyring; },
    setHasApiKeyInKeyring(v: boolean) { hasApiKeyInKeyring = v; },
    getHasWhisperKeyInKeyring() { return hasWhisperKeyInKeyring; },
    setHasWhisperKeyInKeyring(v: boolean) { hasWhisperKeyInKeyring = v; },
    getSelectedApprovalPreset() { return selectedApprovalPreset; },
    setSelectedApprovalPreset(v: string) { selectedApprovalPreset = v; },
    getMcpServersConfig() { return mcpServersConfig; },
    setMcpServersConfig(v: McpServerConfig[]) { mcpServersConfig = v; },
    isPinDialogOpen() { return pinBackdrop.classList.contains("open"); },
    closePinDialog,
  };
}
