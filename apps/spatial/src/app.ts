/**
 * Spatial app entry point — the glass creature in physical space.
 *
 * Initializes the SpatialApp platform shell, wires settings UI, voice pipeline,
 * gesture recognition, gaze attention, and WebXR session. The creature has
 * intelligence, memory, identity, and ambient voice interaction — the same
 * sovereign runtime that powers the desktop app, with browser-native substitutions.
 *
 * Conversation history persists across sessions via IndexedDB.
 * MCP HTTP servers can be added for remote tool/agent access.
 * Goals execute one-shot via PlanEngine.
 */

import { SpatialApp, COLOR_PRESETS, deriveInteriorColor } from "./spatial-app";
import type { SpatialAIConfig } from "./spatial-app";
import type { UnifiedProviderConfig, OnDeviceBackend } from "@motebit/sdk";
import { migrateLegacyProvider } from "@motebit/sdk";
import { DEFAULT_OLLAMA_URL } from "@motebit/ai-core";
import { WebXRThreeJSAdapter } from "@motebit/render-engine";
import { SpatialVoicePipeline } from "./voice-pipeline";
import type { OpenAITTSVoice } from "@motebit/voice";

// === DOM elements ===

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLElement;
const enterButton = document.getElementById("enter-ar") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;

// Settings elements — three-mode provider UI
const settingsOverlay = document.getElementById("settings-overlay") as HTMLElement;
const modeRadios = document.querySelectorAll<HTMLInputElement>('input[name="provider-mode"]');
const onDeviceSection = document.getElementById("mode-on-device") as HTMLElement;
const motebitCloudSection = document.getElementById("mode-motebit-cloud") as HTMLElement;
const byokSection = document.getElementById("mode-byok") as HTMLElement;
const onDeviceBackendRadios = document.querySelectorAll<HTMLInputElement>(
  'input[name="on-device-backend"]',
);
const localServerEndpointInput = document.getElementById(
  "local-server-endpoint",
) as HTMLInputElement;
const localServerEndpointGroup = document.getElementById(
  "local-server-endpoint-group",
) as HTMLElement;
const byokVendorRadios = document.querySelectorAll<HTMLInputElement>('input[name="byok-vendor"]');
const apiKeyInput = document.getElementById("api-key-input") as HTMLInputElement;
const modelInput = document.getElementById("model-input") as HTMLInputElement;
const voiceToggle = document.getElementById("voice-toggle") as HTMLInputElement;
const settingsSave = document.getElementById("settings-save") as HTMLButtonElement;
const settingsSkip = document.getElementById("settings-skip") as HTMLButtonElement;

// TTS settings
const openaiKeyInput = document.getElementById("openai-key-input") as HTMLInputElement | null;
const ttsVoiceSelect = document.getElementById("tts-voice-select") as HTMLSelectElement | null;
const vadSlider = document.getElementById("vad-sensitivity") as HTMLInputElement | null;
const proactiveToggle = document.getElementById("proactive-toggle") as HTMLInputElement | null;

// Network settings
const relayUrlInput = document.getElementById("relay-url-input") as HTMLInputElement | null;
const showNetworkToggle = document.getElementById("show-network-toggle") as HTMLInputElement | null;

// MCP elements
const mcpServerList = document.getElementById("mcp-server-list") as HTMLDivElement | null;
const mcpAddName = document.getElementById("mcp-add-name") as HTMLInputElement | null;
const mcpAddUrl = document.getElementById("mcp-add-url") as HTMLInputElement | null;
const mcpAddMotebit = document.getElementById("mcp-add-motebit") as HTMLInputElement | null;
const mcpAddBtn = document.getElementById("mcp-add-btn") as HTMLButtonElement | null;

// Color picker elements
const colorSwatches = document.getElementById("color-swatches") as HTMLDivElement | null;
const customColorPicker = document.getElementById("custom-color-picker") as HTMLDivElement | null;
const hueSlider = document.getElementById("hue-slider") as HTMLInputElement | null;
const satSlider = document.getElementById("sat-slider") as HTMLInputElement | null;

// Voice indicator
const voiceIndicator = document.getElementById("voice-indicator") as HTMLElement;

// === State ===

const app = new SpatialApp();
let lastTime = 0;

// Gaze attention state
let lastGazeHit = false;

// === Settings persistence ===

