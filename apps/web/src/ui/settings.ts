import type { WebContext } from "../types";
import type { ProviderConfig, ProviderType, GovernanceConfig, VoiceConfig } from "../storage";
import {
  saveProviderConfig,
  saveSoulColor,
  saveGovernanceConfig,
  loadGovernanceConfig,
  saveVoiceConfig,
  loadVoiceConfig,
} from "../storage";
import { detectOllamaModels, checkWebGPU, WebLLMProvider, DEFAULT_OLLAMA_URL } from "../providers";
import { setTTSVoice } from "./chat";
import { hexPublicKeyToDidKey } from "@motebit/crypto";
import type { ColorPickerAPI } from "./color-picker";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_GOOGLE_MODEL } from "@motebit/sdk";
import { PROXY_BASE_URL } from "../providers";

// === Live Model Discovery ===

let modelFetchTimer: ReturnType<typeof setTimeout> | undefined;

function fetchModelsForProvider(
  provider: "anthropic" | "openai" | "google",
  apiKey: string,
  datalistId: string,
): void {
  clearTimeout(modelFetchTimer);
  modelFetchTimer = setTimeout(
    () =>
      void (async () => {
        if (!apiKey || apiKey.length < 10) return;
        try {
          const res = await fetch(`${PROXY_BASE_URL}/v1/models?provider=${provider}`, {
            headers: { "x-api-key": apiKey },
          });
          const json = (await res.json()) as {
            ok?: boolean;
            models?: Array<{ id: string; name: string }>;
          };
          if (!json.ok || !json.models) return;
          const datalist = document.getElementById(datalistId);
          if (!datalist) return;
          datalist.innerHTML = json.models
            .map((m) => `<option value="${m.id}">${m.name}</option>`)
            .join("");
        } catch {
          // Silent — datalist stays with existing options
        }
      })(),
    500,
  );
}

// === DOM Refs ===

const settingsBackdrop = document.getElementById("settings-backdrop") as HTMLDivElement;
const settingsModal = document.getElementById("settings-modal") as HTMLDivElement;
const connectPrompt = document.getElementById("connect-prompt") as HTMLDivElement;
const modelIndicator = document.getElementById("model-indicator") as HTMLDivElement;

// Identity fields
const identityMotebitId = document.getElementById("identity-motebit-id") as HTMLDivElement;
const identityDeviceId = document.getElementById("identity-device-id") as HTMLDivElement;
const identityDid = document.getElementById("identity-did") as HTMLDivElement;
const identityPublicKey = document.getElementById("identity-public-key") as HTMLDivElement;

// === Provider Tab DOM ===
const providerTabs = document.querySelectorAll<HTMLButtonElement>("#provider-tabs .provider-tab");
const providerConfigs = {
  proxy: document.getElementById("provider-proxy") as HTMLDivElement,
  anthropic: document.getElementById("provider-anthropic") as HTMLDivElement,
  openai: document.getElementById("provider-openai") as HTMLDivElement,
  ollama: document.getElementById("provider-ollama") as HTMLDivElement,
  webllm: document.getElementById("provider-webllm") as HTMLDivElement,
};

// Input elements
const anthropicApiKey = document.getElementById("anthropic-api-key") as HTMLInputElement;
const anthropicModel = document.getElementById("anthropic-model") as HTMLInputElement;
const openaiApiKey = document.getElementById("openai-api-key") as HTMLInputElement;
const openaiModel = document.getElementById("openai-model") as HTMLInputElement;
const ollamaBaseUrl = document.getElementById("ollama-base-url") as HTMLInputElement;
const ollamaModel = document.getElementById("ollama-model") as HTMLSelectElement;
const ollamaStatus = document.getElementById("ollama-status") as HTMLDivElement;
const webllmModel = document.getElementById("webllm-model") as HTMLSelectElement;
const webllmStatus = document.getElementById("webllm-status") as HTMLDivElement;
const webllmProgress = document.getElementById("webllm-progress") as HTMLDivElement;
const webllmProgressFill = document.getElementById("webllm-progress-fill") as HTMLDivElement;
const webllmProgressText = document.getElementById("webllm-progress-text") as HTMLDivElement;
const maxTokensSelect = document.getElementById("max-tokens-select") as HTMLSelectElement | null;

