import { DesktopApp, COLOR_PRESETS, type DesktopAIConfig, type McpServerConfig, type GoalCompleteEvent, type GoalApprovalEvent, type GoalPlanProgressEvent } from "./index";
import type { DesktopContext } from "./types";
import { loadDesktopConfig } from "./ui/config";
import { addMessage, addActionMessage, showToast, showBanner, dismissBanner, initChat, showGoalApprovalCard } from "./ui/chat";
import { deriveInteriorColor } from "./ui/color-picker";
import { initColorPicker } from "./ui/color-picker";
import { initConversations } from "./ui/conversations";
import { initGoals } from "./ui/goals";
import { initMemory } from "./ui/memory";
import { initPairing } from "./ui/pairing";
import { initVoice } from "./ui/voice";
import { initSettings } from "./ui/settings";

// === Core Objects ===

const canvas = document.getElementById("motebit-canvas") as HTMLCanvasElement;
if (!canvas) throw new Error("Canvas element #motebit-canvas not found");

const app = new DesktopApp();
let currentConfig: DesktopAIConfig | null = null;

// === Desktop Context ===

const ctx: DesktopContext = {
  app,
  getConfig: () => currentConfig,
  setConfig: (c) => { currentConfig = c; },
  addMessage,
  showToast,
};

// === Module Init (late-binding for cross-module callbacks) ===

const colorPicker = initColorPicker(ctx, () => voice.updateVoiceGlowColor());
const conversations = initConversations(ctx);
const goals = initGoals(ctx);
const memory = initMemory(ctx);
const pairing = initPairing(ctx);

const voice = initVoice(ctx, {
  onTranscriptReady: () => chat.handleSend(),
  getActiveColor: () => colorPicker.getActiveColor(),
});

const chat = initChat(ctx, {
  openSettings: () => settings.open(),
  openConversationsPanel: () => conversations.open(),
  speakResponse: (text) => voice.speakAssistantResponse(text),
  getMicState: () => voice.getMicState(),
});

const settings = initSettings(ctx, { colorPicker, voice, pairing });

// === Escape Key Handler ===

const goalsPanel = document.getElementById("goals-panel") as HTMLDivElement;
const memoryPanel = document.getElementById("memory-panel") as HTMLDivElement;
const conversationsPanel = document.getElementById("conversations-panel") as HTMLDivElement;
const settingsModal = document.getElementById("settings-modal") as HTMLDivElement;
const inputBarWrapper = document.getElementById("input-bar-wrapper") as HTMLDivElement;
const voiceTranscript = document.getElementById("voice-transcript") as HTMLSpanElement;
const micBtn = document.getElementById("mic-btn") as HTMLButtonElement;

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const micState = voice.getMicState();
    if (micState === "voice") {
      voice.stopVoice(false, false);
    } else if (micState === "speaking") {
      voice.cancelTTS();
      voice.stopAmbient();
    } else if (micState === "transcribing") {
      voiceTranscript.textContent = "";
      voiceTranscript.style.display = "";
      inputBarWrapper.classList.remove("listening");
      micBtn.classList.remove("active", "ambient");
      voice.releaseAudioResources();
      app.setAudioReactivity(null);
    } else if (micState === "ambient") {
      voice.stopAmbient();
    } else if (settings.isPinDialogOpen()) {
      settings.closePinDialog();
    } else if (goalsPanel.classList.contains("open")) {
      goals.close();
    } else if (memoryPanel.classList.contains("open")) {
      memory.close();
    } else if (conversationsPanel.classList.contains("open")) {
      conversations.close();
    } else if (settingsModal.classList.contains("open")) {
      settings.close();
    }
  }
});

// === Error Recovery Helpers ===

/**
 * Attempt identity bootstrap with error recovery UI.
 * On failure, shows an actionable message with Retry and Skip options.
 * On skip, closes welcome overlay and runs in limited mode.
 */
