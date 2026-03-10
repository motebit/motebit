/**
 * Spatial app entry point — the glass creature in physical space.
 *
 * Initializes the SpatialApp platform shell, wires settings UI, voice pipeline,
 * gesture recognition, gaze attention, and WebXR session. The creature has
 * intelligence, memory, identity, and ambient voice interaction — the same
 * sovereign runtime that powers the desktop app, with browser-native substitutions.
 */

import { SpatialApp } from "./spatial-app";
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

// Voice indicator
const voiceIndicator = document.getElementById("voice-indicator") as HTMLElement;

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
  updateProviderUI(settings.provider);

  // If we have a saved config that can init, skip settings
  if (await tryInitAI(settings)) {
    settingsOverlay.classList.add("hidden");
    void initVoiceIfEnabled(settings);
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
      };
      saveSettings(settings);

      if (!(await tryInitAI(settings))) {
        statusEl.textContent = "API key required for Anthropic";
        return;
      }

      void initVoiceIfEnabled(settings);
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

    // Gaze-based attention: check if user is looking at the creature
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