// Governance elements
const approvalPresets = document.querySelectorAll<HTMLInputElement>(
  'input[name="approval-preset"]',
);
const govPersistenceThreshold = document.getElementById(
  "gov-persistence-threshold",
) as HTMLInputElement;
const govPersistenceValue = document.getElementById("gov-persistence-value") as HTMLSpanElement;
const govRejectSecrets = document.getElementById("gov-reject-secrets") as HTMLInputElement;
const govMaxCalls = document.getElementById("gov-max-calls") as HTMLSelectElement;

// Voice elements
const ttsVoiceSelect = document.getElementById("settings-tts-voice") as HTMLSelectElement;
const voiceAutoSend = document.getElementById("settings-voice-autosend") as HTMLInputElement;
const voiceResponse = document.getElementById("settings-voice-response") as HTMLInputElement;

// === State ===

let activeProviderTab: ProviderType | "proxy" = "proxy";
let activeByokProvider: "anthropic" | "openai" | "google" = "anthropic";

// === Settings API ===

export interface SettingsAPI {
  open(): void;
  openToTab(tabName: string): void;
  close(): void;
  updateModelIndicator(): void;
  updateConnectPrompt(): void;
}

export interface SettingsDeps {
  colorPicker: ColorPickerAPI;
}

const APPROVAL_PRESET_CONFIGS: Record<
  string,
  { maxRiskLevel: number; requireApprovalAbove: number; denyAbove: number }
> = {
  cautious: { maxRiskLevel: 3, requireApprovalAbove: 0, denyAbove: 3 },
  balanced: { maxRiskLevel: 3, requireApprovalAbove: 1, denyAbove: 3 },
  autonomous: { maxRiskLevel: 4, requireApprovalAbove: 3, denyAbove: 4 },
};

function applyGovernanceToRuntime(ctx: WebContext, gov: GovernanceConfig): void {
  const runtime = ctx.app.getRuntime();
  if (!runtime) return;
  const preset = APPROVAL_PRESET_CONFIGS[gov.approvalPreset] ?? APPROVAL_PRESET_CONFIGS.balanced!;
  runtime.updatePolicyConfig({
    operatorMode: false,
    maxRiskLevel: preset.maxRiskLevel,
    requireApprovalAbove: preset.requireApprovalAbove,
    denyAbove: preset.denyAbove,
    budget: { maxCallsPerTurn: gov.maxCallsPerTurn },
  });
}

