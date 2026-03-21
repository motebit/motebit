import {
  DesktopApp,
  COLOR_PRESETS,
  type DesktopAIConfig,
  type McpServerConfig,
  type GoalCompleteEvent,
  type GoalApprovalEvent,
  type GoalPlanProgressEvent,
  type SyncStatusEvent,
  type SyncIndicatorStatus,
} from "./index";
import type { DesktopContext } from "./types";
import { formatTimeAgo } from "./types";
import { loadDesktopConfig } from "./ui/config";
import {
  addMessage,
  addActionMessage,
  showToast,
  showBanner,
  dismissBanner,
  initChat,
  showGoalApprovalCard,
  GREETING_PROMPT_MARKER,
} from "./ui/chat";
import { deriveInteriorColor } from "./ui/color-picker";
import { initColorPicker } from "./ui/color-picker";
import { initConversations } from "./ui/conversations";
import { initAgents } from "./ui/agents";
import { initGoals } from "./ui/goals";
import { initMemory } from "./ui/memory";
import { initPairing } from "./ui/pairing";
import { initVoice } from "./ui/voice";
import { initSettings } from "./ui/settings";
import { initSovereign } from "./ui/sovereign";
import { initTheme } from "./ui/theme";
import { initKeyboard } from "./ui/keyboard";
import {
  parseClaudeDesktopConfig,
  parseClaudeCodeConfig,
  parseVSCodeMcpConfig,
  mergeDiscoveredServers,
  type DiscoveryResult,
} from "./mcp-discovery";

// === Core Objects ===

const canvas = document.getElementById("motebit-canvas") as HTMLCanvasElement | null;
if (canvas == null) throw new Error("Canvas element #motebit-canvas not found");

const app = new DesktopApp();
let currentConfig: DesktopAIConfig | null = null;
// isFirstLaunch tracking removed — creature doesn't speak first (thesis: passive body)

// === Desktop Context ===

const ctx: DesktopContext = {
  app,
  getConfig: () => currentConfig,
  setConfig: (c) => {
    currentConfig = c;
  },
  addMessage,
  showToast,
};

// === Module Init (late-binding for cross-module callbacks) ===

const colorPicker = initColorPicker(ctx, () => voice.updateVoiceGlowColor());
const agents = initAgents(ctx);
const conversations = initConversations(ctx);
const goals = initGoals(ctx);
const memory = initMemory(ctx);
const pairing = initPairing(ctx);
const sovereign = initSovereign(ctx);

const voice = initVoice(ctx, {
  onTranscriptReady: () => chat.handleSend(),
  getActiveColor: () => colorPicker.getActiveColor(),
});

const chat = initChat(ctx, {
  openSettings: () => settings.open(),
  openConversationsPanel: () => conversations.open(),
  openGoalsPanel: () => goals.open(),
  openMemoryPanel: (nodeId) => memory.open(nodeId),
  speakResponse: (text) => voice.speakAssistantResponse(text),
  pushTTSChunk: (delta) => voice.pushTTSChunk(delta),
  flushTTS: () => voice.flushTTS(),
  cancelStreamingTTS: () => voice.cancelStreamingTTS(),
  getMicState: () => voice.getMicState(),
  updateModelIndicator: () => settings.updateModelIndicator(),
});

const settings = initSettings(ctx, {
  colorPicker,
  voice,
  pairing,
  scrollToRunId: (id) => chat.scrollToRunId(id),
});

// === Theme ===

const isTauri = typeof window !== "undefined" && !!window.__TAURI__;
const theme = initTheme(isTauri);

// === Keyboard Shortcuts ===

initKeyboard({ settings, goals, memory, conversations, agents });

// === Escape Key Handler ===

