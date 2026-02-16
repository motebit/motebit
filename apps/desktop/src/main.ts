import { DesktopApp, isSlashCommand, parseSlashCommand, type DesktopAIConfig } from "./index";

const canvas = document.getElementById("motebit-canvas") as HTMLCanvasElement;
if (!canvas) {
  throw new Error("Canvas element #motebit-canvas not found");
}

const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;

const app = new DesktopApp();
let currentConfig: DesktopAIConfig | null = null;

// === Chat Helpers ===

function addMessage(role: "user" | "assistant" | "system", text: string): void {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function handleSlashCommand(command: string, args: string): void {
  switch (command) {
    case "model":
      if (!args) {
        const current = app.currentModel ?? "none";
        addMessage("system", `Current model: ${current}`);
      } else {
        try {
          app.setModel(args);
          addMessage("system", `Model switched to: ${args}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          addMessage("system", `Error: ${msg}`);
        }
      }
      break;
    case "settings":
      openSettings();
      break;
    case "help":
      addMessage("system",
        "Available commands:\n" +
        "/model — show current model\n" +
        "/model <name> — switch model\n" +
        "/settings — open settings panel\n" +
        "/help — show this message"
      );
      break;
    default:
      addMessage("system", `Unknown command: /${command}`);
  }
}

async function handleSend(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text || app.isProcessing) return;

  chatInput.value = "";

  if (isSlashCommand(text)) {
    const { command, args } = parseSlashCommand(text);
    handleSlashCommand(command, args);
    return;
  }

  addMessage("user", text);

  try {
    const result = await app.sendMessage(text);
    addMessage("assistant", result.response);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    addMessage("system", `Error: ${msg}`);
  }
}

// === Config Loading ===

async function loadDesktopConfig(): Promise<DesktopAIConfig> {
  const isTauri = typeof window !== "undefined" && !!window.__TAURI__;

  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke<string>("read_config");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const provider = (parsed.default_provider as DesktopAIConfig["provider"]) || "ollama";
    const model = (parsed.default_model as string) || undefined;

    // Try keyring first, fall back to config file
    let apiKey: string | undefined;
    try {
      const keyringVal = await invoke<string | null>("keyring_get", { key: "api_key" });
      apiKey = keyringVal ?? undefined;
    } catch {
      // Keyring unavailable — fall through
    }
    if (!apiKey) {
      apiKey = (parsed.api_key as string) || undefined;
    }

    return { provider, model, apiKey, isTauri: true };
  }

  // Vite dev mode — read from env vars
  const provider = (import.meta.env.VITE_AI_PROVIDER as DesktopAIConfig["provider"]) || "ollama";
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY || undefined;

  return { provider, apiKey, isTauri: false };
}

// === Settings Panel ===

const settingsBackdrop = document.getElementById("settings-backdrop") as HTMLDivElement;
const settingsPanel = document.getElementById("settings-panel") as HTMLDivElement;
const settingsProvider = document.getElementById("settings-provider") as HTMLSelectElement;
const settingsModel = document.getElementById("settings-model") as HTMLInputElement;
const settingsApiKey = document.getElementById("settings-apikey") as HTMLInputElement;
const settingsApiKeyToggle = document.getElementById("settings-apikey-toggle") as HTMLButtonElement;

function openSettings(): void {
  // Pre-populate from current config (never pre-fill actual API key)
  if (currentConfig) {
    settingsProvider.value = currentConfig.provider;
    settingsModel.value = currentConfig.model || "";
  }
  settingsApiKey.value = "";
  settingsApiKey.type = "password";
  settingsApiKeyToggle.textContent = "Show";
  settingsBackdrop.classList.add("open");
  settingsPanel.classList.add("open");
}

function closeSettings(): void {
  settingsBackdrop.classList.remove("open");
  settingsPanel.classList.remove("open");
}

async function saveSettings(): Promise<void> {
  const provider = settingsProvider.value as DesktopAIConfig["provider"];
  const model = settingsModel.value.trim() || undefined;
  const apiKey = settingsApiKey.value.trim() || undefined;
  const isTauri = typeof window !== "undefined" && !!window.__TAURI__;

  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");

    // Write provider + model to config file (not API key)
    const configData: Record<string, string> = { default_provider: provider };
    if (model) configData.default_model = model;
    await invoke("write_config", { json: JSON.stringify(configData) });

    // API key goes to keyring exclusively
    if (apiKey) {
      await invoke("keyring_set", { key: "api_key", value: apiKey });
    }
  }

  // Apply immediately
  const newConfig: DesktopAIConfig = { provider, model, apiKey: apiKey || currentConfig?.apiKey, isTauri };
  currentConfig = newConfig;

  if (app.initAI(newConfig)) {
    const label = provider === "ollama" ? "Ollama" : "Anthropic";
    addMessage("system", `Settings saved — AI reconnected (${label})`);
  } else {
    addMessage("system", "Settings saved — AI initialization failed (check API key)");
  }

  closeSettings();
}

// Settings event listeners
settingsBackdrop.addEventListener("click", closeSettings);
document.getElementById("settings-btn")!.addEventListener("click", openSettings);
document.getElementById("settings-cancel")!.addEventListener("click", closeSettings);
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

// === Bootstrap ===

async function bootstrap(): Promise<void> {
  await app.init(canvas);
  app.start();

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

  // AI init
  const config = await loadDesktopConfig();
  currentConfig = config;
  if (app.initAI(config)) {
    const label = config.provider === "ollama" ? "Ollama" : "Anthropic";
    addMessage("system", `AI connected (${label})`);
  } else {
    if (config.provider === "anthropic") {
      addMessage("system", "No API key — set VITE_ANTHROPIC_API_KEY in .env or api_key in ~/.motebit/config.json");
    } else {
      addMessage("system", "AI initialization failed");
    }
  }

  // Chat input
  chatInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  });
}

bootstrap().catch((err: unknown) => {
  console.error("Motebit bootstrap failed:", err);
});
