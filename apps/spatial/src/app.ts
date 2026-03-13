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
import { WebXRThreeJSAdapter } from "@motebit/render-engine";
import { SpatialVoicePipeline } from "./voice-pipeline";
import type { OpenAITTSVoice } from "@motebit/voice";

// === DOM elements ===

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLElement;
const enterButton = document.getElementById("enter-ar") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;

// Settings elements
const settingsOverlay = document.getElementById("settings-overlay") as HTMLElement;
const providerSelect = document.getElementById("provider-select") as HTMLSelectElement;
const apiKeyInput = document.getElementById("api-key-input") as HTMLInputElement;
const apiKeyGroup = document.getElementById("api-key-group") as HTMLElement;
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

// Gaze overlay (reserved for future presence visualization)
const gazeOverlay = document.getElementById("gaze-overlay") as HTMLElement | null;

// === State ===

const app = new SpatialApp();
let lastTime = 0;

// Gaze attention state
let lastGazeHit = false;

// === Settings persistence ===

interface SpatialSettings {
  provider: "anthropic" | "ollama";
  apiKey: string;
  model: string;
  voiceEnabled: boolean;
  openaiApiKey: string;
  ttsVoice: OpenAITTSVoice;
  vadSensitivity: number;
  proactiveEnabled: boolean;
  relayUrl: string;
  showNetwork: boolean;
  colorPreset: string;
  customHue: number;
  customSaturation: number;
}

function loadSettings(): SpatialSettings {
  try {
    const raw = localStorage.getItem("motebit:spatial_settings");
    if (raw != null && raw !== "") {
      const parsed = JSON.parse(raw) as Partial<SpatialSettings>;
      return {
        provider: parsed.provider ?? "anthropic",
        apiKey: parsed.apiKey ?? "",
        model: parsed.model ?? "",
        voiceEnabled: parsed.voiceEnabled ?? true,
        openaiApiKey: parsed.openaiApiKey ?? "",
        ttsVoice: parsed.ttsVoice ?? "nova",
        vadSensitivity: parsed.vadSensitivity ?? 0.5,
        proactiveEnabled: parsed.proactiveEnabled ?? true,
        relayUrl: parsed.relayUrl ?? "https://motebit-sync.fly.dev",
        showNetwork: parsed.showNetwork ?? true,
        colorPreset: parsed.colorPreset ?? "moonlight",
        customHue: parsed.customHue ?? 220,
        customSaturation: parsed.customSaturation ?? 0.7,
      };
    }
  } catch {
    /* ignore */
  }
  return {
    provider: "anthropic",
    apiKey: "",
    model: "",
    voiceEnabled: true,
    openaiApiKey: "",
    ttsVoice: "nova",
    vadSensitivity: 0.5,
    proactiveEnabled: true,
    relayUrl: "https://motebit-sync.fly.dev",
    showNetwork: true,
    colorPreset: "moonlight",
    customHue: 220,
    customSaturation: 0.7,
  };
}

function saveSettings(s: SpatialSettings): void {
  localStorage.setItem("motebit:spatial_settings", JSON.stringify(s));
}

// === Initialization ===

