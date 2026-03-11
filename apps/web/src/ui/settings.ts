import type { WebContext } from "../types";
import type { ProviderConfig, ProviderType } from "../storage";
import { saveProviderConfig, saveSoulColor } from "../storage";
import { detectOllamaModels, checkWebGPU, WebLLMProvider, DEFAULT_OLLAMA_URL } from "../providers";
import type { ColorPickerAPI } from "./color-picker";

// === DOM Refs ===

const settingsBackdrop = document.getElementById("settings-backdrop") as HTMLDivElement;
const settingsModal = document.getElementById("settings-modal") as HTMLDivElement;
const connectPrompt = document.getElementById("connect-prompt") as HTMLDivElement;
const modelIndicator = document.getElementById("model-indicator") as HTMLDivElement;

// Identity fields
const identityMotebitId = document.getElementById("identity-motebit-id") as HTMLDivElement;
const identityDeviceId = document.getElementById("identity-device-id") as HTMLDivElement;
const identityPublicKey = document.getElementById("identity-public-key") as HTMLDivElement;

// === Provider Tab DOM ===
const providerTabs = document.querySelectorAll<HTMLButtonElement>("#provider-tabs .provider-tab");
const providerConfigs = {
  anthropic: document.getElementById("provider-anthropic") as HTMLDivElement,
  openai: document.getElementById("provider-openai") as HTMLDivElement,
  ollama: document.getElementById("provider-ollama") as HTMLDivElement,
  webllm: document.getElementById("provider-webllm") as HTMLDivElement,
};

// Input elements
const anthropicApiKey = document.getElementById("anthropic-api-key") as HTMLInputElement;
const anthropicModel = document.getElementById("anthropic-model") as HTMLSelectElement;
const openaiApiKey = document.getElementById("openai-api-key") as HTMLInputElement;
const openaiModel = document.getElementById("openai-model") as HTMLSelectElement;
const ollamaBaseUrl = document.getElementById("ollama-base-url") as HTMLInputElement;
const ollamaModel = document.getElementById("ollama-model") as HTMLSelectElement;
const ollamaStatus = document.getElementById("ollama-status") as HTMLDivElement;
const webllmModel = document.getElementById("webllm-model") as HTMLSelectElement;
const webllmStatus = document.getElementById("webllm-status") as HTMLDivElement;
const webllmProgress = document.getElementById("webllm-progress") as HTMLDivElement;
const webllmProgressFill = document.getElementById("webllm-progress-fill") as HTMLDivElement;
const webllmProgressText = document.getElementById("webllm-progress-text") as HTMLDivElement;

// === State ===

let activeProviderTab: ProviderType = "anthropic";

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

    // Populate identity fields when switching to identity tab
    if (tabName === "identity") {
      populateIdentityFields();
    }
  }

  function populateIdentityFields(): void {
    identityMotebitId.textContent = ctx.app.motebitId || "—";
    identityDeviceId.textContent = ctx.app.deviceId || "—";
    identityPublicKey.textContent = ctx.app.publicKeyHex || "—";
  }

  function setupIdentityCopyHandlers(): void {
    for (const el of [identityMotebitId, identityDeviceId, identityPublicKey]) {
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

  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = (tab as HTMLElement).dataset.tab;
      if (name != null && name !== "") switchTab(name);
    });
  });

  // === Provider Tab Switching ===

  function switchProviderTab(provider: ProviderType): void {
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
      const provider = tab.dataset.provider as ProviderType;
      if (provider) switchProviderTab(provider);
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

  // === Open / Close ===

  function open(): void {
    colorPicker.savePreviousState();
    colorPicker.buildColorSwatches();
    settingsBackdrop.classList.add("open");
    settingsModal.classList.add("open");

    // Pre-fill from current provider config
    const config = ctx.getConfig();
    if (config) {
      switchProviderTab(config.type);
      switch (config.type) {
        case "anthropic":
          anthropicApiKey.value = config.apiKey ?? "";
          anthropicModel.value = config.model;
          break;
        case "openai":
          openaiApiKey.value = config.apiKey ?? "";
          openaiModel.value = config.model;
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
    let config: ProviderConfig;
    switch (activeProviderTab) {
      case "anthropic":
        config = {
          type: "anthropic",
          apiKey: anthropicApiKey.value.trim(),
          model: anthropicModel.value,
        };
        break;
      case "openai":
        config = { type: "openai", apiKey: openaiApiKey.value.trim(), model: openaiModel.value };
        break;
      case "ollama":
        config = { type: "ollama", model: ollamaModel.value, baseUrl: ollamaBaseUrl.value.trim() };
        break;
      case "webllm":
        config = { type: "webllm", model: webllmModel.value };
        break;
      default:
        config = { type: "anthropic", model: "claude-sonnet-4-20250514" };
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

    // Connect provider
    if (activeProviderTab === "webllm") {
      // WebLLM needs async init
      void initWebLLM(config);
    } else {
      ctx.app.connectProvider(config);
    }

    saveProviderConfig(config);
    ctx.setConfig(config);
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