async function tryBootstrapIdentity(invoke: import("./tauri-storage.js").InvokeFn): Promise<import("./index").BootstrapResult | null> {
  try {
    const result = await app.bootstrap(invoke);
    dismissBanner("identity-limited");
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    addActionMessage(
      `Identity setup failed: ${msg}`,
      [
        {
          label: "Retry",
          primary: true,
          onClick: () => {
            void tryBootstrapIdentity(invoke).then(result => {
              if (result?.isFirstLaunch) addMessage("system", "Your mote has been created");
            });
          },
        },
        {
          label: "Skip",
          onClick: () => {
            showBanner({
              id: "identity-limited",
              text: "Running in limited mode \u2014 identity not set up",
              actionLabel: "Setup",
              onAction: () => {
                void tryBootstrapIdentity(invoke).then(result => {
                  if (result) {
                    dismissBanner("identity-limited");
                    if (result.isFirstLaunch) addMessage("system", "Your mote has been created");
                  }
                });
              },
            });
          },
        },
      ],
    );
    return null;
  }
}

/**
 * Attempt AI initialization with error recovery UI.
 * On failure, shows an actionable message with Retry and Settings options.
 */
async function tryInitAI(config: DesktopAIConfig): Promise<boolean> {
  const success = await app.initAI(config);
  if (success) {
    dismissBanner("ai-disconnected");
    return true;
  }

  if (config.provider === "anthropic") {
    addActionMessage(
      "AI connection failed: no API key configured",
      [
        {
          label: "Retry",
          primary: true,
          onClick: () => {
            const latestConfig = currentConfig;
            if (latestConfig) void tryInitAI(latestConfig).then(ok => { if (ok) onAIReady(latestConfig); });
          },
        },
        {
          label: "Settings",
          onClick: () => settings.openToTab("intelligence"),
        },
      ],
    );
  } else {
    addActionMessage(
      "AI connection failed: could not reach provider",
      [
        {
          label: "Retry",
          primary: true,
          onClick: () => {
            const latestConfig = currentConfig;
            if (latestConfig) void tryInitAI(latestConfig).then(ok => { if (ok) onAIReady(latestConfig); });
          },
        },
        {
          label: "Settings",
          onClick: () => settings.openToTab("intelligence"),
        },
      ],
    );
  }

  showBanner({
    id: "ai-disconnected",
    text: "No AI provider connected",
    actionLabel: "Connect",
    onAction: () => settings.openToTab("intelligence"),
  });

  return false;
}

/**
 * Attempt sync relay registration with error recovery UI.
 */
async function trySyncRegistration(
  invoke: import("./tauri-storage.js").InvokeFn,
  syncUrl: string,
  masterToken: string,
): Promise<void> {
  try {
    await app.registerWithRelay(invoke, syncUrl, masterToken);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    addActionMessage(
      `Sync relay connection failed: ${msg}`,
      [
        {
          label: "Retry",
          primary: true,
          onClick: () => { void trySyncRegistration(invoke, syncUrl, masterToken); },
        },
        {
          label: "Dismiss",
          onClick: () => { /* User chose to continue without sync */ },
        },
      ],
    );
  }
}

/**
 * Connect an MCP server with error recovery UI.
 */
async function tryConnectMcpServer(
  mcpConfig: McpServerConfig,
  invoke: import("./tauri-storage.js").InvokeFn,
): Promise<void> {
  try {
    await app.connectMcpServerViaTauri(mcpConfig, invoke);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    addActionMessage(
      `MCP server "${mcpConfig.name}" failed to connect: ${msg}`,
      [
        {
          label: "Retry",
          primary: true,
          onClick: () => { void tryConnectMcpServer(mcpConfig, invoke); },
        },
        {
          label: "Remove",
          onClick: () => {
            void app.removeMcpServer(mcpConfig.name);
            const configs = settings.getMcpServersConfig().filter(c => c.name !== mcpConfig.name);
            settings.setMcpServersConfig(configs);
          },
        },
      ],
    );
  }
}

/**
 * Called after AI successfully initializes to set up goal scheduler,
 * connect MCP servers, start sync, and load conversation history.
 */
