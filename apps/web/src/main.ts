import { WebApp } from "./web-app";
import type { WebContext } from "./types";
import type { ProviderConfig } from "./storage";
import {
  loadProviderConfig,
  loadSoulColor,
  loadSyncUrl,
  saveProviderConfig,
  loadProxyToken,
  saveProxyToken,
  clearProxyToken,
  saveBalance,
} from "./storage";
import { ProxySession } from "@motebit/runtime";
import type { ProxyProviderConfig } from "@motebit/runtime";
import { deriveInteriorColor } from "./ui/color-picker";
import { initColorPicker } from "./ui/color-picker";
import { checkWebGPU, WebLLMProvider, PROXY_BASE_URL } from "./providers";
import {
  probeLocalModels,
  pickBestModel,
  cleanConversationHistory,
  DEFAULT_LOCAL_ENDPOINTS,
} from "./bootstrap";
import { initChat, addMessage, showToast } from "./ui/chat";
import { initSettings } from "./ui/settings";
import { initPairing, startLinkDevice, startClaimDevice } from "./ui/pairing";
import { initSubscription } from "./ui/subscription";
import { initConversations } from "./ui/conversations";
import { initVoice } from "./ui/voice";
import {
  setStreamingTTSEnabled,
  isTTSAudioPlaying,
  setTTSVoice,
  setStreamingTTSProvider,
} from "./ui/chat";
import {
  computeSpeechEnergy,
  ElevenLabsTTSProvider,
  InworldTTSProvider,
  DeepgramSpeakTTSProvider,
  WebSpeechTTSProvider,
  FallbackTTSProvider,
  type TTSProvider,
} from "@motebit/voice";
import { loadVoiceConfig, getVendorKey } from "./storage";
import { initGatedPanels } from "./ui/gated-panels";
import { initSovereignPanels } from "./ui/sovereign-panels";
import { initSkillsPanel } from "./ui/skills-panel";
import { initTheme } from "./ui/theme";
import { initSlashCommands } from "./ui/slash-commands";
import { initKeyboard, openShortcutDialog } from "./ui/keyboard";

// === Core Objects ===

const canvas = document.getElementById("motebit-canvas") as HTMLCanvasElement | null;
if (canvas == null) throw new Error("Canvas element #motebit-canvas not found");

const app = new WebApp();
let currentConfig: ProviderConfig | null = null;

// === Web Context ===

const ctx: WebContext = {
  app,
  getConfig: () => currentConfig,
  setConfig: (c) => {
    currentConfig = c;
  },
  addMessage,
  showToast,
  bootstrapProxy: () => proxySession.bootstrap(),
};

// === Module Init ===

const colorPicker = initColorPicker(ctx, () => {
  voiceAPI.updateVoiceGlowColor();
});

const chatAPI = initChat(ctx, {
  openSettings: () => settings.open(),
  openConversations: () => conversations.open(),
  openShortcuts: () => openShortcutDialog(),
});

const settings = initSettings(ctx, { colorPicker });
initPairing(ctx);
document
  .getElementById("settings-link-device")
  ?.addEventListener("click", () => startLinkDevice(ctx));
document
  .getElementById("settings-claim-device")
  ?.addEventListener("click", () => startClaimDevice(ctx));
const subscription = initSubscription(ctx);

const conversations = initConversations(ctx, {
  onLoad: () => {
    // Reload chat log from the newly loaded conversation
    const chatLog = document.getElementById("chat-log") as HTMLDivElement;
    chatLog.innerHTML = "";
    const history = app.getConversationHistory();
    for (const msg of history) {
      if (msg.role === "user" || msg.role === "assistant") {
        addMessage(msg.role, msg.content, true);
      }
    }
  },
});

const voiceAPI = initVoice(ctx, chatAPI, {
  onPresenceToggle(active) {
    setStreamingTTSEnabled(active);
  },
});

// Apply saved voice preference
const savedVoice = loadVoiceConfig();
if (savedVoice?.ttsVoice) setTTSVoice(savedVoice.ttsVoice);