export function initSettings(ctx: WebContext, deps: SettingsDeps): SettingsAPI {
  const { colorPicker } = deps;

  // === Tab Switching (Appearance / Intelligence) ===

  function switchTab(tabName: string): void {
    document.querySelectorAll(".settings-tab").forEach((tab) => {
      const isActive = (tab as HTMLElement).dataset.tab === tabName;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    });
    document.querySelectorAll(".settings-pane").forEach((pane) => {
      pane.classList.toggle("active", pane.id === `pane-${tabName}`);
    });

    if (tabName === "identity") {
      populateIdentityFields();
    }
    if (tabName === "governance") {
      populateAuditTrail();
    }
  }

  // === Live Model Discovery on API Key Input ===
  anthropicApiKey.addEventListener("input", () => {
    fetchModelsForProvider("anthropic", anthropicApiKey.value.trim(), "anthropic-models");
  });
  openaiApiKey.addEventListener("input", () => {
    fetchModelsForProvider("openai", openaiApiKey.value.trim(), "openai-models");
  });
  const googleApiKeyEl = document.getElementById("google-api-key") as HTMLInputElement | null;
  googleApiKeyEl?.addEventListener("input", () => {
    fetchModelsForProvider("google", googleApiKeyEl.value.trim(), "google-models");
  });

  function populateIdentityFields(): void {
    identityMotebitId.textContent = ctx.app.motebitId || "—";
    identityDeviceId.textContent = ctx.app.deviceId || "—";
    const pubHex = ctx.app.publicKeyHex;
    identityDid.textContent = pubHex ? hexPublicKeyToDidKey(pubHex) : "—";
    identityPublicKey.textContent = pubHex || "—";
  }

  function populateTtsVoices(): void {
    if (typeof speechSynthesis === "undefined") return;
    const fill = (): void => {
      const voices = speechSynthesis.getVoices();
      // Keep default option, clear the rest
      while (ttsVoiceSelect.options.length > 1) ttsVoiceSelect.remove(1);
      for (const v of voices) {
        const opt = document.createElement("option");
        opt.value = v.name;
        opt.textContent = `${v.name} (${v.lang})`;
        ttsVoiceSelect.appendChild(opt);
      }
      // Restore saved selection
      const saved = loadVoiceConfig();
      if (saved?.ttsVoice) ttsVoiceSelect.value = saved.ttsVoice;
    };
    fill();
    // Chrome loads voices async
    if (speechSynthesis.getVoices().length === 0) {
      speechSynthesis.addEventListener("voiceschanged", fill, { once: true });
    }
  }

  function classifyDecision(decision: unknown): "allowed" | "denied" | "approval" {
    if (decision == null || typeof decision !== "object") return "allowed";
    const d = decision as Record<string, unknown>;
    if (d.allowed === false) return "denied";
    if (d.requiresApproval === true) return "approval";
    return "allowed";
  }

  function formatTimeAgo(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  function populateAuditTrail(): void {
    const listEl = document.getElementById("audit-activity-list")!;
    const emptyEl = document.getElementById("audit-activity-empty")!;
    listEl.innerHTML = "";
    emptyEl.style.display = "none";

    const runtime = ctx.app.getRuntime();
    if (!runtime) {
      emptyEl.style.display = "block";
      return;
    }

    const entries = runtime.policy.audit.getAll();
    if (entries.length === 0) {
      emptyEl.style.display = "block";
      return;
    }

    // Show most recent first, limit to 50
    const recent = entries.slice(-50).reverse();
    for (const entry of recent) {
      const row = document.createElement("div");
      row.className = "audit-row";

      const header = document.createElement("div");
      header.className = "audit-row-header";

      const toolName = document.createElement("span");
      toolName.className = "audit-tool-name";
      toolName.textContent = entry.tool;
      header.appendChild(toolName);

      const badgeClass = classifyDecision(entry.decision);
      const badge = document.createElement("span");
      badge.className = `audit-decision-badge ${badgeClass}`;
      badge.textContent = badgeClass;
      header.appendChild(badge);

      if (entry.injection?.detected) {
        const injBadge = document.createElement("span");
        injBadge.className = "audit-decision-badge denied";
        injBadge.textContent = "injection";
        header.appendChild(injBadge);
      }

      const time = document.createElement("span");
      time.className = "audit-time";
      time.textContent = formatTimeAgo(entry.timestamp);
      header.appendChild(time);

      row.appendChild(header);

      // Expandable detail
      const detail = document.createElement("div");
      detail.className = "audit-row-detail";

      const argsStr = JSON.stringify(entry.args ?? {});
      const argsDiv = document.createElement("div");
      argsDiv.className = "audit-detail-args";
      argsDiv.textContent = argsStr.length > 200 ? argsStr.slice(0, 200) + "..." : argsStr;
      detail.appendChild(argsDiv);

      if (entry.result) {
        const resultDiv = document.createElement("div");
        resultDiv.className = "audit-detail-result";
        const ok = entry.result.ok ? "ok" : "failed";
        const dur = entry.result.durationMs != null ? `${entry.result.durationMs}ms` : "";
        resultDiv.textContent = [ok, dur].filter(Boolean).join(" · ");
        detail.appendChild(resultDiv);
      }

      row.appendChild(detail);
      row.addEventListener("click", () => row.classList.toggle("expanded"));
      listEl.appendChild(row);
    }
  }

  function setupIdentityCopyHandlers(): void {
    for (const el of [identityMotebitId, identityDeviceId, identityDid, identityPublicKey]) {
      el.addEventListener("click", () => {
        const text = el.textContent;
        if (text == null || text === "" || text === "—") return;
        void navigator.clipboard.writeText(text).then(() => {
          el.classList.add("copied");
          setTimeout(() => el.classList.remove("copied"), 1000);
        });
      });
    }
  }

  setupIdentityCopyHandlers();

  // Export Data button
  document.getElementById("settings-export-data")?.addEventListener("click", () => {
    void ctx.app.exportData().then((json) => {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `motebit-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = (tab as HTMLElement).dataset.tab;
      if (name != null && name !== "") switchTab(name);
    });
  });

  // === Provider Tab Switching ===

  function switchProviderTab(provider: ProviderType | "proxy"): void {
    activeProviderTab = provider;
    providerTabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.provider === provider);
    });
    for (const [key, el] of Object.entries(providerConfigs)) {
      el.classList.toggle("active", key === provider);
    }

    // Auto-detect Ollama models when switching to Ollama tab
    if (provider === "ollama") {
      void detectAndPopulateOllama();
    }

    // Check WebGPU when switching to WebLLM tab
    if (provider === "webllm") {
      if (checkWebGPU()) {
        webllmStatus.textContent = "WebGPU available";
        webllmStatus.className = "webllm-status";
      } else {
        webllmStatus.textContent = "WebGPU not available in this browser";
        webllmStatus.className = "webllm-status error";
      }
    }
  }

  providerTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const provider = tab.dataset.provider;
      if (provider) switchProviderTab(provider as ProviderType);
    });
  });

  // === BYOK Sub-Provider Toggle ===
  document.querySelectorAll<HTMLButtonElement>(".byok-provider-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const byok = btn.dataset.byok as "anthropic" | "openai" | "google";
      if (!byok) return;
      activeByokProvider = byok;
      document.querySelectorAll<HTMLButtonElement>(".byok-provider-btn").forEach((b) => {
        const isActive = b.dataset.byok === byok;
        b.classList.toggle("active", isActive);
        b.style.background = isActive ? "var(--accent-bg)" : "transparent";
        b.style.color = isActive ? "var(--text-heading)" : "var(--text-muted)";
      });
      const anthropicSection = document.getElementById("byok-anthropic");
      const openaiSection = document.getElementById("byok-openai");
      const googleSection = document.getElementById("byok-google");
      if (anthropicSection) anthropicSection.style.display = byok === "anthropic" ? "" : "none";
      if (openaiSection) openaiSection.style.display = byok === "openai" ? "" : "none";
      if (googleSection) googleSection.style.display = byok === "google" ? "" : "none";
    });
  });

  // === Ollama Auto-Detection ===

  async function detectAndPopulateOllama(): Promise<void> {
    const baseUrl = ollamaBaseUrl.value.trim() || DEFAULT_OLLAMA_URL;
    ollamaStatus.textContent = "Detecting...";
    ollamaStatus.className = "ollama-status";

    const models = await detectOllamaModels(baseUrl);
    ollamaModel.innerHTML = "";

    if (models.length === 0) {
      ollamaStatus.textContent = "No Ollama instance detected";
      ollamaStatus.className = "ollama-status error";
      const opt = document.createElement("option");
      opt.value = "llama3.2";
      opt.textContent = "llama3.2 (default)";
      ollamaModel.appendChild(opt);
    } else {
      ollamaStatus.textContent = `Connected — ${models.length} model${models.length !== 1 ? "s" : ""}`;
      ollamaStatus.className = "ollama-status connected";
      for (const model of models) {
        const opt = document.createElement("option");
        opt.value = model;
        opt.textContent = model;
        ollamaModel.appendChild(opt);
      }
    }
  }

  // Re-detect when base URL changes
  ollamaBaseUrl.addEventListener("change", () => void detectAndPopulateOllama());

  // Governance: live-update persistence threshold display
  govPersistenceThreshold.addEventListener("input", () => {
    govPersistenceValue.textContent = (parseInt(govPersistenceThreshold.value, 10) / 100).toFixed(
      2,
    );
  });

  // === Open / Close ===

  function open(): void {
    colorPicker.savePreviousState();
    colorPicker.buildColorSwatches();
    settingsBackdrop.classList.add("open");
    settingsModal.classList.add("open");
    renderMcpServers();

    // Pre-fill governance config
    const govConfig = loadGovernanceConfig();
    if (govConfig) {
      approvalPresets.forEach((radio) => {
        radio.checked = radio.value === govConfig.approvalPreset;
      });
      govPersistenceThreshold.value = String(Math.round(govConfig.persistenceThreshold * 100));
      govPersistenceValue.textContent = govConfig.persistenceThreshold.toFixed(2);
      govRejectSecrets.checked = govConfig.rejectSecrets;
      govMaxCalls.value = String(govConfig.maxCallsPerTurn);
    }

    // Populate TTS voices
    populateTtsVoices();
    const voiceConfig = loadVoiceConfig();
    if (voiceConfig) {
      voiceAutoSend.checked = voiceConfig.autoSend;
      voiceResponse.checked = voiceConfig.voiceResponse;
      // Voice select populated async — set after voices load
      if (voiceConfig.ttsVoice) ttsVoiceSelect.value = voiceConfig.ttsVoice;
    }

    // Pre-fill from current provider config
    const config = ctx.getConfig();
    if (config) {
      switchProviderTab(config.type);
      if (maxTokensSelect) maxTokensSelect.value = String(config.maxTokens ?? 4096);
      switch (config.type) {
        case "proxy": {
          const cloudModelEl = document.getElementById("cloud-model") as HTMLSelectElement | null;
          if (cloudModelEl) cloudModelEl.value = config.model;
          break;
        }
        case "anthropic":
          anthropicApiKey.value = config.apiKey ?? "";
          anthropicModel.value = config.model;
          if (config.apiKey) fetchModelsForProvider("anthropic", config.apiKey, "anthropic-models");
          break;
        case "openai":
          openaiApiKey.value = config.apiKey ?? "";
          openaiModel.value = config.model;
          if (config.apiKey) fetchModelsForProvider("openai", config.apiKey, "openai-models");
          break;
        case "ollama":
          ollamaBaseUrl.value = config.baseUrl || DEFAULT_OLLAMA_URL;
          void detectAndPopulateOllama().then(() => {
            ollamaModel.value = config.model;
          });
          break;
        case "webllm":
          webllmModel.value = config.model;
          break;
      }
    }
  }

  function close(): void {
    settingsBackdrop.classList.remove("open");
    settingsModal.classList.remove("open");
  }

  function openToTab(tabName: string): void {
    open();
    switchTab(tabName);
  }

  // Backdrop click to close
  settingsBackdrop.addEventListener("click", () => {
    colorPicker.restorePreviousState();
    close();
  });

  // Settings button
  document.getElementById("settings-btn")?.addEventListener("click", () => open());

  // Connect prompt button
  document
    .getElementById("connect-prompt-btn")
    ?.addEventListener("click", () => openToTab("intelligence"));

  // Cancel button
  document.getElementById("settings-cancel")?.addEventListener("click", () => {
    colorPicker.restorePreviousState();
    close();
  });

  // Save button
  document.getElementById("settings-save")?.addEventListener("click", () => {
    // Build provider config from current tab
    const maxTokens = maxTokensSelect
      ? parseInt(maxTokensSelect.value, 10) || undefined
      : undefined;
    let config: ProviderConfig;
    switch (activeProviderTab) {
      case "proxy":
        {
          // Proxy tab — read model from the cloud model selector
          const cloudModel =
            (document.getElementById("cloud-model") as HTMLSelectElement | null)?.value ??
            DEFAULT_ANTHROPIC_MODEL;
          config = { type: "proxy", model: cloudModel, maxTokens };
        }
        break;
      case "anthropic":
        // API Key tab — check which BYOK sub-provider is active
        if (activeByokProvider === "google") {
          const googleApiKey = document.getElementById("google-api-key") as HTMLInputElement | null;
          const googleModel = document.getElementById("google-model") as HTMLInputElement | null;
          config = {
            type: "openai", // Google uses OpenAI-compatible API format
            apiKey: googleApiKey?.value.trim() ?? "",
            model: googleModel?.value ?? DEFAULT_GOOGLE_MODEL,
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
            maxTokens,
          };
        } else if (activeByokProvider === "openai") {
          config = {
            type: "openai",
            apiKey: openaiApiKey.value.trim(),
            model: openaiModel.value,
            maxTokens,
          };
        } else {
          config = {
            type: "anthropic",
            apiKey: anthropicApiKey.value.trim(),
            model: anthropicModel.value,
            maxTokens,
          };
        }
        break;
      case "openai":
        config = {
          type: "openai",
          apiKey: openaiApiKey.value.trim(),
          model: openaiModel.value,
          maxTokens,
        };
        break;
      case "ollama":
        config = {
          type: "ollama",
          model: ollamaModel.value,
          baseUrl: ollamaBaseUrl.value.trim(),
          maxTokens,
        };
        break;
      case "webllm":
        config = { type: "webllm", model: webllmModel.value, maxTokens };
        break;
      default:
        config = { type: "anthropic", model: DEFAULT_ANTHROPIC_MODEL };
    }

    // Save soul color
    const preset = colorPicker.getSelectedPreset();
    const soulColor =
      preset === "custom"
        ? {
            preset: "custom",
            customHue: colorPicker.getCustomHue(),
            customSaturation: colorPicker.getCustomSaturation(),
          }
        : { preset };
    saveSoulColor(soulColor);

    // Only reconnect provider if the provider config actually changed
    const prev = ctx.getConfig();
    const providerChanged =
      !prev ||
      prev.type !== config.type ||
      prev.model !== config.model ||
      prev.apiKey !== config.apiKey ||
      prev.baseUrl !== config.baseUrl ||
      prev.maxTokens !== config.maxTokens;

    if (providerChanged) {
      if (activeProviderTab === "webllm") {
        void initWebLLM(config);
      } else {
        ctx.app.connectProvider(config);
      }
    }

    saveProviderConfig(config);
    ctx.setConfig(config);

    // Save governance config and apply to runtime
    const selectedPreset =
      document.querySelector<HTMLInputElement>('input[name="approval-preset"]:checked')?.value ??
      "balanced";
    const govCfg: GovernanceConfig = {
      approvalPreset: selectedPreset as GovernanceConfig["approvalPreset"],
      persistenceThreshold: parseInt(govPersistenceThreshold.value, 10) / 100,
      rejectSecrets: govRejectSecrets.checked,
      maxCallsPerTurn: parseInt(govMaxCalls.value, 10) || 10,
    };
    saveGovernanceConfig(govCfg);
    applyGovernanceToRuntime(ctx, govCfg);

    // Save voice config
    const voiceCfg: VoiceConfig = {
      ttsVoice: ttsVoiceSelect.value,
      autoSend: voiceAutoSend.checked,
      voiceResponse: voiceResponse.checked,
    };
    saveVoiceConfig(voiceCfg);
    setTTSVoice(voiceCfg.ttsVoice);

    updateModelIndicator();
    updateConnectPrompt();
    close();
  });

  // === WebLLM Init ===

  async function initWebLLM(config: ProviderConfig): Promise<void> {
    webllmProgress.style.display = "block";
    webllmProgressText.textContent = "Loading model...";
    webllmProgressFill.style.width = "0%";

    try {
      const provider = new WebLLMProvider(config.model);
      await provider.init((progress) => {
        webllmProgressFill.style.width = `${Math.round(progress.progress * 100)}%`;
        webllmProgressText.textContent = progress.text;
      });
      // Set the initialized WebLLM provider directly on the runtime
      ctx.app.setProviderDirect(provider);
      webllmProgressText.textContent = "Ready";
      updateModelIndicator();
      updateConnectPrompt();
      ctx.showToast("WebLLM model loaded");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      webllmProgressText.textContent = `Failed: ${msg}`;
      ctx.showToast(`WebLLM failed: ${msg}`);
    }
  }

  // === MCP Server Management ===

  const mcpServerList = document.getElementById("mcp-server-list") as HTMLDivElement;
  const mcpAddName = document.getElementById("mcp-add-name") as HTMLInputElement;
  const mcpAddUrl = document.getElementById("mcp-add-url") as HTMLInputElement;
  const mcpAddMotebit = document.getElementById("mcp-add-motebit") as HTMLInputElement;
  const mcpAddBtn = document.getElementById("mcp-add-btn") as HTMLButtonElement;

  function renderMcpServers(): void {
    const servers = ctx.app.getMcpServers();
    mcpServerList.innerHTML = "";
    for (const server of servers) {
      const item = document.createElement("div");
      item.className = "mcp-server-item";

      const dot = document.createElement("span");
      dot.className = `mcp-server-dot ${server.connected ? "connected" : "disconnected"}`;
      item.appendChild(dot);

      const name = document.createElement("span");
      name.className = "mcp-server-name";
      name.textContent = server.name;
      item.appendChild(name);

      const tools = document.createElement("span");
      tools.className = "mcp-server-tools";
      tools.textContent = `${server.toolCount} tools`;
      item.appendChild(tools);

      const actions = document.createElement("div");
      actions.className = "mcp-server-actions";

      const trustBtn = document.createElement("button");
      trustBtn.textContent = server.trusted ? "Untrust" : "Trust";
      trustBtn.addEventListener("click", () => {
        ctx.app.setMcpServerTrust(server.name, !server.trusted);
        renderMcpServers();
      });
      actions.appendChild(trustBtn);

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        void ctx.app.removeMcpServer(server.name).then(() => renderMcpServers());
      });
      actions.appendChild(removeBtn);

      item.appendChild(actions);
      mcpServerList.appendChild(item);
    }
  }

  mcpAddBtn.addEventListener("click", () => {
    const name = mcpAddName.value.trim();
    const url = mcpAddUrl.value.trim();
    if (!name || !url) {
      ctx.showToast("Name and URL are required");
      return;
    }
    mcpAddBtn.disabled = true;
    mcpAddBtn.textContent = "Connecting...";
    void ctx.app
      .addMcpServer({
        name,
        transport: "http",
        url,
        motebit: mcpAddMotebit.checked,
      })
      .then(() => {
        mcpAddName.value = "";
        mcpAddUrl.value = "";
        mcpAddMotebit.checked = false;
        renderMcpServers();
        ctx.showToast(`Connected to ${name}`);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.showToast(`MCP failed: ${msg}`);
      })
      .finally(() => {
        mcpAddBtn.disabled = false;
        mcpAddBtn.textContent = "Add";
      });
  });

  // === Escape key ===

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsModal.classList.contains("open")) {
      colorPicker.restorePreviousState();
      close();
    }
  });

  // === Model Indicator ===

  function updateModelIndicator(): void {
    const model = ctx.app.currentModel;
    modelIndicator.textContent = model ?? "";
  }

  function updateConnectPrompt(): void {
    if (ctx.app.isProviderConnected) {
      connectPrompt.classList.add("hidden");
    } else {
      connectPrompt.classList.remove("hidden");
    }
  }

  return { open, openToTab, close, updateModelIndicator, updateConnectPrompt };
}