function onAIReady(config: DesktopAIConfig): void {
  const label = config.provider === "ollama" ? "Ollama" : "Anthropic";
  addMessage("system", `AI connected (${label})`);

  const gov = app.governanceStatus;
  if (!gov.governed && gov.reason !== "dev mode") {
    addMessage("system", `Tools disabled \u2014 ${gov.reason}. The agent can chat but cannot act.`);
  }

  const previousMessages = app.getConversationHistory();
  if (previousMessages.length > 0) {
    for (const msg of previousMessages) {
      if (msg.role === "user" || msg.role === "assistant") {
        addMessage(msg.role, msg.content);
      }
    }
  }

  // Start goal scheduler (Tauri only)
  if (config.isTauri && config.invoke) {
    const goalStatus = document.getElementById("goal-status") as HTMLDivElement;
    app.onGoalStatus((executing) => {
      goalStatus.classList.toggle("active", executing);
    });
    app.onGoalComplete((event: GoalCompleteEvent) => {
      const promptSnippet = event.prompt.length > 50 ? event.prompt.slice(0, 50) + "..." : event.prompt;
      if (event.status === "completed") {
        const planInfo = event.planTitle
          ? ` [${event.stepsCompleted ?? 0}/${event.totalSteps ?? 0} steps]`
          : "";
        const summary = event.summary ? `: ${event.summary.slice(0, 120)}` : "";
        addMessage("system", `Goal completed "${promptSnippet}"${planInfo}${summary}`);
      } else {
        const err = event.error ? `: ${event.error.slice(0, 80)}` : "";
        addMessage("system", `Goal failed "${promptSnippet}"${err}`);
      }
    });
    app.onGoalPlanProgress((event: GoalPlanProgressEvent) => {
      const goalStatusEl = document.getElementById("goal-status") as HTMLDivElement;
      const goalStatusText = goalStatusEl.querySelector(".goal-status-text") as HTMLSpanElement | null;
      if (goalStatusText) {
        if (event.type === "plan_created") {
          goalStatusText.textContent = `Plan: ${event.planTitle}`;
        } else if (event.type === "step_started") {
          goalStatusText.textContent = `Step ${event.stepIndex}/${event.totalSteps}: ${event.stepDescription}`;
        } else if (event.type === "step_completed") {
          goalStatusText.textContent = `Step ${event.stepIndex}/${event.totalSteps} done`;
        } else if (event.type === "step_failed") {
          goalStatusText.textContent = `Step ${event.stepIndex}/${event.totalSteps} failed`;
        }
      }
    });
    app.onGoalApproval((event: GoalApprovalEvent) => {
      const promptSnippet = event.goalPrompt.length > 50
        ? event.goalPrompt.slice(0, 50) + "..."
        : event.goalPrompt;
      addMessage("system", `Goal "${promptSnippet}" needs approval:`);
      showGoalApprovalCard(ctx, event);
    });
    app.startGoalScheduler(config.invoke);
  }

  // Connect MCP servers via Tauri IPC bridge
  if (config.isTauri && config.invoke) {
    const invoke = config.invoke;
    for (const mcpConfig of settings.getMcpServersConfig()) {
      void tryConnectMcpServer(mcpConfig, invoke);
    }
  }

  // Start full sync (event-level background polling + conversation sync)
  if (config.syncUrl && config.isTauri && config.invoke) {
    void app.startSync(config.invoke, config.syncUrl, config.syncMasterToken).catch(() => {
      // Sync failures are non-fatal at startup
    });
  }
}

// === Bootstrap ===