// Build the TTS provider chain from stored BYOK keys. The voice section is
// the three voice majors (ElevenLabs / Deepgram / Inworld) — OpenAI lives
// in the LLM section only. Chain priority is quality + brand: ElevenLabs
// (premium) → Inworld (#1-ranked + cheap-at-scale + real-time) → Deepgram
// (real-time / low-latency) → Web Speech (zero-key terminal fallback).
// Each fallback catches transport/API failures, not in-session errors —
// the chain is defense in depth, not a live retry loop.
export function rebuildTTSProvider(): void {
  const chain: TTSProvider[] = [];
  const elevenKey = getVendorKey("elevenlabs");
  const inworldKey = getVendorKey("inworld");
  const deepgramKey = getVendorKey("deepgram");
  const preferredVoice = loadVoiceConfig()?.ttsVoice;

  if (elevenKey) {
    chain.push(new ElevenLabsTTSProvider({ apiKey: elevenKey, voice: preferredVoice }));
  }
  if (inworldKey) {
    chain.push(new InworldTTSProvider({ apiKey: inworldKey, voice: preferredVoice }));
  }
  if (deepgramKey) {
    chain.push(new DeepgramSpeakTTSProvider({ apiKey: deepgramKey, voice: preferredVoice }));
  }
  chain.push(new WebSpeechTTSProvider());

  setStreamingTTSProvider(chain.length === 1 ? chain[0]! : new FallbackTTSProvider(chain));
}
rebuildTTSProvider();

// Sync creature to TTS audio — mouth movement + gentle glow while speaking.
// Overrides the runtime's setSpeaking which fires on stream start/end, not audio start/end.
// Glow is subtler than user voice input (~30% intensity) — creature expresses, not reacts.
{
  const syncTTS = (now: number): void => {
    const playing = isTTSAudioPlaying();
    const runtime = app.getRuntime();
    if (runtime) {
      runtime.behavior.setSpeaking(playing);
    }
    if (playing) {
      const bands = computeSpeechEnergy(now / 1000);
      app.setAudioReactivity(bands);
    }
    // Bridge TTS state to the voice session — it suspends recognition on
    // TTS start and respawns it on TTS end so the floor hand-off is clean.
    if (wasTTSPlaying !== playing) {
      voiceAPI.setTtsSpeaking(playing);
    }
    wasTTSPlaying = playing;
    requestAnimationFrame(syncTTS);
  };
  let wasTTSPlaying = false;
  requestAnimationFrame(syncTTS);
}

// motebit-computer is gated as @experimental on web — see web-app.ts
// for the bridge gate. The /computer slash command and Option+C
// shortcut also no-op when the flag is off, so a user can't toggle
// a half-functional surface into view. Memory:
// motebit_computer_experimental_gate.md.
const slabExperimentalEnabled =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_EXPERIMENTAL_SLAB ===
  "true";

const slashCommands = initSlashCommands(ctx, {
  openSettings: () => settings.open(),
  openConversations: () => conversations.open(),
  openShortcuts: () => openShortcutDialog(),
  openMemory: (auditNodeIds) => gatedPanels.openMemory(auditNodeIds),
  openGoals: () => gatedPanels.openGoals(),
  openAgents: () => gatedPanels.openAgents(),
  toggleSlab: () =>
    slabExperimentalEnabled ? (app.getRenderer().toggleSlabVisible?.() ?? false) : false,
  newConversation: () => {
    app.resetConversation();
    const chatLog = document.getElementById("chat-log") as HTMLDivElement;
    chatLog.innerHTML = "";
  },
});
chatAPI.setSlashCommands(slashCommands);

const chatInput = document.getElementById("chat-input") as HTMLInputElement;
initKeyboard({
  focusInput: () => chatInput.focus(),
  openSettings: () => settings.open(),
  openConversations: () => conversations.open(),
  newConversation: () => {
    app.resetConversation();
    const chatLog = document.getElementById("chat-log") as HTMLDivElement;
    chatLog.innerHTML = "";
  },
});

const gatedPanels = initGatedPanels(ctx);
const sovereignPanels = initSovereignPanels(ctx);
const skillsPanel = initSkillsPanel(ctx);
// URL-driven entry: visiting /skills auto-opens the panel. The panel
// closes by popping the route back to /, so the back button does the
// expected thing.
skillsPanel.openIfRouted();

// === Theme ===

// Side-effect: sets up theme toggle + data-theme attribute.
// Liquescentia (3D environment) is always ENV_LIGHT — glass needs
// chromatic variation to refract. Dark mode only changes UI chrome.
void initTheme(false);