import {
  DEFAULT_GOVERNANCE_CONFIG,
  DEFAULT_APPEARANCE_CONFIG,
  migrateAppearanceConfig,
  type GovernanceConfig,
  type AppearanceConfig,
} from "@motebit/sdk";

/**
 * Spatial's three-mode provider settings — flat shape that drives the
 * settings form. The mental model maps onto sdk's `UnifiedProviderConfig`:
 *
 *   on-device     → backend ∈ { "webllm", "local-server" }
 *   motebit-cloud → no sub-picker (relay handles vendor server-side)
 *   byok          → vendor ∈ { "anthropic", "openai", "google" }
 *
 * Mirrors the mobile pattern: the form keeps a flat shape; we convert to
 * `UnifiedProviderConfig` in `tryInitAI` via `spatialSettingsToUnified`.
 * Legacy persisted shapes flow through `migrateLegacyProvider` from sdk.
 */
type SpatialProviderMode = "on-device" | "motebit-cloud" | "byok";
type SpatialOnDeviceBackend = Extract<OnDeviceBackend, "webllm" | "local-server">;
type SpatialByokVendor = "anthropic" | "openai" | "google";

interface SpatialSettings {
  mode: SpatialProviderMode;
  onDeviceBackend: SpatialOnDeviceBackend;
  byokVendor: SpatialByokVendor;
  localServerEndpoint: string;
  apiKey: string;
  model: string;
  voiceEnabled: boolean;
  openaiApiKey: string;
  ttsVoice: OpenAITTSVoice;
  vadSensitivity: number;
  proactiveEnabled: boolean;
  relayUrl: string;
  showNetwork: boolean;
  /**
   * Appearance settings — nested under the canonical `@motebit/sdk`
   * `AppearanceConfig` shape. Historical flat fields (`colorPreset`,
   * `customHue`, `customSaturation`) are accepted on load via
   * `migrateLegacySpatialSettings` → `migrateAppearanceConfig`.
   */
  appearance: AppearanceConfig;
  maxTokens: number;
  governance: GovernanceConfig;
}

const DEFAULT_SPATIAL_SETTINGS: SpatialSettings = {
  mode: "motebit-cloud",
  onDeviceBackend: "local-server",
  byokVendor: "anthropic",
  localServerEndpoint: DEFAULT_OLLAMA_URL,
  apiKey: "",
  model: "",
  voiceEnabled: true,
  openaiApiKey: "",
  ttsVoice: "nova",
  vadSensitivity: 0.5,
  proactiveEnabled: true,
  relayUrl: "https://relay.motebit.com",
  showNetwork: true,
  appearance: { ...DEFAULT_APPEARANCE_CONFIG },
  maxTokens: 4096,
  governance: { ...DEFAULT_GOVERNANCE_CONFIG },
};

/**
 * Reverse migration: collapse an old persisted spatial settings object onto
 * the current `SpatialSettings` shape. Pre-three-mode persisted state used a
 * flat `provider: "anthropic" | "local-server" | "openai" | "proxy"`
 * discriminator (and historically `"ollama"`). Run it through the sdk's
 * canonical migration so the surface inherits any future legacy renames for
 * free, then unpack the unified shape back onto the form's flat fields.
 */
function migrateLegacySpatialSettings(
  raw: Partial<SpatialSettings> & {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  },
): void {
  if (raw.mode !== undefined) return; // already three-mode
  if (raw.provider == null || raw.provider === "") return;

  const unified = migrateLegacyProvider({
    provider: raw.provider,
    apiKey: raw.apiKey,
    model: raw.model,
    baseUrl: raw.baseUrl,
  });
  if (!unified) return;

  raw.mode = unified.mode;
  if (unified.mode === "byok") {
    raw.byokVendor = unified.vendor;
    raw.apiKey = unified.apiKey;
    raw.model = unified.model ?? "";
  } else if (unified.mode === "on-device") {
    // sdk can return apple-fm/mlx for legacy `local`/`hybrid` shapes; spatial
    // doesn't support those. Coerce to local-server (the closest analog the
    // surface can actually run).
    raw.onDeviceBackend = unified.backend === "webllm" ? "webllm" : "local-server";
    raw.model = unified.model ?? "";
    if (unified.endpoint != null && unified.endpoint !== "") {
      raw.localServerEndpoint = unified.endpoint;
    }
  } else {
    // motebit-cloud — nothing more to unpack
    raw.model = unified.model ?? "";
  }
  delete raw.provider;
}