async function init(): Promise<void> {
  // Register service worker for PWA
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW registration failure is non-fatal
    });
  }

  // Bootstrap identity (generates keypair on first launch)
  await app.bootstrap();

  // Initialize WebXR adapter
  await app.init(canvas);

  // Load saved settings and populate form
  const settings = loadSettings();
  providerSelect.value = settings.provider;
  apiKeyInput.value = settings.apiKey;
  modelInput.value = settings.model;
  voiceToggle.checked = settings.voiceEnabled;
  if (openaiKeyInput) openaiKeyInput.value = settings.openaiApiKey;
  if (ttsVoiceSelect) ttsVoiceSelect.value = settings.ttsVoice;
  if (vadSlider) vadSlider.value = String(settings.vadSensitivity);
  if (proactiveToggle) proactiveToggle.checked = settings.proactiveEnabled;
  if (relayUrlInput) relayUrlInput.value = settings.relayUrl;
  if (showNetworkToggle) showNetworkToggle.checked = settings.showNetwork;
  updateProviderUI(settings.provider);
  buildColorSwatches(settings);

  // Apply network settings (best-effort relay — does not block boot)
  app.setNetworkSettings({ relayUrl: settings.relayUrl, showNetwork: settings.showNetwork });

  // If we have a saved config that can init, skip settings
  if (await tryInitAI(settings)) {
    settingsOverlay.classList.add("hidden");
    void initVoiceIfEnabled(settings);
    // Connect to relay after AI init — best-effort, non-blocking
    void app.connectRelay().then(() => void loadCredentials());
    renderMcpServers();
    showMainOverlay();
  } else {
    // Show settings overlay first
    settingsOverlay.classList.remove("hidden");
    overlay.classList.add("hidden");
  }
}

async function tryInitAI(settings: SpatialSettings): Promise<boolean> {
  const config: SpatialAIConfig = {
    provider: settings.provider,
    model: settings.model || undefined,
    apiKey: settings.apiKey || undefined,
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

// === Settings UI ===

providerSelect?.addEventListener("change", () => {
  updateProviderUI(providerSelect.value as "anthropic" | "ollama");
});

function updateProviderUI(provider: string): void {
  if (apiKeyGroup != null) {
    apiKeyGroup.style.display = provider === "anthropic" ? "block" : "none";
  }
}

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
  activeColorPreset = settings.colorPreset;

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
  if (settings.colorPreset === "custom") {
    if (customColorPicker) customColorPicker.style.display = "block";
    if (hueSlider) hueSlider.value = String(settings.customHue);
    if (satSlider) satSlider.value = String(Math.round(settings.customSaturation * 100));
    applyCustomColor();
  } else {
    app.setInteriorColor(settings.colorPreset);
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
  if (mcpAddBtn) {
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
      if (mcpAddBtn) {
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
        provider: providerSelect.value as "anthropic" | "ollama",
        apiKey: apiKeyInput.value.trim(),
        model: modelInput.value.trim(),
        voiceEnabled: voiceToggle.checked,
        openaiApiKey: openaiKeyInput?.value.trim() ?? "",
        ttsVoice: (ttsVoiceSelect?.value as OpenAITTSVoice) ?? "nova",
        vadSensitivity: vadSlider ? parseFloat(vadSlider.value) : 0.5,
        proactiveEnabled: proactiveToggle?.checked ?? true,
        relayUrl: relayUrlInput?.value.trim() ?? "https://motebit-sync.fly.dev",
        showNetwork: showNetworkToggle?.checked ?? true,
        colorPreset: activeColorPreset,
        customHue: hueSlider ? parseFloat(hueSlider.value) : 220,
        customSaturation: satSlider ? parseFloat(satSlider.value) / 100 : 0.7,
      };
      saveSettings(settings);

      // Apply network settings — disconnect and reconnect if relay changed
      await app.disconnectRelay();
      app.setNetworkSettings({ relayUrl: settings.relayUrl, showNetwork: settings.showNetwork });

      if (!(await tryInitAI(settings))) {
        statusEl.textContent = "API key required for Anthropic";
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
    updateDelegationIndicator();
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

    // Check gaze against visitors and ghost
    updatePresenceGaze(camera, headPos);

    // Update delegation active indicator
    updateDelegationIndicator();

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
      hideGazeOverlay();
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

// === Gaze & Delegation Overlays (reserved for future presence visualization) ===

function updatePresenceGaze(
  _camera: {
    matrixWorld: { elements: ArrayLike<number> };
    position: { x: number; y: number; z: number };
  },
  _headPos: [number, number, number],
): void {}

function hideGazeOverlay(): void {
  gazeOverlay?.classList.add("hidden");
}

function updateDelegationIndicator(): void {}

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