const agentsPanel = document.getElementById("agents-panel") as HTMLDivElement;
const sovereignPanel = document.getElementById("sovereign-panel") as HTMLDivElement;
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
    } else if (settings.isRotateKeyDialogOpen()) {
      settings.closeRotateKeyDialog();
    } else if (settings.isPinDialogOpen()) {
      settings.closePinDialog();
    } else if (agentsPanel.classList.contains("open")) {
      agents.close();
    } else if (sovereignPanel.classList.contains("open")) {
      sovereign.close();
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
async function tryBootstrapIdentity(
  invoke: import("./tauri-storage.js").InvokeFn,
): Promise<import("./index").BootstrapResult | null> {
  try {
    const result = await app.bootstrap(invoke);
    dismissBanner("identity-limited");
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    addActionMessage(`Identity setup failed: ${msg}`, [
      {
        label: "Retry",
        primary: true,
        onClick: () => {
          void tryBootstrapIdentity(invoke).then((result) => {
            if (result?.isFirstLaunch === true) {
              // first launch detected
              addMessage("system", "Your mote has been created");
            }
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
              void tryBootstrapIdentity(invoke).then((result) => {
                if (result) {
                  dismissBanner("identity-limited");
                  if (result.isFirstLaunch) {
                    // first launch detected
                    addMessage("system", "Your mote has been created");
                  }
                }
              });
            },
          });
        },
      },
    ]);
    return null;
  }
}

/**
 * Attempt AI initialization with error recovery UI.
 * If the configured provider is Anthropic but no API key is set,
 * auto-detect a local Ollama instance and fall back to it.
 */