function loadSettings(): SpatialSettings {
  try {
    const raw = localStorage.getItem("motebit:spatial_settings");
    if (raw != null && raw !== "") {
      const parsed = JSON.parse(raw) as Partial<SpatialSettings> & {
        provider?: string;
        baseUrl?: string;
      };
      migrateLegacySpatialSettings(parsed);
      const defaultGov: GovernanceConfig = { ...DEFAULT_GOVERNANCE_CONFIG };
      // Appearance: nest legacy flat fields if present, else deep-merge
      // any partial nested record on top of defaults.
      const legacyParsed = parsed as Record<string, unknown>;
      const hasLegacyAppearance =
        legacyParsed.colorPreset !== undefined ||
        legacyParsed.customHue !== undefined ||
        legacyParsed.customSaturation !== undefined;
      const appearance: AppearanceConfig =
        parsed.appearance != null
          ? { ...DEFAULT_APPEARANCE_CONFIG, ...parsed.appearance }
          : hasLegacyAppearance
            ? migrateAppearanceConfig({
                colorPreset: legacyParsed.colorPreset,
                customHue: legacyParsed.customHue,
                customSaturation: legacyParsed.customSaturation,
              })
            : { ...DEFAULT_APPEARANCE_CONFIG };
      return {
        ...DEFAULT_SPATIAL_SETTINGS,
        ...(parsed as Partial<SpatialSettings>),
        appearance,
        governance: parsed.governance ? { ...defaultGov, ...parsed.governance } : defaultGov,
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SPATIAL_SETTINGS, governance: { ...DEFAULT_GOVERNANCE_CONFIG } };
}

function saveSettings(s: SpatialSettings): void {
  localStorage.setItem("motebit:spatial_settings", JSON.stringify(s));
}

/**
 * Convert spatial's flat settings shape into the canonical
 * `UnifiedProviderConfig` consumed by the sdk resolver. Mirrors mobile's
 * `mobileSettingsToUnifiedProvider`.
 */
function spatialSettingsToUnified(s: SpatialSettings): UnifiedProviderConfig {
  switch (s.mode) {
    case "motebit-cloud":
      return {
        mode: "motebit-cloud",
        model: s.model || undefined,
        maxTokens: s.maxTokens,
      };
    case "byok": {
      const baseUrl =
        s.byokVendor === "google"
          ? "https://generativelanguage.googleapis.com/v1beta/openai"
          : undefined;
      return {
        mode: "byok",
        vendor: s.byokVendor,
        apiKey: s.apiKey,
        model: s.model || undefined,
        baseUrl,
        maxTokens: s.maxTokens,
      };
    }
    case "on-device":
      return {
        mode: "on-device",
        backend: s.onDeviceBackend,
        model: s.model || undefined,
        endpoint: s.onDeviceBackend === "local-server" ? s.localServerEndpoint : undefined,
        maxTokens: s.maxTokens,
      };
  }
}

// === Local inference probe ===

/** Detect any local inference server — same probe as web surface. */
const LOCAL_INFERENCE_ENDPOINTS = [
  { url: "http://localhost:11434", type: "ollama" as const },
  { url: "http://localhost:1234", type: "openai" as const },
  { url: "http://localhost:8080", type: "openai" as const },
  { url: "http://localhost:1337", type: "openai" as const },
  { url: "http://localhost:8000", type: "openai" as const },
] as const;

async function probeLocalModels(
  baseUrl: string,
  type: "ollama" | "openai",
): Promise<{ baseUrl: string; type: "ollama" | "openai"; models: string[] } | null> {
  try {
    if (type === "ollama") {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        const models = (data.models ?? []).map((m: { name: string }) => m.name);
        if (models.length > 0) return { baseUrl, type, models };
      }
    }
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const models = (data.data ?? []).map((m: { id: string }) => m.id);
    if (models.length > 0) return { baseUrl, type: "openai", models };
  } catch {
    // Not running
  }
  return null;
}

async function autoInitLocalInference(): Promise<boolean> {
  const probes = LOCAL_INFERENCE_ENDPOINTS.map((ep) => probeLocalModels(ep.url, ep.type));
  const results = await Promise.allSettled(probes);
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      const { baseUrl, models } = result.value;
      const model =
        models.find((m) => m.includes("70b")) ??
        models.find((m) => m.includes("32b")) ??
        models.find((m) => m.includes("8b")) ??
        models[0]!;
      // Every supported local server (Ollama, LM Studio, llama.cpp, Jan,
      // vLLM) speaks OpenAI-compat at /v1 — `local-server` is the canonical
      // name for the on-device backend, regardless of which engine answered.
      const localSettings: SpatialSettings = {
        ...loadSettings(),
        mode: "on-device",
        onDeviceBackend: "local-server",
        localServerEndpoint: baseUrl,
        model,
      };
      saveSettings(localSettings);
      return tryInitAI(localSettings);
    }
  }
  return false;
}

