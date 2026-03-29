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
  saveSubscriptionTier,
} from "./storage";
import { ProxySession } from "@motebit/runtime";
import type { ProxyProviderConfig } from "@motebit/runtime";
import { deriveInteriorColor } from "./ui/color-picker";
import { initColorPicker } from "./ui/color-picker";
import {
  checkWebGPU,
  WebLLMProvider,
  PROXY_BASE_URL,
  detectOllamaModels,
  DEFAULT_OLLAMA_URL,
} from "./providers";
import { initChat, addMessage, showToast } from "./ui/chat";
import { initSettings } from "./ui/settings";
import { initSubscription } from "./ui/subscription";
import { initConversations } from "./ui/conversations";
import { initVoice } from "./ui/voice";
import { setStreamingTTSEnabled, isTTSAudioPlaying, setTTSVoice } from "./ui/chat";
import { computeSpeechEnergy } from "@motebit/voice";
import { loadVoiceConfig } from "./storage";
import { initGatedPanels } from "./ui/gated-panels";
import { initSovereignPanels } from "./ui/sovereign-panels";
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
    // When TTS finishes, resume listening for the next turn
    if (wasTTSPlaying && !playing) {
      voiceAPI.resumeListening();
    }
    wasTTSPlaying = playing;
    requestAnimationFrame(syncTTS);
  };
  let wasTTSPlaying = false;
  requestAnimationFrame(syncTTS);
}

const slashCommands = initSlashCommands(ctx, {
  openSettings: () => settings.open(),
  openConversations: () => conversations.open(),
  openShortcuts: () => openShortcutDialog(),
  openMemory: (auditNodeIds) => gatedPanels.openMemory(auditNodeIds),
  openGoals: () => gatedPanels.openGoals(),
  openAgents: () => gatedPanels.openAgents(),
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

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (sovereignPanel.classList.contains("open")) {
      sovereignPanels.close();
    } else if (memoryPanel.classList.contains("open") || goalsPanel.classList.contains("open")) {
      gatedPanels.closeAll();
    } else if (conversationsPanel.classList.contains("open")) {
      conversations.close();
    } else if (settingsModal.classList.contains("open")) {
      settings.close();
    }
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
    saveToken: (data) => saveProxyToken(data),
    clearToken: () => clearProxyToken(),
    saveTier: (tier) => saveSubscriptionTier(tier),
    onProviderReady: (proxyConfig: ProxyProviderConfig) => {
      const config: ProviderConfig = {
        type: "proxy",
        model: proxyConfig.model,
        proxyToken: proxyConfig.proxyToken,
      };
      app.connectProvider(config);
      currentConfig = config;
      saveProviderConfig(config);
      settings.updateModelIndicator();
      settings.updateConnectPrompt();
      subscription.updateTierDisplay();
    },
  },
  PROXY_BASE_URL,
);

/** Try to connect via the proxy — delegates to shared ProxySession. */
async function autoInitProxy(): Promise<boolean> {
  return proxySession.bootstrap();
}

/**
 * Detect any local inference server — Ollama, LM Studio, LocalAI, llama.cpp, Jan, vLLM.
 * Probes known ports in parallel. First to respond with a model list wins.
 * All speak OpenAI-compatible /v1/models (Ollama also probed via /api/tags).
 */
const LOCAL_INFERENCE_ENDPOINTS = [
  { url: DEFAULT_OLLAMA_URL, type: "ollama" as const }, // :11434
  { url: "http://localhost:1234", type: "openai" as const }, // LM Studio
  { url: "http://localhost:8080", type: "openai" as const }, // LocalAI / llama.cpp
  { url: "http://localhost:1337", type: "openai" as const }, // Jan
  { url: "http://localhost:8000", type: "openai" as const }, // vLLM
] as const;

async function probeLocalModels(
  baseUrl: string,
  type: "ollama" | "openai",
): Promise<{ baseUrl: string; type: "ollama" | "openai"; models: string[] } | null> {
  try {
    // Try Ollama-native API first for Ollama, then OpenAI-compatible for all
    if (type === "ollama") {
      const models = await detectOllamaModels(baseUrl);
      if (models.length > 0) return { baseUrl, type, models };
    }
    // OpenAI-compatible /v1/models
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const models = (data.data ?? []).map((m) => m.id);
    if (models.length > 0) return { baseUrl, type: "openai", models };
  } catch {
    // Not running on this port
  }
  return null;
}

/** Prefer the largest/best model from a list. */
function pickBestModel(models: string[]): string {
  return (
    models.find((m) => m.includes("70b")) ??
    models.find((m) => m.includes("32b")) ??
    models.find((m) => m.includes("8b")) ??
    models[0]!
  );
}

async function autoInitLocalInference(): Promise<boolean> {
  // Race all probes — first to find models wins
  const probes = LOCAL_INFERENCE_ENDPOINTS.map((ep) => probeLocalModels(ep.url, ep.type));
  const results = await Promise.allSettled(probes);

  // Find the first successful probe
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      const { baseUrl, type, models } = result.value;
      const model = pickBestModel(models);
      const config: ProviderConfig =
        type === "ollama" ? { type: "ollama", model, baseUrl } : { type: "openai", model, baseUrl };
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
    const config = { type: "webllm" as const, model };
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
      soulColor.preset === "custom" &&
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
    } else if (soulColor.preset !== "moonlight") {
      colorPicker.setSelectedPreset(soulColor.preset);
      app.setInteriorColor(soulColor.preset);
    }
  }

  // Restore provider config and auto-connect
  const savedConfig = loadProviderConfig();
  if (savedConfig != null) {
    if (savedConfig.type === "proxy") {
      // For proxy users, always go through autoInitProxy to handle token refresh
      void autoInitProxy().then(async (ok) => {
        if (!ok) ok = await autoInitLocalInference();
        if (!ok && checkWebGPU()) await autoInitWebLLM();
        settings.updateConnectPrompt();
      });
    } else if (savedConfig.type === "webllm") {
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

  // Check for checkout return — verify payment and activate subscription
  const checkoutSessionId = new URLSearchParams(window.location.search).get("checkout_session_id");
  if (checkoutSessionId) {
    // Clean URL immediately so refreshes don't re-trigger
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("checkout_session_id");
    window.history.replaceState({}, "", cleanUrl.toString());

    // Verify with relay, then bootstrap proxy to switch to cloud provider
    subscription
      .verifyCheckoutAndActivate(checkoutSessionId)
      .then(() => {
        void autoInitProxy().then((ok) => {
          if (ok) {
            settings.updateModelIndicator();
            settings.updateConnectPrompt();
          }
        });
      })
      .catch(() => {});
  }

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
  for (const msg of history) {
    if (msg.role === "user" || msg.role === "assistant") {
      // Strip any tags that leaked into stored content (e.g. <thinking> from older sessions)
      const clean = msg.content
        .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
        .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
        .replace(/<state\s+[^>]*\/>/g, "")
        .replace(/ {2,}/g, " ")
        .trim();
      if (clean) addMessage(msg.role, clean, true);
    }
  }
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("Motebit bootstrap failed:", err);
});