async function bootstrap(): Promise<void> {
  await app.init(canvas);
  app.start();

  // Resize handler
  const chatInput = document.getElementById("chat-input") as HTMLInputElement;
  const onResize = (): void => {
    app.resize(window.innerWidth, window.innerHeight);
    if (voice.getMicState() === "voice") voice.sizeWaveformCanvas();
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
      welcomeBackdrop.classList.remove("open");
      await tryBootstrapIdentity(invoke);
    } else {
      const action = await new Promise<"create" | "link">((resolve) => {
        document.getElementById("welcome-start")!.addEventListener("click", () => resolve("create"));
        document.getElementById("welcome-link-existing")!.addEventListener("click", () => resolve("link"));
      });

      if (action === "link") {
        const linkSyncUrl = (parsed.sync_url as string) || "";
        if (!linkSyncUrl) {
          welcomeBackdrop.classList.remove("open");
          addMessage("system", "No sync relay configured \u2014 set sync_url in config to link devices");
          const result = await tryBootstrapIdentity(invoke);
          if (result?.isFirstLaunch) addMessage("system", "Your mote has been created");
        } else {
          try { await app.bootstrap(invoke); } catch { /* Non-fatal — we just need the keypair */ }
          pairing.startClaim(invoke, linkSyncUrl);
        }
      } else {
        welcomeBackdrop.classList.remove("open");
        const result = await tryBootstrapIdentity(invoke);
        if (result?.isFirstLaunch) addMessage("system", "Your mote has been created");

        if (config.syncUrl && config.syncMasterToken) {
          void trySyncRegistration(invoke, config.syncUrl, config.syncMasterToken);
        }
      }
    }

    // Load persisted settings from config
    if (typeof parsed.interior_color_preset === "string") {
      if (parsed.interior_color_preset === "custom" && parsed.custom_soul_color && typeof parsed.custom_soul_color === "object") {
        const csc = parsed.custom_soul_color as Record<string, unknown>;
        if (typeof csc.hue === "number" && typeof csc.saturation === "number") {
          colorPicker.setCustomHue(csc.hue);
          colorPicker.setCustomSaturation(csc.saturation);
          colorPicker.setCustomInteriorColor(deriveInteriorColor(csc.hue, csc.saturation));
          colorPicker.setSelectedPreset("custom");
          app.setInteriorColorDirect(colorPicker.getCustomInteriorColor()!);
        }
      } else if (parsed.interior_color_preset === "borosilicate" || !COLOR_PRESETS[parsed.interior_color_preset]) {
        colorPicker.setSelectedPreset("moonlight");
        app.setInteriorColor("moonlight");
      } else {
        colorPicker.setSelectedPreset(parsed.interior_color_preset);
        app.setInteriorColor(parsed.interior_color_preset);
      }
    }
    if (typeof parsed.approval_preset === "string") {
      settings.setSelectedApprovalPreset(parsed.approval_preset);
    }
    if (Array.isArray(parsed.mcp_servers)) {
      settings.setMcpServersConfig(parsed.mcp_servers as McpServerConfig[]);
    }
    if (parsed.memory_governance && typeof parsed.memory_governance === "object") {
      const mg = parsed.memory_governance as Record<string, unknown>;
      const pt = document.getElementById("settings-persistence-threshold") as HTMLInputElement;
      const ptv = document.getElementById("persistence-threshold-value") as HTMLSpanElement;
      if (typeof mg.persistence_threshold === "number") {
        pt.value = String(mg.persistence_threshold);
        ptv.textContent = mg.persistence_threshold.toFixed(2);
      }
      if (typeof mg.reject_secrets === "boolean") {
        (document.getElementById("settings-reject-secrets") as HTMLInputElement).checked = mg.reject_secrets;
      }
    }
    if (parsed.budget && typeof parsed.budget === "object") {
      const b = parsed.budget as Record<string, unknown>;
      if (typeof b.maxCallsPerTurn === "number") {
        (document.getElementById("settings-max-calls") as HTMLInputElement).value = String(b.maxCallsPerTurn);
      }
    }

    // Voice settings
    if (parsed.voice && typeof parsed.voice === "object") {
      const v = parsed.voice as Record<string, unknown>;
      if (typeof v.auto_send === "boolean") voice.setVoiceAutoSend(v.auto_send);
      if (typeof v.voice_response === "boolean") voice.setVoiceResponseEnabled(v.voice_response);
      if (typeof v.tts_voice === "string") voice.setTtsVoice(v.tts_voice);
    }

    voice.rebuildTtsProvider(invoke);

    // Check keyring for API key indicators
    try {
      const keyVal = await invoke<string | null>("keyring_get", { key: "api_key" });
      settings.setHasApiKeyInKeyring(!!keyVal);
    } catch { /* Keyring unavailable */ }
    try {
      const whisperVal = await invoke<string | null>("keyring_get", { key: "whisper_api_key" });
      settings.setHasWhisperKeyInKeyring(!!whisperVal);
    } catch { /* Keyring unavailable */ }
  } else {
    welcomeBackdrop.classList.remove("open");
  }

  // AI init (with error recovery)
  const aiOk = await tryInitAI(config);
  if (aiOk) {
    onAIReady(config);
  }

  // Chat input
  chatInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (voice.getMicState() === "voice") {
        voice.stopVoice(true, true);
        return;
      }
      void chat.handleSend();
    }
  });

  // Voice button
  micBtn.style.display = "flex";
  micBtn.addEventListener("click", () => voice.toggleVoice());
  voice.updateVoiceGlowColor();
}

bootstrap().catch((err: unknown) => {
  console.error("Motebit bootstrap failed:", err);
});
