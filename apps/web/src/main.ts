import { WebApp } from "./web-app";
import type { WebContext } from "./types";
import type { ProviderConfig } from "./storage";
import { loadProviderConfig, loadSoulColor, loadSyncUrl, saveProviderConfig } from "./storage";
import { deriveInteriorColor } from "./ui/color-picker";
import { initColorPicker } from "./ui/color-picker";
import { checkWebGPU, WebLLMProvider } from "./providers";
import { initChat, addMessage, showToast } from "./ui/chat";
import { initSettings } from "./ui/settings";
import { initConversations } from "./ui/conversations";
import { initVoice } from "./ui/voice";
import { initGatedPanels } from "./ui/gated-panels";
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

const voiceAPI = initVoice(ctx, chatAPI);

initSlashCommands(chatAPI, ctx, {
  openSettings: () => settings.open(),
  openConversations: () => conversations.open(),
  openShortcuts: () => openShortcutDialog(),
  openMemory: () => gatedPanels.openMemory(),
});

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

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (memoryPanel.classList.contains("open") || goalsPanel.classList.contains("open")) {
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

async function autoInitWebLLM(model: string = DEFAULT_WEBLLM_MODEL): Promise<void> {
  const heading = document.getElementById("connect-prompt-heading");
  const text = document.getElementById("connect-prompt-text");
  const btn = document.getElementById("connect-prompt-btn");
  const progress = document.getElementById("connect-prompt-progress");
  const fill = document.getElementById("connect-prompt-progress-fill");

  // Transform the connect prompt into a loading indicator
  if (heading) heading.textContent = "Waking up";
  if (text) text.textContent = "Loading a small language model into your browser...";
  if (btn) btn.style.display = "none";
  if (progress) progress.style.display = "block";

  try {
    const provider = new WebLLMProvider(model);
    await provider.init((report) => {
      if (fill) fill.style.width = `${Math.round(report.progress * 100)}%`;
      // Show short status text during download
      if (text) {
        if (report.progress < 1) {
          text.textContent = report.text.length > 60 ? report.text.slice(0, 57) + "..." : report.text;
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
    // WebLLM failed (incompatible GPU, out of memory, etc.) — restore connect prompt
    if (heading) heading.textContent = "Give it a voice";
    if (text) text.textContent = "Connect an AI provider and this little drop of glass will start talking back.";
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
    currentConfig = savedConfig;

    if (savedConfig.type === "webllm") {
      // WebLLM needs async init — re-init silently in background
      void autoInitWebLLM(savedConfig.model);
    } else {
      try {
        app.connectProvider(savedConfig);
        settings.updateModelIndicator();
      } catch {
        // Provider connection failed — user can reconnect via settings
      }
    }
  } else if (checkWebGPU()) {
    // First visit, no saved config, WebGPU available — auto-init WebLLM
    void autoInitWebLLM("Llama-3.2-3B-Instruct-q4f16_1-MLC");
  }

  settings.updateConnectPrompt();

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
      addMessage(msg.role, msg.content, true);
    }
  }
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("Motebit bootstrap failed:", err);
});