async function tryInitAI(config: DesktopAIConfig): Promise<boolean> {
  // If Anthropic is selected but no key is present, try Ollama auto-detection
  if (config.provider === "anthropic" && (config.apiKey == null || config.apiKey === "")) {
    const detection = await app.detectOllama();
    if (detection.available && detection.bestModel !== "") {
      // Switch to Ollama transparently
      config.provider = "ollama";
      config.model = detection.bestModel;
      currentConfig = config;
      const success = await app.initAI(config);
      if (success) {
        dismissBanner("ai-disconnected");
        addMessage(
          "system",
          `Connected to local Ollama (${detection.bestModel}). No API key needed.`,
        );
        return true;
      }
    }
  }

  const success = await app.initAI(config);
  if (success) {
    dismissBanner("ai-disconnected");
    return true;
  }

  if (config.provider === "anthropic") {
    addActionMessage(
      "To get started, either install Ollama for local AI or add an Anthropic API key.",
      [
        {
          label: "Retry",
          primary: true,
          onClick: () => {
            const latestConfig = currentConfig;
            if (latestConfig)
              void tryInitAI(latestConfig).then((ok) => {
                if (ok) onAIReady(latestConfig);
              });
          },
        },
        {
          label: "Settings",
          onClick: () => settings.openToTab("intelligence"),
        },
      ],
    );
  } else {
    addActionMessage("AI connection failed: could not reach provider", [
      {
        label: "Retry",
        primary: true,
        onClick: () => {
          const latestConfig = currentConfig;
          if (latestConfig)
            void tryInitAI(latestConfig).then((ok) => {
              if (ok) onAIReady(latestConfig);
            });
        },
      },
      {
        label: "Settings",
        onClick: () => settings.openToTab("intelligence"),
      },
    ]);
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
    const token = await app.registerWithRelay(invoke, syncUrl, masterToken);
    // Start background sync polling after successful registration.
    // Safe to call before AI init — startSync no-ops when runtime is absent.
    await app.startSync(invoke, syncUrl, token ?? masterToken);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    addActionMessage(`Sync relay connection failed: ${msg}`, [
      {
        label: "Retry",
        primary: true,
        onClick: () => {
          void trySyncRegistration(invoke, syncUrl, masterToken);
        },
      },
      {
        label: "Dismiss",
        onClick: () => {
          /* User chose to continue without sync */
        },
      },
    ]);
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
    const status = await app.connectMcpServerViaTauri(mcpConfig, invoke);
    if (status.manifestChanged === true) {
      const diff = status.manifestDiff;
      const parts = [`${mcpConfig.name}: tools changed — trust revoked`];
      if (diff) {
        if (diff.added.length) parts.push(`+${diff.added.length} added`);
        if (diff.removed.length) parts.push(`-${diff.removed.length} removed`);
      }
      showToast(parts.join(", "));
    }
    // Persist config if motebit public key was newly pinned
    if (mcpConfig.motebit === true && mcpConfig.motebitPublicKey) {
      void persistMcpConfig(invoke, settings.getMcpServersConfig());
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    addActionMessage(`MCP server "${mcpConfig.name}" failed to connect: ${msg}`, [
      {
        label: "Retry",
        primary: true,
        onClick: () => {
          void tryConnectMcpServer(mcpConfig, invoke);
        },
      },
      {
        label: "Remove",
        onClick: () => {
          void app.removeMcpServer(mcpConfig.name);
          const configs = settings.getMcpServersConfig().filter((c) => c.name !== mcpConfig.name);
          settings.setMcpServersConfig(configs);
        },
      },
    ]);
  }
}

/** Transports that spawn a local process — require user confirmation. */
function isSpawnTransport(transport: string): boolean {
  return transport === "stdio" || transport === "command";
}

/** Transports that connect to an already-running server — safe to auto-connect. */
function isRemoteTransport(transport: string): boolean {
  return transport === "http";
}

/**
 * Persist the current MCP server config to disk.
 */
async function persistMcpConfig(
  invoke: import("./tauri-storage.js").InvokeFn,
  servers: McpServerConfig[],
): Promise<void> {
  try {
    const raw = await invoke<string>("read_config");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.mcp_servers = servers;
    await invoke("write_config", { json: JSON.stringify(parsed) });
  } catch {
    // Config write failed — servers are still in memory for this session
  }
}

/**
 * Discover MCP servers from external tools (Claude Desktop, Claude Code, VS Code)
 * and connect any newly found servers.
 *
 * Transport-aware connect policy:
 * - Remote servers (http): auto-connect (no process spawn, low risk)
 * - Spawn servers (stdio): persist config but require one-time user confirmation
 *   before spawning processes. Confirmation is persisted via `spawnApproved`
 *   so it only prompts once.
 */
async function discoverAndConnectMcpServers(
  invoke: import("./tauri-storage.js").InvokeFn,
): Promise<void> {
  // Single allowlisted IPC — Rust reads only known config paths
  let configSources: Array<{ name: string; path: string; content: string | null }>;
  try {
    configSources =
      await invoke<Array<{ name: string; path: string; content: string | null }>>(
        "discover_mcp_configs",
      );
  } catch {
    return;
  }

  const parsers: Record<string, (content: string) => McpServerConfig[]> = {
    "Claude Desktop": parseClaudeDesktopConfig,
    "Claude Code": parseClaudeCodeConfig,
    "VS Code": parseVSCodeMcpConfig,
  };

  const discovered: DiscoveryResult[] = [];

  for (const src of configSources) {
    if (src.content == null || src.content === "") continue;
    const parser = parsers[src.name];
    if (!parser) continue;
    const servers = parser(src.content);
    if (servers.length > 0) {
      discovered.push({ servers, source: src.name });
    }
  }

  if (discovered.length === 0) return;

  const { merged, newServers, collisions } = mergeDiscoveredServers(
    settings.getMcpServersConfig(),
    discovered,
  );

  // Surface collisions in Settings UI (always set, even if empty, to clear stale state)
  settings.setDiscoveryCollisions(collisions);
  for (const c of collisions) {
    // eslint-disable-next-line no-console
    console.warn(
      `MCP discovery: name collision for "${c.name}" — kept existing (${c.existingCommand ?? "?"}) , skipped ${c.discoveredSource ?? "?"} (${c.discoveredCommand ?? "?"})`,
    );
  }

  if (newServers.length === 0) return;

  // Persist the merged config (both types get saved so they appear in Settings)
  settings.setMcpServersConfig(merged);
  await persistMcpConfig(invoke, merged);

  // Split by transport type — unknown transports are not auto-connected
  const remoteServers = newServers.filter((s) => isRemoteTransport(s.transport));
  const spawnServers = newServers.filter(
    (s) => isSpawnTransport(s.transport) && s.spawnApproved !== true,
  );
  const preApproved = newServers.filter(
    (s) => isSpawnTransport(s.transport) && s.spawnApproved === true,
  );
  const unknownTransport = newServers.filter(
    (s) => !isRemoteTransport(s.transport) && !isSpawnTransport(s.transport),
  );
  for (const s of unknownTransport) {
    // eslint-disable-next-line no-console
    console.warn(
      `MCP discovery: unknown transport "${s.transport}" for "${s.name}" — not auto-connecting`,
    );
  }

  // Auto-connect remote servers (no process spawn)
  for (const mcpConfig of [...remoteServers, ...preApproved]) {
    void tryConnectMcpServer(mcpConfig, invoke);
  }
  if (remoteServers.length > 0) {
    showToast(
      `Connected ${remoteServers.length} discovered MCP server${remoteServers.length !== 1 ? "s" : ""}`,
    );
  }

  // Spawn-transport servers require one-time user confirmation
  if (spawnServers.length > 0) {
    const names = spawnServers.map((s) => s.name).join(", ");
    addActionMessage(
      `Discovered ${spawnServers.length} MCP server${spawnServers.length !== 1 ? "s" : ""}: ${names}`,
      [
        {
          label: "Connect",
          primary: true,
          onClick: () => {
            for (const mcpConfig of spawnServers) {
              mcpConfig.spawnApproved = true;
              void tryConnectMcpServer(mcpConfig, invoke);
            }
            // Persist spawnApproved so we don't ask again
            void persistMcpConfig(invoke, settings.getMcpServersConfig());
            showToast(
              `Connecting ${spawnServers.length} MCP server${spawnServers.length !== 1 ? "s" : ""}`,
            );
          },
        },
        {
          label: "Review",
          onClick: () => {
            settings.openToTab("intelligence");
            // Wait one layout pass for panel to be visible before scrolling
            requestAnimationFrame(() => {
              document
                .getElementById("mcp-server-list")
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
            });
          },
        },
        {
          label: "Dismiss",
          onClick: () => {
            /* Servers remain in config for later manual connect */
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
  settings.updateModelIndicator();

  const gov = app.governanceStatus;
  if (!gov.governed && gov.reason !== "dev mode") {
    addMessage("system", `Tools disabled \u2014 ${gov.reason}. The agent can chat but cannot act.`);
  }

  const previousMessages = app.getConversationHistory();
  if (previousMessages.length > 0) {
    for (const msg of previousMessages) {
      if (msg.role === "user" && msg.content.startsWith(GREETING_PROMPT_MARKER)) continue;
      if (msg.role === "user" || msg.role === "assistant") {
        addMessage(msg.role, msg.content, true);
      }
    }
  }

  // No first-run greeting — the creature is present, not performing.
  // It breathes and waits. The user's first message is the perturbation.

  // Start goal scheduler (Tauri only)
  if (config.isTauri && config.invoke) {
    const goalStatus = document.getElementById("goal-status") as HTMLDivElement;
    app.onGoalStatus((executing) => {
      goalStatus.classList.toggle("active", executing);
      goals.onGoalExecuting(executing);
    });
    app.onGoalComplete((event: GoalCompleteEvent) => {
      const promptSnippet =
        event.prompt.length > 50 ? event.prompt.slice(0, 50) + "..." : event.prompt;
      if (event.status === "completed") {
        const planInfo =
          event.planTitle != null && event.planTitle !== ""
            ? ` [${event.stepsCompleted ?? 0}/${event.totalSteps ?? 0} steps]`
            : "";
        const summary =
          event.summary != null && event.summary !== "" ? `: ${event.summary.slice(0, 120)}` : "";
        addMessage("system", `Goal completed "${promptSnippet}"${planInfo}${summary}`);
      } else {
        const err =
          event.error != null && event.error !== "" ? `: ${event.error.slice(0, 80)}` : "";
        addMessage("system", `Goal failed "${promptSnippet}"${err}`);
      }
      goals.onGoalComplete(event);
    });
    app.onGoalPlanProgress((event: GoalPlanProgressEvent) => {
      const goalStatusEl = document.getElementById("goal-status") as HTMLDivElement;
      const goalStatusText = goalStatusEl.querySelector(".goal-status-text");
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
      goals.onPlanProgress(event);
    });
    app.onGoalApproval((event: GoalApprovalEvent) => {
      const promptSnippet =
        event.goalPrompt.length > 50 ? event.goalPrompt.slice(0, 50) + "..." : event.goalPrompt;
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

    // Discover MCP servers from external tools (runs after user-configured servers)
    void discoverAndConnectMcpServers(invoke);
  }

  // Sync status indicator
  initSyncStatusIndicator(ctx);

  // Start full sync (event-level background polling + conversation sync)
  if (config.syncUrl != null && config.syncUrl !== "" && config.isTauri && config.invoke != null) {
    void trySyncRegistration(config.invoke, config.syncUrl, config.syncMasterToken ?? "");
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
    if (parsed.motebit_id != null) {
      welcomeBackdrop.classList.remove("open");
      await tryBootstrapIdentity(invoke);
    } else {
      const action = await new Promise<"create" | "link">((resolve) => {
        document
          .getElementById("welcome-start")!
          .addEventListener("click", () => resolve("create"));
        document
          .getElementById("welcome-link-existing")!
          .addEventListener("click", () => resolve("link"));
      });

      if (action === "link") {
        const linkSyncUrl = (parsed.sync_url as string | undefined) ?? "";
        if (linkSyncUrl === "") {
          welcomeBackdrop.classList.remove("open");
          addMessage(
            "system",
            "No sync relay configured \u2014 set sync_url in config to link devices",
          );
          const result = await tryBootstrapIdentity(invoke);
          if (result?.isFirstLaunch === true) {
            // first launch detected
            addMessage("system", "Your mote has been created");
          }
        } else {
          try {
            await app.bootstrap(invoke);
          } catch {
            /* Non-fatal — we just need the keypair */
          }
          pairing.startClaim(invoke, linkSyncUrl);
        }
      } else {
        welcomeBackdrop.classList.remove("open");
        const result = await tryBootstrapIdentity(invoke);
        if (result?.isFirstLaunch === true) {
          addMessage("system", "Your mote has been created");
        }

        if (
          config.syncUrl != null &&
          config.syncUrl !== "" &&
          config.syncMasterToken != null &&
          config.syncMasterToken !== ""
        ) {
          void trySyncRegistration(invoke, config.syncUrl, config.syncMasterToken);
        }
      }
    }

    // Load persisted settings from config
    if (typeof parsed.interior_color_preset === "string") {
      if (
        parsed.interior_color_preset === "custom" &&
        parsed.custom_soul_color != null &&
        typeof parsed.custom_soul_color === "object"
      ) {
        const csc = parsed.custom_soul_color as Record<string, unknown>;
        if (typeof csc.hue === "number" && typeof csc.saturation === "number") {
          colorPicker.setCustomHue(csc.hue);
          colorPicker.setCustomSaturation(csc.saturation);
          colorPicker.setCustomInteriorColor(deriveInteriorColor(csc.hue, csc.saturation));
          colorPicker.setSelectedPreset("custom");
          app.setInteriorColorDirect(colorPicker.getCustomInteriorColor()!);
        }
      } else if (
        parsed.interior_color_preset === "borosilicate" ||
        !COLOR_PRESETS[parsed.interior_color_preset]
      ) {
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
    if (parsed.memory_governance != null && typeof parsed.memory_governance === "object") {
      const mg = parsed.memory_governance as Record<string, unknown>;
      const pt = document.getElementById("settings-persistence-threshold") as HTMLInputElement;
      const ptv = document.getElementById("persistence-threshold-value") as HTMLSpanElement;
      if (typeof mg.persistence_threshold === "number") {
        pt.value = String(mg.persistence_threshold);
        ptv.textContent = mg.persistence_threshold.toFixed(2);
      }
      if (typeof mg.reject_secrets === "boolean") {
        (document.getElementById("settings-reject-secrets") as HTMLInputElement).checked =
          mg.reject_secrets;
      }
      // Pass persisted governance to config so initAI forwards it to MotebitRuntime
      config.memoryGovernance = {
        persistenceThreshold:
          typeof mg.persistence_threshold === "number" ? mg.persistence_threshold : undefined,
        rejectSecrets: typeof mg.reject_secrets === "boolean" ? mg.reject_secrets : undefined,
      };
    }
    if (parsed.budget != null && typeof parsed.budget === "object") {
      const b = parsed.budget as Record<string, unknown>;
      if (typeof b.maxCallsPerTurn === "number") {
        (document.getElementById("settings-max-calls") as HTMLInputElement).value = String(
          b.maxCallsPerTurn,
        );
      }
    }

    // Voice settings
    if (parsed.voice != null && typeof parsed.voice === "object") {
      const v = parsed.voice as Record<string, unknown>;
      if (typeof v.auto_send === "boolean") voice.setVoiceAutoSend(v.auto_send);
      if (typeof v.voice_response === "boolean") voice.setVoiceResponseEnabled(v.voice_response);
      if (typeof v.tts_voice === "string") voice.setTtsVoice(v.tts_voice);
    }

    // Theme preference from config (overrides localStorage)
    if (
      typeof parsed.theme === "string" &&
      (parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system")
    ) {
      theme.setPreference(parsed.theme);
    }

    voice.rebuildTtsProvider(invoke);

    // Check keyring for API key indicators
    try {
      const keyVal = await invoke<string | null>("keyring_get", { key: "api_key" });
      settings.setHasApiKeyInKeyring(keyVal != null && keyVal !== "");
    } catch {
      /* Keyring unavailable */
    }
    try {
      const whisperVal = await invoke<string | null>("keyring_get", { key: "whisper_api_key" });
      settings.setHasWhisperKeyInKeyring(whisperVal != null && whisperVal !== "");
    } catch {
      /* Keyring unavailable */
    }
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

  // Send button
  const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
  const inputBarWrapper = document.getElementById("input-bar-wrapper") as HTMLDivElement;
  const updateSendBtn = (): void => {
    if (chatInput.value.trim()) {
      sendBtn.classList.add("visible");
    } else {
      sendBtn.classList.remove("visible");
    }
  };
  chatInput.addEventListener("input", updateSendBtn);
  sendBtn.addEventListener("click", () => {
    void chat.handleSend();
  });

  // Voice button
  micBtn.style.display = "flex";
  inputBarWrapper.classList.add("has-mic");
  micBtn.addEventListener("click", () => voice.toggleVoice());
  voice.updateVoiceGlowColor();
}

// === Sync Status Indicator ===

function initSyncStatusIndicator(ctx: DesktopContext): void {
  const indicator = document.getElementById("sync-status") as HTMLDivElement;
  const tooltip = document.getElementById("sync-tooltip") as HTMLDivElement;
  const popup = document.getElementById("sync-popup") as HTMLDivElement;
  const popupStatus = document.getElementById("sync-popup-status") as HTMLSpanElement;
  const popupLastSync = document.getElementById("sync-popup-last-sync") as HTMLSpanElement;
  const popupPushed = document.getElementById("sync-popup-pushed") as HTMLSpanElement;
  const popupPulled = document.getElementById("sync-popup-pulled") as HTMLSpanElement;
  const popupAction = document.getElementById("sync-popup-action") as HTMLButtonElement;

  const arrowsEl = indicator.querySelector(".sync-arrows") as SVGElement;
  const slashEl = indicator.querySelector(".sync-slash") as SVGElement;
  const checkEl = indicator.querySelector(".sync-check") as SVGElement;
  const xEl = indicator.querySelector(".sync-x") as SVGElement;
  const warnEl = indicator.querySelector(".sync-warn") as SVGElement;

  let currentStatus: SyncIndicatorStatus = "disconnected";
  let lastEvent: SyncStatusEvent | null = null;
  let popupOpen = false;
  let tooltipTimer: ReturnType<typeof setTimeout> | null = null;

  function hideAllOverlays(): void {
    arrowsEl.style.display = "none";
    slashEl.style.display = "none";
    checkEl.style.display = "none";
    xEl.style.display = "none";
    warnEl.style.display = "none";
  }

  function updateIndicator(event: SyncStatusEvent): void {
    lastEvent = event;
    currentStatus = event.status;

    // Remove all state classes
    indicator.className = event.status;

    // Show/hide SVG overlays
    hideAllOverlays();
    switch (event.status) {
      case "disconnected":
        slashEl.style.display = "";
        indicator.title = "Sync: Not connected";
        break;
      case "connecting":
        indicator.title = "Sync: Connecting...";
        break;
      case "connected":
        checkEl.style.display = "";
        indicator.title =
          event.lastSyncAt != null && event.lastSyncAt > 0
            ? `Sync: Connected (last sync ${formatTimeAgo(event.lastSyncAt)})`
            : "Sync: Connected";
        break;
      case "syncing":
        arrowsEl.style.display = "";
        indicator.title = "Sync: Syncing...";
        break;
      case "conflict":
        warnEl.style.display = "";
        indicator.title = `Sync: ${event.conflictCount} conflict${event.conflictCount !== 1 ? "s" : ""} detected`;
        break;
      case "error":
        xEl.style.display = "";
        indicator.title = `Sync: Error${event.error != null && event.error !== "" ? " — " + event.error : ""}`;
        break;
    }

    // Update popup if it's open
    if (popupOpen) {
      updatePopup();
    }
  }

  function updatePopup(): void {
    if (!lastEvent) return;

    const statusLabels: Record<SyncIndicatorStatus, string> = {
      disconnected: "Not connected",
      connecting: "Connecting...",
      connected: "Connected",
      syncing: "Syncing...",
      conflict: "Conflicts detected",
      error: "Error",
    };
    popupStatus.textContent = statusLabels[lastEvent.status];
    popupLastSync.textContent =
      lastEvent.lastSyncAt != null && lastEvent.lastSyncAt > 0
        ? formatTimeAgo(lastEvent.lastSyncAt)
        : "Never";
    popupPushed.textContent = String(lastEvent.eventsPushed);
    popupPulled.textContent = String(lastEvent.eventsPulled);

    // Update action button text
    if (lastEvent.status === "error" || lastEvent.status === "disconnected") {
      popupAction.textContent = "Reconnect";
    } else if (lastEvent.status === "conflict") {
      popupAction.textContent = "View conflicts";
    } else {
      popupAction.textContent = "Sync now";
    }
  }

  function positionPopup(): void {
    const rect = indicator.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 8}px`;
    popup.style.right = `${window.innerWidth - rect.right}px`;
  }

  // Tooltip on hover
  indicator.addEventListener("mouseenter", () => {
    if (popupOpen) return;
    tooltipTimer = setTimeout(() => {
      const rect = indicator.getBoundingClientRect();
      tooltip.textContent = indicator.title;
      tooltip.style.top = `${rect.bottom + 6}px`;
      tooltip.style.right = `${window.innerWidth - rect.right}px`;
      tooltip.classList.add("visible");
    }, 400);
  });

  indicator.addEventListener("mouseleave", () => {
    if (tooltipTimer) {
      clearTimeout(tooltipTimer);
      tooltipTimer = null;
    }
    tooltip.classList.remove("visible");
  });

  // Click handler
  indicator.addEventListener("click", () => {
    tooltip.classList.remove("visible");
    if (tooltipTimer) {
      clearTimeout(tooltipTimer);
      tooltipTimer = null;
    }

    if (popupOpen) {
      popup.classList.remove("open");
      popupOpen = false;
      return;
    }

    // If error/disconnected, attempt reconnect via toast
    if (currentStatus === "error" || currentStatus === "disconnected") {
      const config = ctx.getConfig();
      if (
        config?.syncUrl != null &&
        config.syncUrl !== "" &&
        config.isTauri &&
        config.invoke != null
      ) {
        void ctx.app
          .startSync(config.invoke, config.syncUrl, config.syncMasterToken)
          .then(() => {
            ctx.showToast("Sync reconnected");
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.showToast(`Sync failed: ${msg}`);
          });
      } else {
        ctx.showToast("No sync relay configured");
      }
      return;
    }

    // If conflict, show toast with conflict info
    if (currentStatus === "conflict" && lastEvent != null) {
      ctx.showToast(
        `${lastEvent.conflictCount} sync conflict${lastEvent.conflictCount !== 1 ? "s" : ""} detected`,
      );
      return;
    }

    // Otherwise, show popup with details
    updatePopup();
    positionPopup();
    popup.classList.add("open");
    popupOpen = true;
  });

  // Popup action button
  popupAction.addEventListener("click", () => {
    popup.classList.remove("open");
    popupOpen = false;

    const config = ctx.getConfig();
    if (lastEvent?.status === "error" || lastEvent?.status === "disconnected") {
      if (
        config?.syncUrl != null &&
        config.syncUrl !== "" &&
        config.isTauri &&
        config.invoke != null
      ) {
        void ctx.app
          .startSync(config.invoke, config.syncUrl, config.syncMasterToken)
          .catch(() => {});
      }
    } else if (lastEvent?.status === "conflict") {
      ctx.showToast(
        `${lastEvent.conflictCount} conflict${lastEvent.conflictCount !== 1 ? "s" : ""} — resolve in settings`,
      );
    } else {
      if (config?.syncUrl != null && config.syncUrl !== "") {
        void ctx.app
          .syncConversations(config.syncUrl, config.syncMasterToken)
          .then((result) => {
            const total =
              result.conversations_pushed +
              result.conversations_pulled +
              result.messages_pushed +
              result.messages_pulled;
            ctx.showToast(total > 0 ? `Synced (${total} changes)` : "Already up to date");
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.showToast(`Sync failed: ${msg}`);
          });
      }
    }
  });

  // Close popup on click outside
  document.addEventListener("click", (e) => {
    if (popupOpen && !popup.contains(e.target as Node) && !indicator.contains(e.target as Node)) {
      popup.classList.remove("open");
      popupOpen = false;
    }
  });

  // Subscribe to sync status events
  ctx.app.onSyncStatus(updateIndicator);
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("Motebit bootstrap failed:", err);
});
