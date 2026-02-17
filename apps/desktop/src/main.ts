import { DesktopApp, isSlashCommand, parseSlashCommand, type DesktopAIConfig, type InvokeFn } from "./index";
import { stripTags } from "@motebit/ai-core";

const canvas = document.getElementById("motebit-canvas") as HTMLCanvasElement;
if (!canvas) {
  throw new Error("Canvas element #motebit-canvas not found");
}

const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;

const app = new DesktopApp();
let currentConfig: DesktopAIConfig | null = null;

// === Chat Helpers ===

const toolStatusElements = new Map<string, HTMLElement>();

function addMessage(role: "user" | "assistant" | "system", text: string): void {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function showToolStatus(name: string): void {
  const el = document.createElement("div");
  el.className = "tool-status";
  el.textContent = `${name}...`;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  toolStatusElements.set(name, el);
}

function completeToolStatus(name: string): void {
  const el = toolStatusElements.get(name);
  if (!el) return;
  el.textContent = `${name} done`;
  el.classList.add("done");
  setTimeout(() => {
    el.classList.add("fade-out");
    setTimeout(() => { el.remove(); toolStatusElements.delete(name); }, 500);
  }, 1000);
}

function showApprovalCard(name: string, args: Record<string, unknown>): void {
  const card = document.createElement("div");
  card.className = "approval-card";

  const toolDiv = document.createElement("div");
  toolDiv.className = "approval-tool";
  toolDiv.textContent = name;
  card.appendChild(toolDiv);

  const argsDiv = document.createElement("div");
  argsDiv.className = "approval-args";
  argsDiv.textContent = JSON.stringify(args).slice(0, 120);
  card.appendChild(argsDiv);

  const btns = document.createElement("div");
  btns.className = "approval-buttons";

  const allowBtn = document.createElement("button");
  allowBtn.className = "btn-allow";
  allowBtn.textContent = "Allow";

  const denyBtn = document.createElement("button");
  denyBtn.className = "btn-deny";
  denyBtn.textContent = "Deny";

  const disableButtons = (): void => {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
  };

  allowBtn.addEventListener("click", () => {
    disableButtons();
    chatInput.value = `I approved the ${name} tool call. Please proceed.`;
    void handleSend();
  });

  denyBtn.addEventListener("click", () => {
    disableButtons();
    chatInput.value = `I denied the ${name} tool call.`;
    void handleSend();
  });

  btns.appendChild(allowBtn);
  btns.appendChild(denyBtn);
  card.appendChild(btns);

  chatLog.appendChild(card);
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

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble assistant";
  bubble.textContent = "";
  chatLog.appendChild(bubble);

  let accumulated = "";
  try {
    for await (const chunk of app.sendMessageStreaming(text)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
        bubble.textContent = stripTags(accumulated);
        chatLog.scrollTop = chatLog.scrollHeight;
      } else if (chunk.type === "tool_status") {
        if (chunk.status === "calling") {
          showToolStatus(chunk.name);
        } else if (chunk.status === "done") {
          completeToolStatus(chunk.name);
        }
      } else if (chunk.type === "approval_request") {
        showApprovalCard(chunk.name, chunk.args);
      } else if (chunk.type === "injection_warning") {
        addMessage("system", `Warning: suspicious content detected in ${chunk.tool_name} results`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!bubble.textContent) {
      bubble.remove();
    }
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

    // Sync relay config (optional)
    const syncUrl = (parsed.sync_url as string) || undefined;
    let syncMasterToken: string | undefined;
    if (syncUrl) {
      try {
        const keyringVal = await invoke<string | null>("keyring_get", { key: "sync_master_token" });
        syncMasterToken = keyringVal ?? undefined;
      } catch {
        // Keyring unavailable
      }
    }

    return { provider, model, apiKey, isTauri: true, invoke: invoke as InvokeFn, syncUrl, syncMasterToken };
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
const settingsOperatorMode = document.getElementById("settings-operator-mode") as HTMLInputElement;

function openSettings(): void {
  // Pre-populate from current config (never pre-fill actual API key)
  if (currentConfig) {
    settingsProvider.value = currentConfig.provider;
    settingsModel.value = currentConfig.model || "";
  }
  settingsApiKey.value = "";
  settingsApiKey.type = "password";
  settingsApiKeyToggle.textContent = "Show";
  settingsOperatorMode.checked = app.isOperatorMode;
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

  // Apply operator mode (with PIN flow if enabling)
  const wantsOperator = settingsOperatorMode.checked;
  if (wantsOperator && !app.isOperatorMode) {
    // Attempt to enable — may trigger PIN flow
    const result = await app.setOperatorMode(true);
    if (!result.success) {
      if (result.needsSetup) {
        showPinDialog("setup");
      } else {
        showPinDialog("verify");
      }
      // Don't close settings yet — PIN dialog handles continuation
      pendingSettingsSave = { provider, model, apiKey, isTauri };
      return;
    }
  } else if (!wantsOperator && app.isOperatorMode) {
    await app.setOperatorMode(false);
  }

  finishSaveSettings(provider, model, apiKey, isTauri);
}

interface PendingSave {
  provider: DesktopAIConfig["provider"];
  model?: string;
  apiKey?: string;
  isTauri: boolean;
}
let pendingSettingsSave: PendingSave | null = null;

function finishSaveSettings(
  provider: DesktopAIConfig["provider"],
  model?: string,
  apiKey?: string,
  isTauri = false,
): void {
  const newConfig: DesktopAIConfig = { provider, model, apiKey: apiKey || currentConfig?.apiKey, isTauri, invoke: currentConfig?.invoke };
  currentConfig = newConfig;

  if (app.initAI(newConfig)) {
    const label = provider === "ollama" ? "Ollama" : "Anthropic";
    addMessage("system", `Settings saved — AI reconnected (${label})`);
  } else {
    addMessage("system", "Settings saved — AI initialization failed (check API key)");
  }

  closeSettings();
}

// === PIN Dialog ===

const pinBackdrop = document.getElementById("pin-backdrop") as HTMLDivElement;
const pinInput = document.getElementById("pin-input") as HTMLInputElement;
const pinConfirmInput = document.getElementById("pin-confirm-input") as HTMLInputElement;
const pinConfirmText = document.getElementById("pin-confirm-text") as HTMLDivElement;
const pinError = document.getElementById("pin-error") as HTMLDivElement;
const pinTitle = document.getElementById("pin-title") as HTMLDivElement;
let pinMode: "setup" | "verify" | "reset" = "verify";

function showPinDialog(mode: "setup" | "verify" | "reset"): void {
  pinMode = mode;
  pinInput.value = "";
  pinConfirmInput.value = "";
  pinError.textContent = "";
  pinConfirmText.style.display = "none";
  pinConfirmText.textContent = "";
  if (mode === "setup") {
    pinTitle.textContent = "Set Operator PIN";
    pinInput.style.display = "block";
    pinConfirmInput.style.display = "block";
    (document.getElementById("pin-submit") as HTMLButtonElement).textContent = "OK";
  } else if (mode === "reset") {
    pinTitle.textContent = "Reset Operator PIN?";
    pinInput.style.display = "none";
    pinConfirmInput.style.display = "none";
    pinConfirmText.style.display = "block";
    pinConfirmText.textContent = "This will clear your PIN and disable operator mode.";
    (document.getElementById("pin-submit") as HTMLButtonElement).textContent = "Reset";
  } else {
    pinTitle.textContent = "Enter Operator PIN";
    pinInput.style.display = "block";
    pinConfirmInput.style.display = "none";
    (document.getElementById("pin-submit") as HTMLButtonElement).textContent = "OK";
  }
  pinBackdrop.classList.add("open");
  if (mode !== "reset") pinInput.focus();
}

function closePinDialog(): void {
  pinBackdrop.classList.remove("open");
  pinInput.value = "";
  pinConfirmInput.value = "";
  pinError.textContent = "";
  // Revert the toggle since we didn't succeed
  settingsOperatorMode.checked = app.isOperatorMode;
}

async function handlePinSubmit(): Promise<void> {
  pinError.textContent = "";

  if (pinMode === "reset") {
    try {
      await app.resetOperatorPin();
    } catch (err: unknown) {
      pinError.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    pinBackdrop.classList.remove("open");
    settingsOperatorMode.checked = false;
    addMessage("system", "Operator PIN reset");
    return;
  }

  const pin = pinInput.value.trim();

  if (!/^\d{4,6}$/.test(pin)) {
    pinError.textContent = "PIN must be 4-6 digits";
    return;
  }

  if (pinMode === "setup") {
    const confirm = pinConfirmInput.value.trim();
    if (pin !== confirm) {
      pinError.textContent = "PINs do not match";
      return;
    }
    try {
      await app.setupOperatorPin(pin);
    } catch (err: unknown) {
      pinError.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
  }

  // Now try to enable operator mode with the PIN
  const result = await app.setOperatorMode(true, pin);
  if (!result.success) {
    pinError.textContent = result.error || "Failed to enable operator mode";
    return;
  }

  // Success — close PIN dialog and finish settings save
  pinBackdrop.classList.remove("open");
  if (pendingSettingsSave) {
    const s = pendingSettingsSave;
    pendingSettingsSave = null;
    finishSaveSettings(s.provider, s.model, s.apiKey, s.isTauri);
  }
}

document.getElementById("pin-cancel")!.addEventListener("click", closePinDialog);
document.getElementById("pin-submit")!.addEventListener("click", () => { void handlePinSubmit(); });
pinInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { void handlePinSubmit(); }
});
pinConfirmInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { void handlePinSubmit(); }
});

// Reset PIN button
document.getElementById("settings-reset-pin")!.addEventListener("click", () => {
  showPinDialog("reset");
});

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

  // Identity bootstrap (Tauri only)
  const config = await loadDesktopConfig();
  currentConfig = config;

  const welcomeBackdrop = document.getElementById("welcome-backdrop") as HTMLDivElement;

  if (config.isTauri && config.invoke) {
    const invoke = config.invoke;
    const raw = await invoke<string>("read_config");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (parsed.motebit_id) {
      // Returning user — skip welcome, bootstrap directly
      welcomeBackdrop.classList.remove("open");
      try {
        await app.bootstrap(invoke);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        addMessage("system", `Identity bootstrap failed: ${msg}`);
      }
    } else {
      // First launch — wait for consent
      await new Promise<void>((resolve) => {
        document.getElementById("welcome-start")!.addEventListener("click", () => {
          welcomeBackdrop.classList.remove("open");
          resolve();
        });
      });

      try {
        const result = await app.bootstrap(invoke);
        if (result.isFirstLaunch) {
          addMessage("system", "Your mote has been created");
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        addMessage("system", `Identity bootstrap failed: ${msg}`);
      }

      // Sync relay registration (if configured)
      if (config.syncUrl && config.syncMasterToken) {
        try {
          await app.registerWithRelay(invoke, config.syncUrl, config.syncMasterToken);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          addMessage("system", `Sync relay registration failed: ${msg}`);
        }
      }
    }
  } else {
    // Non-Tauri (dev mode) — no identity bootstrap
    welcomeBackdrop.classList.remove("open");
  }

  // AI init
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