// === Escape Key Handler ===

const settingsModal = document.getElementById("settings-modal") as HTMLDivElement;
const conversationsPanel = document.getElementById("conversations-panel") as HTMLDivElement;
const memoryPanel = document.getElementById("memory-panel") as HTMLDivElement;
const goalsPanel = document.getElementById("goals-panel") as HTMLDivElement;
const sovereignPanel = document.getElementById("sovereign-panel") as HTMLDivElement;
const skillsPanelEl = document.getElementById("skills-panel") as HTMLDivElement;

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (skillsPanelEl.classList.contains("open")) {
      skillsPanel.close();
    } else if (sovereignPanel.classList.contains("open")) {
      sovereignPanels.close();
    } else if (memoryPanel.classList.contains("open") || goalsPanel.classList.contains("open")) {
      gatedPanels.closeAll();
    } else if (conversationsPanel.classList.contains("open")) {
      conversations.close();
    } else if (settingsModal.classList.contains("open")) {
      settings.close();
    }
  }
  // Motebit Computer toggle: Option+C (Alt+C). `e.code === "KeyC"`
  // avoids the macOS `Option+C → ç` remap that would silently break
  // matching on `e.key`. Gated behind VITE_EXPERIMENTAL_SLAB — when
  // off, the keystroke is a no-op so the broken toggle can't surface
  // a half-functional plane.
  if (slabExperimentalEnabled && e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyC") {
    e.preventDefault();
    app.getRenderer().toggleSlabVisible?.();
  }
});

// === Bootstrap ===

const DEFAULT_WEBLLM_MODEL = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

/** Shared proxy session — handles token lifecycle across all surfaces. */
const proxySession = new ProxySession(
  {
    getSyncUrl: () => loadSyncUrl(),
    getMotebitId: () => localStorage.getItem("motebit:motebit_id"),
    loadToken: () => loadProxyToken(),
    saveToken: (data) => {
      saveProxyToken(data);
      saveBalance(data.balanceUsd);
    },
    clearToken: () => clearProxyToken(),
    onProviderReady: (proxyConfig: ProxyProviderConfig) => {
      const config: ProviderConfig = {
        mode: "motebit-cloud",
        model: proxyConfig.model,
        proxyToken: proxyConfig.proxyToken,
      };
      app.connectProvider(config);
      currentConfig = config;
      saveProviderConfig(config);
      settings.updateModelIndicator();
      settings.updateConnectPrompt();
      subscription.updateBalanceDisplay();
    },
  },
  PROXY_BASE_URL,
);

/** Try to connect via the proxy — delegates to shared ProxySession. */
async function autoInitProxy(): Promise<boolean> {
  return proxySession.bootstrap();
}

async function autoInitLocalInference(): Promise<boolean> {
  // Race all probes — first to find models wins
  const probes = DEFAULT_LOCAL_ENDPOINTS.map((ep) => probeLocalModels(ep.url, ep.type));
  const results = await Promise.allSettled(probes);

  // Find the first successful probe
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      const { baseUrl, models } = result.value;
      const model = pickBestModel(models);
      // Both "ollama" and generic OpenAI-compat local servers collapse to the
      // same user-intent mode: on-device via local-server. createProvider()
      // picks the concrete transport from the endpoint shape.
      const config: ProviderConfig = {
        mode: "on-device",
        backend: "local-server",
        model,
        endpoint: baseUrl,
      };
      app.connectProvider(config);
      currentConfig = config;
      saveProviderConfig(config);
      settings.updateModelIndicator();
      settings.updateConnectPrompt();
      return true;
    }
  }
  return false;
}