// === Initialization ===

async function init(): Promise<void> {
  // Register service worker for PWA
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW registration failure is non-fatal
    });
  }

  // Bootstrap identity (silent — generates keypair on first launch)
  await app.bootstrap();

  // Initialize WebXR adapter
  await app.init(canvas);

  // Load saved settings and populate form
  const settings = loadSettings();
  setModeRadio(settings.mode);
  setBackendRadio(settings.onDeviceBackend);
  setVendorRadio(settings.byokVendor);
  localServerEndpointInput.value = settings.localServerEndpoint;
  apiKeyInput.value = settings.apiKey;
  modelInput.value = settings.model;
  voiceToggle.checked = settings.voiceEnabled;
  if (openaiKeyInput) openaiKeyInput.value = settings.openaiApiKey;
  if (ttsVoiceSelect) ttsVoiceSelect.value = settings.ttsVoice;
  if (vadSlider) vadSlider.value = String(settings.vadSensitivity);
  if (proactiveToggle) proactiveToggle.checked = settings.proactiveEnabled;
  if (relayUrlInput) relayUrlInput.value = settings.relayUrl;
  if (showNetworkToggle) showNetworkToggle.checked = settings.showNetwork;
  const maxTokensSelect = document.getElementById(
    "settings-max-tokens",
  ) as HTMLSelectElement | null;
  if (maxTokensSelect) maxTokensSelect.value = String(settings.maxTokens);
  updateProviderUI();
  buildColorSwatches(settings);

  // Apply network settings (best-effort relay — does not block boot)
  app.setNetworkSettings({ relayUrl: settings.relayUrl, showNetwork: settings.showNetwork });

  // Populate sovereign wallet fields from the runtime's full Solana rail
  function populateWalletFields(): void {
    const runtime = app.getRuntime();
    const addrEl = document.getElementById("wallet-solana-address");
    const balEl = document.getElementById("wallet-solana-balance");
    if (!addrEl || !balEl) return;

    const address = runtime?.getSolanaAddress() ?? null;
    addrEl.textContent = address ?? "-";
    // Click to copy
    addrEl.onclick = () => {
      if (address) void navigator.clipboard.writeText(address);
    };

    if (runtime && address) {
      balEl.textContent = "Loading\u2026";
      void runtime
        .getSolanaBalance()
        .then((micro: bigint | null) => {
          if (micro == null) {
            balEl.textContent = "-";
            return;
          }
          balEl.textContent = `${(Number(micro) / 1_000_000).toFixed(2)} USDC`;
        })
        .catch(() => {
          balEl.textContent = "-";
        });
    } else {
      balEl.textContent = "-";
    }
  }

  // If we have a saved config that can init, skip settings
  if (await tryInitAI(settings)) {
    settingsOverlay.classList.add("hidden");
    void initVoiceIfEnabled(settings);
    void app.connectRelay().then(() => void loadCredentials());
    renderMcpServers();
    populateWalletFields();
    showMainOverlay();
  } else {
    // No saved config — try local inference first (zero API cost), then show settings
    const hasLocal = await autoInitLocalInference();
    if (hasLocal) {
      settingsOverlay.classList.add("hidden");
      void initVoiceIfEnabled(loadSettings());
      void app.connectRelay().then(() => void loadCredentials());
      renderMcpServers();
      populateWalletFields();
      showMainOverlay();
    } else {
      // No local inference — show settings overlay
      settingsOverlay.classList.remove("hidden");
      overlay.classList.add("hidden");
    }
  }
}

async function tryInitAI(settings: SpatialSettings): Promise<boolean> {
  const config: SpatialAIConfig = {
    provider: spatialSettingsToUnified(settings),
    maxTokens: settings.maxTokens,
    governance: settings.governance,
  };

  const ok = await app.initAI(config);

  // Configure heartbeat
  app.heartbeat.updateConfig({ enabled: settings.proactiveEnabled });

  return ok;
}

