/**
 * Spatial app entry point — the glass creature in physical space.
 *
 * Initializes the SpatialApp platform shell, wires settings UI, voice,
 * and WebXR session. The creature has intelligence, memory, identity,
 * and ambient voice interaction — the same sovereign runtime that
 * powers the desktop app, with browser-native substitutions.
 */

import { SpatialApp } from "./spatial-app";
import type { SpatialAIConfig } from "./spatial-app";
import { WebXRThreeJSAdapter } from "@motebit/render-engine";
import { VoiceInterface } from "./voice";

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

// Voice indicator
const voiceIndicator = document.getElementById("voice-indicator") as HTMLElement;

// === State ===

const app = new SpatialApp();
let lastTime = 0;

// === Settings persistence ===

interface SpatialSettings {
  provider: "anthropic" | "ollama";
  apiKey: string;
  model: string;
  voiceEnabled: boolean;
}

function loadSettings(): SpatialSettings {
  try {
    const raw = localStorage.getItem("motebit:spatial_settings");
    if (raw) return JSON.parse(raw) as SpatialSettings;
  } catch { /* ignore */ }
  return { provider: "anthropic", apiKey: "", model: "", voiceEnabled: true };
}

function saveSettings(s: SpatialSettings): void {
  localStorage.setItem("motebit:spatial_settings", JSON.stringify(s));
}

// === Initialization ===

async function init(): Promise<void> {
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
  updateProviderUI(settings.provider);

  // If we have a saved config that can init, skip settings
  if (await tryInitAI(settings)) {
    settingsOverlay.classList.add("hidden");
    initVoiceIfEnabled(settings.voiceEnabled);
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
  return app.initAI(config);
}

function initVoiceIfEnabled(enabled: boolean): void {
  if (enabled && VoiceInterface.isSupported()) {
    const started = app.startVoice();
    if (started && voiceIndicator) {
      voiceIndicator.classList.remove("hidden");
    }
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
      enterButton.addEventListener("click", startAR);
    }
  });
}

// === Settings UI ===

providerSelect?.addEventListener("change", () => {
  updateProviderUI(providerSelect.value as "anthropic" | "ollama");
});

function updateProviderUI(provider: string): void {
  if (apiKeyGroup) {
    apiKeyGroup.style.display = provider === "anthropic" ? "block" : "none";
  }
}

settingsSave?.addEventListener("click", async (e) => {
  e.preventDefault();
  const settings: SpatialSettings = {
    provider: providerSelect.value as "anthropic" | "ollama",
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim(),
    voiceEnabled: voiceToggle.checked,
  };
  saveSettings(settings);

  if (!await tryInitAI(settings)) {
    statusEl.textContent = "API key required for Anthropic";
    return;
  }

  initVoiceIfEnabled(settings.voiceEnabled);
  settingsOverlay.classList.add("hidden");
  showMainOverlay();
});

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

  // WebXR animation loop
  renderer.setAnimationLoop((time: number) => {
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
    });
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