/** Fallback: load a language model into the browser via WebLLM. */
async function autoInitWebLLM(model: string = DEFAULT_WEBLLM_MODEL): Promise<void> {
  const heading = document.getElementById("connect-prompt-heading");
  const text = document.getElementById("connect-prompt-text");
  const btn = document.getElementById("connect-prompt-btn");
  const progress = document.getElementById("connect-prompt-progress");
  const fill = document.getElementById("connect-prompt-progress-fill");

  if (heading) heading.textContent = "Waking up";
  if (text) text.textContent = "Preparing...";
  if (btn) btn.style.display = "none";
  if (progress) progress.style.display = "block";

  try {
    const provider = new WebLLMProvider(model);
    await provider.init((report) => {
      if (fill) fill.style.width = `${Math.round(report.progress * 100)}%`;
      if (text) {
        if (report.progress < 1) {
          text.textContent =
            report.text.length > 60 ? report.text.slice(0, 57) + "..." : report.text;
        } else {
          text.textContent = "Ready";
        }
      }
    });

    app.setProviderDirect(provider);
    const config: ProviderConfig = { mode: "on-device", backend: "webllm", model };
    currentConfig = config;
    saveProviderConfig(config);
    settings.updateModelIndicator();
    settings.updateConnectPrompt();
  } catch {
    if (heading) heading.textContent = "Give it a voice";
    if (text)
      text.textContent =
        "Open Settings to connect — your little drop of glass will start talking back.";
    if (btn) btn.style.display = "";
    if (progress) progress.style.display = "none";
  }
}

async function bootstrap(): Promise<void> {
  await app.init(canvas!);

  // Initialize IDB storage, migration, and runtime
  await app.bootstrap();

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

  // Restore soul color from localStorage
  const soulColor = loadSoulColor();
  if (soulColor != null) {
    if (
      soulColor.colorPreset === "custom" &&
      soulColor.customHue != null &&
      soulColor.customSaturation != null
    ) {
      colorPicker.setCustomHue(soulColor.customHue);
      colorPicker.setCustomSaturation(soulColor.customSaturation);
      colorPicker.setCustomInteriorColor(
        deriveInteriorColor(soulColor.customHue, soulColor.customSaturation),
      );
      colorPicker.setSelectedPreset("custom");
      app.setInteriorColorDirect(colorPicker.getCustomInteriorColor()!);
    } else if (soulColor.colorPreset !== "moonlight") {
      colorPicker.setSelectedPreset(soulColor.colorPreset);
      app.setInteriorColor(soulColor.colorPreset);
    }
  }

  // Restore provider config and auto-connect
  const savedConfig = loadProviderConfig();
  if (savedConfig != null) {
    if (savedConfig.mode === "motebit-cloud") {
      // For cloud users, always go through autoInitProxy to handle token refresh
      void autoInitProxy().then(async (ok) => {
        if (!ok) ok = await autoInitLocalInference();
        if (!ok && checkWebGPU()) await autoInitWebLLM();
        settings.updateConnectPrompt();
      });
    } else if (savedConfig.mode === "on-device" && savedConfig.backend === "webllm") {
      currentConfig = savedConfig;
      void autoInitWebLLM(savedConfig.model);
    } else {
      currentConfig = savedConfig;
      try {
        app.connectProvider(savedConfig);
        settings.updateModelIndicator();
      } catch {
        // Provider connection failed — user can reconnect via settings
      }
    }
  } else {
    // First visit — no subscription yet. Try local inference first (zero API cost).
    // Proxy is for paying subscribers only per metabolic principle.
    // Boot sequence: subscriber proxy → Ollama (local) → WebLLM (browser) → upgrade prompt.
    void autoInitProxy().then(async (ok) => {
      if (!ok) ok = await autoInitLocalInference();
      if (!ok && checkWebGPU()) await autoInitWebLLM();
      settings.updateConnectPrompt();
    });
  }

  // For returning users with saved config, update prompt immediately
  if (savedConfig != null) settings.updateConnectPrompt();

  // Deposit checkout returns are handled by the poll loop in the subscription UI.
  // No checkout_session_id handling needed — deposits use hosted mode (new tab).

  // Auto-connect sync if a relay URL was previously saved
  const syncUrl = loadSyncUrl();
  if (syncUrl) {
    app.startSync(syncUrl).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Sync failed: ${msg}`);
    });
  }

  // Restore conversation history into chat log (immediate = skip entrance animation)
  const history = app.getConversationHistory();
  const cleaned = cleanConversationHistory(history);
  for (const msg of cleaned) {
    addMessage(msg.role, msg.content, true);
  }
}

// Expose app for E2E test injection (setProviderDirect, isProviderConnected).
// No security cost — devtools already has full access to the running app.
window.__motebitApp = app;

bootstrap()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("Motebit bootstrap failed:", err);
  })
  .finally(() => {
    // Signal E2E tests that bootstrap attempt completed (success or failure).
    // The runtime may or may not have a provider — tests inject their own.
    window.__motebitReady = true;
  });