async function initVoiceIfEnabled(settings: SpatialSettings): Promise<void> {
  if (!settings.voiceEnabled || !SpatialVoicePipeline.isSupported()) return;

  const started = await app.startVoice({
    openaiApiKey: settings.openaiApiKey || undefined,
    openaiVoice: settings.ttsVoice,
    vadSensitivity: settings.vadSensitivity,
  });

  if (started && voiceIndicator != null) {
    voiceIndicator.classList.remove("hidden");
  }
}

function showMainOverlay(): void {
  overlay.classList.remove("hidden");

  // Check WebXR support
  void WebXRThreeJSAdapter.isSupported().then((supported) => {
    if (!supported) {
      statusEl.textContent = "WebXR AR not available — flat preview";
      enterButton.disabled = true;
      startFlatPreview();
    } else {
      statusEl.textContent = app.isAIReady ? "Ready" : "Ready (no AI — configure in settings)";
      enterButton.addEventListener("click", () => void startAR());
    }
  });
}

// === Settings UI: three-mode provider picker ===

function getSelectedMode(): SpatialProviderMode {
  let selected: SpatialProviderMode = "motebit-cloud";
  modeRadios.forEach((r) => {
    if (r.checked) selected = r.value as SpatialProviderMode;
  });
  return selected;
}

function getSelectedBackend(): SpatialOnDeviceBackend {
  let selected: SpatialOnDeviceBackend = "local-server";
  onDeviceBackendRadios.forEach((r) => {
    if (r.checked) selected = r.value as SpatialOnDeviceBackend;
  });
  return selected;
}

function getSelectedVendor(): SpatialByokVendor {
  let selected: SpatialByokVendor = "anthropic";
  byokVendorRadios.forEach((r) => {
    if (r.checked) selected = r.value as SpatialByokVendor;
  });
  return selected;
}

function setModeRadio(mode: SpatialProviderMode): void {
  modeRadios.forEach((r) => {
    r.checked = r.value === mode;
  });
}
function setBackendRadio(backend: SpatialOnDeviceBackend): void {
  onDeviceBackendRadios.forEach((r) => {
    r.checked = r.value === backend;
  });
}
function setVendorRadio(vendor: SpatialByokVendor): void {
  byokVendorRadios.forEach((r) => {
    r.checked = r.value === vendor;
  });
}

/**
 * Show only the section for the currently-selected mode, and within
 * `on-device` toggle the local-server endpoint group based on the backend
 * sub-pick. Also adjusts the api-key input placeholder for the selected
 * BYOK vendor.
 */
function updateProviderUI(): void {
  const mode = getSelectedMode();
  onDeviceSection.style.display = mode === "on-device" ? "" : "none";
  motebitCloudSection.style.display = mode === "motebit-cloud" ? "" : "none";
  byokSection.style.display = mode === "byok" ? "" : "none";

  // on-device sub-state
  const backend = getSelectedBackend();
  localServerEndpointGroup.style.display =
    mode === "on-device" && backend === "local-server" ? "" : "none";

  // byok placeholder
  const vendor = getSelectedVendor();
  apiKeyInput.placeholder =
    vendor === "openai" ? "sk-..." : vendor === "google" ? "AIza..." : "sk-ant-...";
}

modeRadios.forEach((r) => r.addEventListener("change", updateProviderUI));
onDeviceBackendRadios.forEach((r) => r.addEventListener("change", updateProviderUI));
byokVendorRadios.forEach((r) => r.addEventListener("change", updateProviderUI));

// === Soul Color Picker ===

let activeColorPreset = "moonlight";

function swatchGradient(tint: [number, number, number], glow: [number, number, number]): string {
  const tr = Math.round(tint[0] * 200),
    tg = Math.round(tint[1] * 200),
    tb = Math.round(tint[2] * 200);
  const gr = Math.round(glow[0] * 255),
    gg = Math.round(glow[1] * 255),
    gb = Math.round(glow[2] * 255);
  return `radial-gradient(circle at 40% 40%, rgba(${gr},${gg},${gb},0.6), rgba(${tr},${tg},${tb},0.8))`;
}

function buildColorSwatches(settings: SpatialSettings): void {
  if (!colorSwatches) return;
  colorSwatches.innerHTML = "";
  activeColorPreset = settings.appearance.colorPreset;

  // Preset swatches
  for (const [name, color] of Object.entries(COLOR_PRESETS)) {
    const swatch = document.createElement("div");
    swatch.className = `color-swatch${name === activeColorPreset ? " active" : ""}`;
    swatch.style.background = swatchGradient(color.tint, color.glow);
    swatch.title = name;
    swatch.addEventListener("click", () => {
      activeColorPreset = name;
      app.setInteriorColor(name);
      if (customColorPicker) customColorPicker.style.display = "none";
      // Update active states
      colorSwatches
        .querySelectorAll(".color-swatch")
        .forEach((el) => el.classList.remove("active"));
      swatch.classList.add("active");
    });
    colorSwatches.appendChild(swatch);
  }

  // Custom swatch
  const custom = document.createElement("div");
  custom.className = `color-swatch custom-swatch${activeColorPreset === "custom" ? " active" : ""}`;
  custom.title = "custom";
  custom.addEventListener("click", () => {
    activeColorPreset = "custom";
    if (customColorPicker) customColorPicker.style.display = "block";
    colorSwatches.querySelectorAll(".color-swatch").forEach((el) => el.classList.remove("active"));
    custom.classList.add("active");
    applyCustomColor();
  });
  colorSwatches.appendChild(custom);

  // Apply saved color
  if (settings.appearance.colorPreset === "custom") {
    if (customColorPicker) customColorPicker.style.display = "block";
    if (hueSlider) hueSlider.value = String(settings.appearance.customHue ?? 220);
    if (satSlider)
      satSlider.value = String(Math.round((settings.appearance.customSaturation ?? 0.7) * 100));
    applyCustomColor();
  } else {
    app.setInteriorColor(settings.appearance.colorPreset);
  }
}

function applyCustomColor(): void {
  const hue = hueSlider ? parseFloat(hueSlider.value) : 220;
  const sat = satSlider ? parseFloat(satSlider.value) / 100 : 0.7;
  app.setInteriorColorDirect(deriveInteriorColor(hue, sat));
}

hueSlider?.addEventListener("input", applyCustomColor);
satSlider?.addEventListener("input", applyCustomColor);

// === MCP Server Management ===

function renderMcpServers(): void {
  if (!mcpServerList) return;
  const servers = app.getMcpServers();
  mcpServerList.innerHTML = "";
  for (const server of servers) {
    const item = document.createElement("div");
    item.className = "mcp-server-item";

    const dot = document.createElement("span");
    dot.className = `mcp-server-dot ${server.connected ? "connected" : "disconnected"}`;

    const name = document.createElement("span");
    name.className = "mcp-server-name";
    name.textContent = server.name;

    const tools = document.createElement("span");
    tools.className = "mcp-server-tools";
    tools.textContent = `${server.toolCount} tools`;

    const actions = document.createElement("span");
    actions.className = "mcp-server-actions";

    const trustBtn = document.createElement("button");
    trustBtn.textContent = server.trusted ? "Untrust" : "Trust";
    trustBtn.addEventListener("click", () => {
      void app.setMcpServerTrust(server.name, !server.trusted).then(() => renderMcpServers());
    });

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      void app.removeMcpServer(server.name).then(() => renderMcpServers());
    });

    actions.appendChild(trustBtn);
    actions.appendChild(removeBtn);
    item.appendChild(dot);
    item.appendChild(name);
    item.appendChild(tools);
    item.appendChild(actions);
    mcpServerList.appendChild(item);
  }
}

mcpAddBtn?.addEventListener("click", () => {
  const name = mcpAddName?.value.trim() ?? "";
  const url = mcpAddUrl?.value.trim() ?? "";
  if (!name || !url) return;
  if (mcpAddBtn != null) {
    mcpAddBtn.disabled = true;
    mcpAddBtn.textContent = "Connecting...";
  }
  void app
    .addMcpServer({
      name,
      transport: "http" as const,
      url,
      motebit: mcpAddMotebit?.checked ?? false,
    })
    .then(() => {
      if (mcpAddName) mcpAddName.value = "";
      if (mcpAddUrl) mcpAddUrl.value = "";
      if (mcpAddMotebit) mcpAddMotebit.checked = false;
      renderMcpServers();
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      statusEl.textContent = `MCP failed: ${msg}`;
    })
    .finally(() => {
      if (mcpAddBtn != null) {
        mcpAddBtn.disabled = false;
        mcpAddBtn.textContent = "Add";
      }
    });
});

settingsSave?.addEventListener(
  "click",
  (e) =>
    void (async (e: Event) => {
      e.preventDefault();
      const settings: SpatialSettings = {
        mode: getSelectedMode(),
        onDeviceBackend: getSelectedBackend(),
        byokVendor: getSelectedVendor(),
        localServerEndpoint: localServerEndpointInput.value.trim() || DEFAULT_OLLAMA_URL,
        apiKey: apiKeyInput.value.trim(),
        model: modelInput.value.trim(),
        voiceEnabled: voiceToggle.checked,
        openaiApiKey: openaiKeyInput?.value.trim() ?? "",
        ttsVoice: (ttsVoiceSelect?.value as OpenAITTSVoice) ?? "nova",
        vadSensitivity: vadSlider ? parseFloat(vadSlider.value) : 0.5,
        proactiveEnabled: proactiveToggle?.checked ?? true,
        relayUrl: relayUrlInput?.value.trim() ?? "https://relay.motebit.com",
        showNetwork: showNetworkToggle?.checked ?? true,
        appearance: {
          colorPreset: activeColorPreset,
          customHue: hueSlider ? parseFloat(hueSlider.value) : 220,
          customSaturation: satSlider ? parseFloat(satSlider.value) / 100 : 0.7,
        },
        maxTokens: parseInt(
          (document.getElementById("settings-max-tokens") as HTMLSelectElement)?.value ?? "4096",
          10,
        ),
        governance: loadSettings().governance,
      };
      saveSettings(settings);

      // Apply network settings — disconnect and reconnect if relay changed
      await app.disconnectRelay();
      app.setNetworkSettings({ relayUrl: settings.relayUrl, showNetwork: settings.showNetwork });

      if (!(await tryInitAI(settings))) {
        const vendorLabel =
          settings.byokVendor === "openai"
            ? "OpenAI"
            : settings.byokVendor === "google"
              ? "Google"
              : "Anthropic";
        statusEl.textContent =
          settings.mode === "byok" ? `API key required for ${vendorLabel}` : "Provider unavailable";
        return;
      }

      void initVoiceIfEnabled(settings);
      void app.connectRelay().then(() => void loadCredentials());
      renderMcpServers();
      settingsOverlay.classList.add("hidden");
      showMainOverlay();
    })(e),
);

settingsSkip?.addEventListener("click", () => {
  // Skip AI — just run the creature with idle cues
  settingsOverlay.classList.add("hidden");
  showMainOverlay();
});

// === Flat preview (non-XR fallback) ===

function startFlatPreview(): void {
  app.adapter.setCreatureWorldPosition(0, 0, -0.5);

  let prevTime = performance.now();

  function loop(now: number): void {
    const dt = (now - prevTime) / 1000;
    prevTime = now;
    const time = now / 1000;

    app.renderFrame(dt, time);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  window.addEventListener("resize", () => {
    app.adapter.resize(window.innerWidth, window.innerHeight);
  });
  app.adapter.resize(window.innerWidth, window.innerHeight);
}

// === AR Session ===

async function startAR(): Promise<void> {
  statusEl.textContent = "Starting AR session...";
  enterButton.disabled = true;

  const success = await app.adapter.startSession({
    requiredFeatures: ["local-floor"],
    optionalFeatures: ["hand-tracking", "light-estimation"],
  });

  if (!success) {
    statusEl.textContent = "Failed to start AR session";
    enterButton.disabled = false;
    return;
  }

  overlay.classList.add("hidden");

  const renderer = app.adapter.getRenderer()!;
  lastTime = performance.now();

  // WebXR animation loop — receives timestamp and XRFrame
  renderer.setAnimationLoop((time: number, frame?: XRFrame) => {
    const now = time || performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    const t = now / 1000;

    // Get head position from XR camera
    const camera = renderer.xr.getCamera();
    const headPos: [number, number, number] = [
      camera.position.x,
      camera.position.y,
      camera.position.z,
    ];

    // Tick orbital dynamics — positions creature relative to shoulder
    app.tickOrbital(dt, t, headPos);

    // Gaze-based attention: check if user is looking at the local creature
    updateGazeAttention(camera, headPos);

    // Hand gesture recognition (requires XRFrame + hand-tracking feature)
    const session = renderer.xr.getSession();
    const refSpace = renderer.xr.getReferenceSpace();
    if (session && frame && refSpace) {
      for (const source of session.inputSources) {
        if (source.hand) {
          app.gestures.update(
            source.hand,
            source.handedness === "left" ? "left" : "right",
            refSpace,
            frame,
          );
        }
      }
    }

    // Render with behavior cues from runtime (or idle cues)
    app.renderFrame(dt, t);
  });

  // Listen for session end
  const session = renderer.xr.getSession();
  if (session) {
    session.addEventListener("end", () => {
      renderer.setAnimationLoop(null);
      overlay.classList.remove("hidden");
      enterButton.disabled = false;
      statusEl.textContent = "Session ended";
      app.dynamics.reset();
      app.gestures.reset();
      lastGazeHit = false;
    });
  }
}

// === Gaze Attention ===

/**
 * Gaze-based attention: check if user's gaze ray passes near the creature.
 * Uses camera forward vector and estimated creature position from orbital state.
 */
function updateGazeAttention(
  camera: {
    matrixWorld: { elements: ArrayLike<number> };
    position: { x: number; y: number; z: number };
  },
  headPos: [number, number, number],
): void {
  // Extract camera forward vector from matrixWorld (3rd column, negated for -Z forward)
  const m = camera.matrixWorld.elements;
  const fwdX = -m[8]!;
  const fwdY = -m[9]!;
  const fwdZ = -m[10]!;

  const [cx, cy, cz] = headPos;

  // Estimate creature world position from orbital state + anthropometry
  // Shoulder right: head + (0.20, -0.35, -0.05)
  const state = app.dynamics.getState();
  const anchorX = cx + 0.2;
  const anchorY = cy - 0.35;
  const anchorZ = cz - 0.05;

  // Orbital offset from anchor
  const creX = anchorX + Math.cos(state.angle) * state.radius;
  const creY = anchorY; // Bob handled by render engine
  const creZ = anchorZ + Math.sin(state.angle) * state.radius;

  // Vector from camera to creature
  const dx = creX - cx;
  const dy = creY - cy;
  const dz = creZ - cz;

  // Project onto forward direction
  const proj = dx * fwdX + dy * fwdY + dz * fwdZ;

  // Perpendicular distance from gaze ray to creature
  const perpX = dx - proj * fwdX;
  const perpY = dy - proj * fwdY;
  const perpZ = dz - proj * fwdZ;
  const perpDist = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);

  const gazeHit = perpDist < 0.2 && proj > 0; // Must be in front of camera

  if (gazeHit && !lastGazeHit) {
    app.bumpAttention(0.2);
  } else if (!gazeHit && lastGazeHit) {
    app.decayAttention();
  }

  lastGazeHit = gazeHit;
}

// === Credentials ===

async function loadCredentials(): Promise<void> {
  const countEl = document.getElementById("spatial-credentials-count");
  const listEl = document.getElementById("spatial-credentials-list");
  if (!countEl || !listEl) return;

  const settings = loadSettings();
  if (!settings.relayUrl || !settings.showNetwork) return;

  try {
    const resp = await fetch(`${settings.relayUrl}/api/v1/agents/${app.motebitId}/credentials`);
    if (!resp.ok) return;
    const data = (await resp.json()) as {
      credentials?: Array<{
        credential_type: string;
        credential: { issuer?: string | { id?: string }; issuanceDate?: string };
        issued_at: number;
      }>;
    };
    const creds = data.credentials ?? [];
    countEl.textContent = `${creds.length} credential${creds.length !== 1 ? "s" : ""}`;
    listEl.innerHTML = "";
    for (const cred of creds) {
      const item = document.createElement("div");
      item.style.cssText =
        "font-size:12px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;";
      const typeName = (cred.credential_type || "unknown")
        .replace("Agent", "")
        .replace("Credential", "");
      const dateStr = cred.credential.issuanceDate
        ? new Date(cred.credential.issuanceDate).toLocaleDateString()
        : new Date(cred.issued_at).toLocaleDateString();
      const typeSpan = document.createElement("span");
      typeSpan.style.opacity = "0.7";
      typeSpan.textContent = typeName;
      const dateSpan = document.createElement("span");
      dateSpan.style.cssText = "opacity:0.35;font-size:11px;";
      dateSpan.textContent = dateStr;
      item.appendChild(typeSpan);
      item.appendChild(dateSpan);
      listEl.appendChild(item);
    }
  } catch {
    // Best-effort — relay may be offline
  }
}

// === Handle input ===
// Touch/pinch increases attention (closer orbit, brighter glow)

document.addEventListener("pointerdown", () => {
  app.bumpAttention(0.3);
});

document.addEventListener("pointerup", () => {
  app.decayAttention();
});

// === Start ===

init().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  statusEl.textContent = `Error: ${msg}`;
});
