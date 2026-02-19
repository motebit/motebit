import { DesktopApp, COLOR_PRESETS, isSlashCommand, parseSlashCommand, type DesktopAIConfig, type InvokeFn, type McpServerConfig, type PolicyConfig, type PairingSession, type GoalCompleteEvent, type GoalApprovalEvent, type MemoryNode } from "./index";
import { stripTags } from "@motebit/ai-core";
import { MicVAD } from "@ricky0123/vad-web";
import { WebSpeechTTSProvider, WebSpeechSTTProvider, FallbackTTSProvider } from "@motebit/voice";
import type { TTSProvider } from "@motebit/voice";
import { TauriTTSProvider } from "./tauri-tts";

const webSpeechTts = new WebSpeechTTSProvider(["Samantha", "Karen", "Daniel", "Alex"]);
let ttsProvider: TTSProvider = webSpeechTts;
const sttProvider = new WebSpeechSTTProvider();

/** TTS voice setting (OpenAI voice name). */
let ttsVoice = "alloy";

/** Rebuild TTS provider chain based on current Tauri availability and settings. */
function rebuildTtsProvider(invoke?: InvokeFn): void {
  if (invoke) {
    const tauriTts = new TauriTTSProvider(invoke, { voice: ttsVoice });
    ttsProvider = new FallbackTTSProvider([tauriTts, webSpeechTts]);
  } else {
    ttsProvider = webSpeechTts;
  }
}

const canvas = document.getElementById("motebit-canvas") as HTMLCanvasElement;
if (!canvas) {
  throw new Error("Canvas element #motebit-canvas not found");
}

const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const micBtn = document.getElementById("mic-btn") as HTMLButtonElement;
const voiceWaveform = document.getElementById("voice-waveform") as HTMLCanvasElement;
const voiceTranscript = document.getElementById("voice-transcript") as HTMLSpanElement;
const inputBarWrapper = document.getElementById("input-bar-wrapper") as HTMLDivElement;

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
    void consumeApproval(true);
  });

  denyBtn.addEventListener("click", () => {
    disableButtons();
    void consumeApproval(false);
  });

  btns.appendChild(allowBtn);
  btns.appendChild(denyBtn);
  card.appendChild(btns);

  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function consumeApproval(approved: boolean): Promise<void> {
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble assistant";
  bubble.textContent = "";
  chatLog.appendChild(bubble);

  let accumulated = "";
  try {
    for await (const chunk of app.resumeAfterApproval(approved)) {
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

function showGoalApprovalCard(event: GoalApprovalEvent): void {
  const card = document.createElement("div");
  card.className = "approval-card";

  const toolDiv = document.createElement("div");
  toolDiv.className = "approval-tool";
  toolDiv.textContent = event.toolName;
  card.appendChild(toolDiv);

  const argsDiv = document.createElement("div");
  argsDiv.className = "approval-args";
  argsDiv.textContent = JSON.stringify(event.args).slice(0, 120);
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
    void consumeGoalApproval(true);
  });

  denyBtn.addEventListener("click", () => {
    disableButtons();
    void consumeGoalApproval(false);
  });

  btns.appendChild(allowBtn);
  btns.appendChild(denyBtn);
  card.appendChild(btns);

  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function consumeGoalApproval(approved: boolean): Promise<void> {
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble assistant";
  bubble.textContent = "";
  chatLog.appendChild(bubble);

  let accumulated = "";
  try {
    for await (const chunk of app.resumeGoalAfterApproval(approved)) {
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
        // Nested approval in continuation — reuse existing card
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
    addMessage("system", `Approval expired: ${msg}`);
  }
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
    case "conversations":
      openConversationsPanel();
      break;
    case "new":
      app.startNewConversation();
      chatLog.innerHTML = "";
      addMessage("system", "New conversation started");
      break;
    case "sync":
      if (currentConfig?.syncUrl) {
        addMessage("system", "Syncing conversations...");
        void app.syncConversations(currentConfig.syncUrl, currentConfig.syncMasterToken).then(result => {
          addMessage("system",
            `Sync complete: ${result.conversations_pushed} pushed, ${result.conversations_pulled} pulled, ` +
            `${result.messages_pushed} msgs pushed, ${result.messages_pulled} msgs pulled`
          );
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          addMessage("system", `Sync failed: ${msg}`);
        });
      } else {
        addMessage("system", "No sync relay configured");
      }
      break;
    case "help":
      addMessage("system",
        "Available commands:\n" +
        "/model — show current model\n" +
        "/model <name> — switch model\n" +
        "/conversations — browse past conversations\n" +
        "/new — start a new conversation\n" +
        "/sync — sync conversations with relay\n" +
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

    // Auto-title in background after streaming completes
    void app.generateTitleInBackground();

    // TTS: speak the response if voice mode is active
    if (accumulated && (micState === "ambient" || micState === "off")) {
      speakAssistantResponse(accumulated);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!bubble.textContent) {
      bubble.remove();
    }
    addMessage("system", `Error: ${msg}`);
  }
}

// === Conversations Panel ===

const conversationsPanel = document.getElementById("conversations-panel") as HTMLDivElement;
const conversationsBackdrop = document.getElementById("conversations-backdrop") as HTMLDivElement;
const convList = document.getElementById("conv-list") as HTMLDivElement;

function openConversationsPanel(): void {
  conversationsPanel.classList.add("open");
  conversationsBackdrop.classList.add("open");
  populateConversationsList();
}

function closeConversationsPanel(): void {
  conversationsPanel.classList.remove("open");
  conversationsBackdrop.classList.remove("open");
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function populateConversationsList(): void {
  convList.innerHTML = "";
  void app.listConversationsAsync(30).then(conversations => {
    if (conversations.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "font-size:12px;color:rgba(0,0,0,0.3);padding:16px;text-align:center;";
      empty.textContent = "No conversations yet";
      convList.appendChild(empty);
      return;
    }

    const currentId = app.currentConversationId;
    for (const conv of conversations) {
      const item = document.createElement("div");
      item.className = "conv-item" + (conv.conversationId === currentId ? " active" : "");

      const titleDiv = document.createElement("div");
      titleDiv.className = "conv-item-title";
      titleDiv.textContent = conv.title || "Untitled conversation";
      item.appendChild(titleDiv);

      const metaDiv = document.createElement("div");
      metaDiv.className = "conv-item-meta";
      metaDiv.innerHTML = `<span>${formatTimeAgo(conv.lastActiveAt)}</span><span>${conv.messageCount} msgs</span>`;
      item.appendChild(metaDiv);

      item.addEventListener("click", () => {
        void loadConversation(conv.conversationId);
      });
      convList.appendChild(item);
    }
  });
}

async function loadConversation(conversationId: string): Promise<void> {
  closeConversationsPanel();
  chatLog.innerHTML = "";
  addMessage("system", "Loading conversation...");

  try {
    const messages = await app.loadConversationById(conversationId);
    chatLog.innerHTML = "";
    for (const msg of messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        addMessage(msg.role, msg.content);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    chatLog.innerHTML = "";
    addMessage("system", `Failed to load conversation: ${msg}`);
  }
}

// Conversations panel event listeners
document.getElementById("conversations-btn")!.addEventListener("click", openConversationsPanel);
document.getElementById("conv-close-btn")!.addEventListener("click", closeConversationsPanel);
conversationsBackdrop.addEventListener("click", closeConversationsPanel);
document.getElementById("conv-new-btn")!.addEventListener("click", () => {
  closeConversationsPanel();
  app.startNewConversation();
  chatLog.innerHTML = "";
  addMessage("system", "New conversation started");
});

// === Goals Panel ===

const goalsPanel = document.getElementById("goals-panel") as HTMLDivElement;
const goalsBackdrop = document.getElementById("goals-backdrop") as HTMLDivElement;
const goalList = document.getElementById("goal-list") as HTMLDivElement;

function openGoalsPanel(): void {
  goalsPanel.classList.add("open");
  goalsBackdrop.classList.add("open");
  refreshGoalList();
}

function closeGoalsPanel(): void {
  goalsPanel.classList.remove("open");
  goalsBackdrop.classList.remove("open");
}

function formatInterval(ms: number): string {
  if (ms >= 86400000) return `${Math.round(ms / 86400000)}d`;
  if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`;
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function refreshGoalList(): void {
  if (!currentConfig?.isTauri || !currentConfig?.invoke) return;
  const motebitId = app.motebitId;
  if (!motebitId) return;
  const invoke = currentConfig.invoke;

  goalList.innerHTML = "";
  void invoke<Array<Record<string, unknown>>>("goals_list", { motebitId }).then(goals => {
    if (goals.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goal-empty";
      empty.textContent = "No goals yet";
      goalList.appendChild(empty);
      return;
    }

    for (const goal of goals) {
      const item = document.createElement("div");
      item.className = "goal-item";

      const promptDiv = document.createElement("div");
      promptDiv.className = "goal-item-prompt";
      const promptText = String(goal.prompt || "");
      promptDiv.textContent = promptText.length > 60 ? promptText.slice(0, 60) + "..." : promptText;
      promptDiv.title = promptText;
      item.appendChild(promptDiv);

      const metaDiv = document.createElement("div");
      metaDiv.className = "goal-item-meta";

      const statusDot = document.createElement("span");
      const status = String(goal.status || "active");
      statusDot.className = `goal-status-dot ${status}`;
      metaDiv.appendChild(statusDot);

      const statusText = document.createElement("span");
      statusText.textContent = status;
      metaDiv.appendChild(statusText);

      const intervalSpan = document.createElement("span");
      intervalSpan.textContent = formatInterval(Number(goal.interval_ms) || 0);
      metaDiv.appendChild(intervalSpan);

      const modeSpan = document.createElement("span");
      modeSpan.textContent = String(goal.mode || "recurring");
      metaDiv.appendChild(modeSpan);

      item.appendChild(metaDiv);

      const actions = document.createElement("div");
      actions.className = "goal-item-actions";

      const goalId = String(goal.goal_id);

      if (status === "active" || status === "paused") {
        const toggleBtn = document.createElement("button");
        toggleBtn.textContent = status === "active" ? "Pause" : "Resume";
        toggleBtn.addEventListener("click", () => {
          void toggleGoal(goalId);
        });
        actions.appendChild(toggleBtn);
      }

      // History toggle
      const historyBtn = document.createElement("button");
      historyBtn.className = "goal-toggle-outcomes";
      historyBtn.textContent = "History";
      actions.appendChild(historyBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "goal-delete-btn";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => {
        void deleteGoal(goalId);
      });
      actions.appendChild(deleteBtn);

      item.appendChild(actions);

      // Expandable outcomes section
      const outcomesDiv = document.createElement("div");
      outcomesDiv.className = "goal-outcomes";
      item.appendChild(outcomesDiv);

      historyBtn.addEventListener("click", () => {
        const isOpen = outcomesDiv.classList.contains("open");
        if (isOpen) {
          outcomesDiv.classList.remove("open");
        } else {
          outcomesDiv.classList.add("open");
          loadGoalOutcomes(goalId, outcomesDiv);
        }
      });

      goalList.appendChild(item);
    }
  }).catch(() => {
    goalList.innerHTML = '<div class="goal-empty">Failed to load goals</div>';
  });
}

function loadGoalOutcomes(goalId: string, container: HTMLDivElement): void {
  if (!currentConfig?.isTauri || !currentConfig?.invoke) return;
  const invoke = currentConfig.invoke;

  container.innerHTML = '<div style="font-size:11px;color:rgba(0,0,0,0.3);padding:2px 0;">Loading...</div>';
  void invoke<Array<Record<string, unknown>>>("goals_outcomes", { goalId, limit: 5 }).then(outcomes => {
    container.innerHTML = "";
    if (outcomes.length === 0) {
      container.innerHTML = '<div style="font-size:11px;color:rgba(0,0,0,0.3);padding:2px 0;">No runs yet</div>';
      return;
    }
    for (const outcome of outcomes) {
      const row = document.createElement("div");
      row.className = "goal-outcome-row";

      const dot = document.createElement("span");
      const oStatus = String(outcome.status || "");
      dot.className = `goal-status-dot ${oStatus === "completed" ? "active" : "suspended"}`;
      row.appendChild(dot);

      const summary = document.createElement("span");
      summary.className = "goal-outcome-summary";
      if (oStatus === "completed" && outcome.summary) {
        summary.textContent = String(outcome.summary);
      } else if (outcome.error_message) {
        summary.textContent = String(outcome.error_message);
        summary.style.color = "rgba(248,113,113,0.8)";
      } else {
        summary.textContent = oStatus;
      }
      row.appendChild(summary);

      const time = document.createElement("span");
      time.className = "goal-outcome-time";
      time.textContent = formatTimeAgo(Number(outcome.ran_at) || 0);
      row.appendChild(time);

      container.appendChild(row);
    }
  }).catch(() => {
    container.innerHTML = '<div style="font-size:11px;color:rgba(0,0,0,0.3);">Failed to load</div>';
  });
}

async function createGoal(): Promise<void> {
  if (!currentConfig?.isTauri || !currentConfig?.invoke) return;
  const motebitId = app.motebitId;
  if (!motebitId) return;

  const promptEl = document.getElementById("goal-prompt") as HTMLTextAreaElement;
  const intervalEl = document.getElementById("goal-interval") as HTMLSelectElement;
  const modeEl = document.getElementById("goal-mode") as HTMLSelectElement;

  const prompt = promptEl.value.trim();
  if (!prompt) return;

  const intervalMs = parseInt(intervalEl.value, 10);
  const mode = modeEl.value;
  const goalId = crypto.randomUUID();

  try {
    await currentConfig.invoke("goals_create", {
      motebitId,
      goalId,
      prompt,
      intervalMs,
      mode,
    });
    promptEl.value = "";
    refreshGoalList();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    addMessage("system", `Failed to create goal: ${msg}`);
  }
}

async function toggleGoal(goalId: string): Promise<void> {
  if (!currentConfig?.isTauri || !currentConfig?.invoke) return;
  try {
    await currentConfig.invoke("goals_toggle", { goalId });
    refreshGoalList();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    addMessage("system", `Failed to toggle goal: ${msg}`);
  }
}

async function deleteGoal(goalId: string): Promise<void> {
  if (!currentConfig?.isTauri || !currentConfig?.invoke) return;
  try {
    await currentConfig.invoke("goals_delete", { goalId });
    refreshGoalList();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    addMessage("system", `Failed to delete goal: ${msg}`);
  }
}

// Goals panel event listeners
document.getElementById("goals-btn")!.addEventListener("click", openGoalsPanel);
document.getElementById("goals-close-btn")!.addEventListener("click", closeGoalsPanel);
goalsBackdrop.addEventListener("click", closeGoalsPanel);
document.getElementById("goal-create-btn")!.addEventListener("click", () => {
  void createGoal();
});

// === Memory Panel ===

const memoryPanel = document.getElementById("memory-panel") as HTMLDivElement;
const memoryBackdrop = document.getElementById("memory-backdrop") as HTMLDivElement;
const memoryList = document.getElementById("memory-list") as HTMLDivElement;
const memoryCount = document.getElementById("memory-count") as HTMLSpanElement;
const memorySearch = document.getElementById("memory-search") as HTMLInputElement;

let allMemories: MemoryNode[] = [];

function openMemoryPanel(): void {
  memoryPanel.classList.add("open");
  memoryBackdrop.classList.add("open");
  refreshMemoryList();
}

function closeMemoryPanel(): void {
  memoryPanel.classList.remove("open");
  memoryBackdrop.classList.remove("open");
}

function refreshMemoryList(): void {
  memoryList.innerHTML = "";
  void app.listMemories().then(memories => {
    allMemories = memories;
    memoryCount.textContent = String(memories.length);
    renderMemoryItems(memories, memorySearch.value.trim());
  });
}

function renderMemoryItems(memories: MemoryNode[], query: string): void {
  memoryList.innerHTML = "";
  const filtered = query
    ? memories.filter(m => m.content.toLowerCase().includes(query.toLowerCase()))
    : memories;

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mem-empty";
    empty.textContent = query ? "No matches" : "No memories yet";
    memoryList.appendChild(empty);
    return;
  }

  for (const mem of filtered) {
    const item = document.createElement("div");
    item.className = "mem-item";

    const contentDiv = document.createElement("div");
    contentDiv.className = "mem-item-content";
    contentDiv.textContent = mem.content;
    item.appendChild(contentDiv);

    const metaDiv = document.createElement("div");
    metaDiv.className = "mem-item-meta";

    // Sensitivity badge (skip "none")
    if (mem.sensitivity && mem.sensitivity !== "none") {
      const badge = document.createElement("span");
      badge.className = `mem-sensitivity-badge ${mem.sensitivity}`;
      badge.textContent = mem.sensitivity;
      metaDiv.appendChild(badge);
    }

    // Effective confidence %
    const conf = document.createElement("span");
    const decayed = app.getDecayedConfidence(mem);
    conf.textContent = `${Math.round(decayed * 100)}%`;
    metaDiv.appendChild(conf);

    // Time ago
    const time = document.createElement("span");
    time.textContent = formatTimeAgo(mem.created_at);
    metaDiv.appendChild(time);

    item.appendChild(metaDiv);

    // Delete button
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "mem-delete-btn";
    deleteBtn.textContent = "\u00d7";
    deleteBtn.title = "Delete memory";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void app.deleteMemory(mem.node_id).then(() => {
        refreshMemoryList();
      });
    });
    item.appendChild(deleteBtn);

    memoryList.appendChild(item);
  }
}

// Debounced search
let memorySearchTimeout: ReturnType<typeof setTimeout> | null = null;
memorySearch.addEventListener("input", () => {
  if (memorySearchTimeout) clearTimeout(memorySearchTimeout);
  memorySearchTimeout = setTimeout(() => {
    renderMemoryItems(allMemories, memorySearch.value.trim());
  }, 200);
});

// Memory panel event listeners
document.getElementById("memory-btn")!.addEventListener("click", openMemoryPanel);
document.getElementById("memory-close-btn")!.addEventListener("click", closeMemoryPanel);
memoryBackdrop.addEventListener("click", closeMemoryPanel);

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

// === Settings Modal ===

const settingsBackdrop = document.getElementById("settings-backdrop") as HTMLDivElement;
const settingsModal = document.getElementById("settings-modal") as HTMLDivElement;
const settingsProvider = document.getElementById("settings-provider") as HTMLSelectElement;
const settingsModel = document.getElementById("settings-model") as HTMLInputElement;
const settingsApiKey = document.getElementById("settings-apikey") as HTMLInputElement;
const settingsApiKeyToggle = document.getElementById("settings-apikey-toggle") as HTMLButtonElement;
const settingsOperatorMode = document.getElementById("settings-operator-mode") as HTMLInputElement;
const colorPresetGrid = document.getElementById("color-preset-grid") as HTMLDivElement;
const mcpServerList = document.getElementById("mcp-server-list") as HTMLDivElement;
const persistenceThreshold = document.getElementById("settings-persistence-threshold") as HTMLInputElement;
const persistenceThresholdValue = document.getElementById("persistence-threshold-value") as HTMLSpanElement;
const rejectSecrets = document.getElementById("settings-reject-secrets") as HTMLInputElement;
const maxCalls = document.getElementById("settings-max-calls") as HTMLInputElement;

const settingsWhisperApiKey = document.getElementById("settings-whisper-apikey") as HTMLInputElement;
const settingsWhisperApiKeyToggle = document.getElementById("settings-whisper-apikey-toggle") as HTMLButtonElement;
const settingsVoiceAutoSend = document.getElementById("settings-voice-autosend") as HTMLInputElement;
const settingsVoiceResponse = document.getElementById("settings-voice-response") as HTMLInputElement;
const settingsTtsVoice = document.getElementById("settings-tts-voice") as HTMLSelectElement;
let hasWhisperKeyInKeyring = false;

// Settings state
let selectedColorPreset = "borosilicate";
let previousColorPreset = "borosilicate";
let selectedApprovalPreset = "balanced";
let mcpServersConfig: McpServerConfig[] = [];
let hasApiKeyInKeyring = false;

// === Tab Switching ===

function switchTab(tabName: string): void {
  document.querySelectorAll(".settings-tab").forEach(tab => {
    tab.classList.toggle("active", (tab as HTMLElement).dataset.tab === tabName);
  });
  document.querySelectorAll(".settings-pane").forEach(pane => {
    pane.classList.toggle("active", pane.id === `pane-${tabName}`);
  });
  if (tabName === "identity") populateIdentityTab();
}

document.querySelectorAll(".settings-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    const name = (tab as HTMLElement).dataset.tab;
    if (name) switchTab(name);
  });
});

// === Color Presets ===

function buildColorSwatches(): void {
  colorPresetGrid.innerHTML = "";
  for (const [name, preset] of Object.entries(COLOR_PRESETS)) {
    const btn = document.createElement("button");
    btn.className = "color-swatch" + (name === selectedColorPreset ? " selected" : "");
    btn.dataset.preset = name;
    const t = preset.tint;
    const g = preset.glow;
    btn.style.background = `radial-gradient(circle at 40% 40%, rgba(${Math.round(g[0] * 255)},${Math.round(g[1] * 255)},${Math.round(g[2] * 255)},0.6), rgba(${Math.round(t[0] * 200)},${Math.round(t[1] * 200)},${Math.round(t[2] * 200)},0.8))`;
    const label = document.createElement("span");
    label.className = "swatch-name";
    label.textContent = name.charAt(0).toUpperCase() + name.slice(1);
    btn.appendChild(label);
    btn.addEventListener("click", () => selectColorPreset(name));
    colorPresetGrid.appendChild(btn);
  }
}

function selectColorPreset(name: string): void {
  selectedColorPreset = name;
  document.querySelectorAll(".color-swatch").forEach(el => {
    el.classList.toggle("selected", (el as HTMLElement).dataset.preset === name);
  });
  app.setInteriorColor(name);
  updateVoiceGlowColor();
}

// === Presence Toggle & Voice ===
//
// The presence button awakens the creature. Voice is emergent from ambient sensing.
//   off:          mic released, creature floats in its own rhythm (default)
//   ambient:      creature senses the room, VAD monitors for speech (body alive)
//   voice:        VAD detected speech → recording + waveform + transcription
//   transcribing: Whisper processing, creature senses (body)
//   speaking:     TTS playing, creature pulses (body)
//
// Click toggles: off → ambient → off. Voice auto-enters on speech, auto-exits on silence.
// Escape from any state → off.

type MicState = "off" | "ambient" | "voice" | "transcribing" | "speaking";
let micState: MicState = "off";
let audioContext: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let micStream: MediaStream | null = null;
let waveformAnimationId = 0;
let ambientAnimationId = 0;
let voiceFinalTranscript = "";
let voiceInterimTranscript = "";
const waveformSmoothed = new Float32Array(64);

/** Whether Web Speech API STT is usable (set false on permission/service errors). */
let sttAvailable = true;
let sttErrorShown = false;

/** MediaRecorder for Whisper fallback — captures audio alongside AnalyserNode pipeline. */
let mediaRecorder: MediaRecorder | null = null;
let mediaRecorderChunks: Blob[] = [];

/** Voice settings. */
let voiceAutoSend = true;
let voiceResponseEnabled = true;

/** TTS state. */
let ttsSpeaking = false;
let ttsPulseAnimationId = 0;

/** Rolling noise floor — persists across voice↔ambient transitions. */
let noiseFloor = 0;

/** Silero VAD — neural speech detection (~50-100ms onset). */
let sileroVad: MicVAD | null = null;
let sileroVadFailed = false;

/** Fallback VAD state — energy heuristic, used only if Silero fails to load. */
let fallbackSpeechConfidence = 0;
let fallbackSpeechOnsetTime = 0;
const VAD_ONSET_MS = 300;
const VAD_CONFIDENCE_THRESHOLD = 0.55;

/** Silence detection state — auto end-of-speech in voice mode. */
let speechActiveInVoice = false;
let silenceOnsetTime = 0;
const SILENCE_DURATION_MS = 1500;
const SPEECH_RMS_THRESHOLD = 0.015;

/** Cached saturated RGB for waveform canvas strokes. */
let waveformColor = { r: 153, g: 163, b: 230 };

function updateVoiceGlowColor(): void {
  const preset = COLOR_PRESETS[selectedColorPreset];
  if (!preset) return;
  const glow = preset.glow;

  // CSS variable for border/shadow glow
  const r = Math.round(glow[0] * 255);
  const green = Math.round(glow[1] * 255);
  const b = Math.round(glow[2] * 255);
  inputBarWrapper.style.setProperty("--voice-glow-color", `rgba(${r},${green},${b},0.55)`);

  // Saturated color for canvas waveform strokes (higher contrast on glass)
  const maxG = Math.max(glow[0], glow[1], glow[2], 0.01);
  const satPow = 1.3;
  waveformColor = {
    r: Math.min(255, Math.round(((glow[0] / maxG) ** (1 / satPow)) * glow[0] * 300)),
    g: Math.min(255, Math.round(((glow[1] / maxG) ** (1 / satPow)) * glow[1] * 300)),
    b: Math.min(255, Math.round(((glow[2] / maxG) ** (1 / satPow)) * glow[2] * 300)),
  };
}

let micErrorShown = false;

/** Acquire mic and create audio analysis pipeline if not already running. */
async function ensureAudioPipeline(): Promise<boolean> {
  if (audioContext && analyserNode && micStream) return true;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    if (!micErrorShown) {
      micErrorShown = true;
      addMessage("system", "Microphone access denied — open System Settings > Privacy & Security > Microphone, then grant access to Motebit.");
    }
    return false;
  }
  micStream = stream;

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);
  audioContext = ctx;
  analyserNode = analyser;
  return true;
}

/** Release audio context and mic stream. */
function releaseAudioResources(): void {
  if (audioContext) {
    void audioContext.close();
    audioContext = null;
    analyserNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  fallbackSpeechConfidence = 0;
  fallbackSpeechOnsetTime = 0;
  speechActiveInVoice = false;
  silenceOnsetTime = 0;
}

/** Initialize Silero VAD (lazy, first ambient entry). Shares our AudioContext + mic stream. */
async function initSileroVad(): Promise<void> {
  if (sileroVad || sileroVadFailed) return;
  if (!audioContext || !micStream) return;

  const ctx = audioContext;
  const stream = micStream;

  try {
    sileroVad = await MicVAD.new({
      audioContext: ctx,
      getStream: async () => stream,
      pauseStream: async () => {},          // no-op — we manage stream lifecycle
      resumeStream: async () => micStream!, // return current stream
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      minSpeechMs: 100,
      startOnLoad: false,
      model: "v5",
      baseAssetPath: "/",
      onnxWASMBasePath: "/",
      onSpeechStart: () => {
        if (micState === "ambient") {
          void startVoice();
        }
      },
      onSpeechEnd: () => {},
      onVADMisfire: () => {},
    });
  } catch (err: unknown) {
    sileroVadFailed = true;
    console.warn("Silero VAD failed to load, falling back to energy heuristic:", err instanceof Error ? err.message : String(err));
  }
}

function toggleVoice(): void {
  if (micState === "off") {
    void enterAmbient();                // off → ambient (awaken creature)
  } else if (micState === "ambient") {
    stopAmbient();                      // ambient → off (release mic)
  } else if (micState === "voice") {
    stopVoice(true, true);              // voice → ambient (process transcript)
  } else if (micState === "speaking") {
    cancelTTS();
    void startVoice();                  // speaking → voice (interrupt TTS)
  } else if (micState === "transcribing") {
    // Cancel transcription → ambient
    voiceTranscript.textContent = "";
    voiceTranscript.style.display = "";
    inputBarWrapper.classList.remove("listening");
    micBtn.classList.remove("active");
    micBtn.classList.add("ambient");
    micState = "ambient";
    fallbackSpeechConfidence = 0;
    fallbackSpeechOnsetTime = 0;
    if (sileroVad) void sileroVad.start();
    startAmbientLoop();
  }
}

async function enterAmbient(): Promise<void> {
  if (!await ensureAudioPipeline()) return;
  micState = "ambient";
  micBtn.classList.add("ambient");
  micBtn.classList.remove("active");
  fallbackSpeechConfidence = 0;
  fallbackSpeechOnsetTime = 0;
  updateVoiceGlowColor();
  await initSileroVad();
  if (sileroVad) {
    await sileroVad.start();
  }
  startAmbientLoop();
}

async function startVoice(): Promise<void> {
  // Cancel any ongoing TTS
  cancelTTS();

  // If ambient, stop its loop (we'll take over the audio pipeline)
  stopAmbientLoop();
  if (sileroVad) void sileroVad.pause();
  app.setAudioReactivity(null);

  // Reset VAD/silence state
  fallbackSpeechConfidence = 0;
  fallbackSpeechOnsetTime = 0;
  speechActiveInVoice = false;
  silenceOnsetTime = 0;

  // Ensure mic + audio analysis pipeline
  if (!await ensureAudioPipeline()) return;

  // Speech recognition via STT provider (only if API available and not previously denied)
  if (sttAvailable) {
    sttProvider.onResult = (transcript: string, isFinal: boolean) => {
      if (isFinal) {
        voiceFinalTranscript += transcript;
        voiceInterimTranscript = "";
      } else {
        voiceInterimTranscript = transcript;
      }
      voiceTranscript.textContent = (voiceFinalTranscript + voiceInterimTranscript).trim();
    };

    sttProvider.onError = (error: string) => {
      if (error === "no-speech" || error === "aborted") return;
      if (error === "not-allowed" || error === "service-not-allowed"
          || error === "Microphone permission denied"
          || error === "SpeechRecognition API not available") {
        sttAvailable = false;
        if (!sttErrorShown) {
          sttErrorShown = true;
          addMessage("system", "Speech recognition needs permission — open System Settings > Privacy & Security > Speech Recognition. Using Whisper fallback.");
        }
        return;
      }
      addMessage("system", `Voice error: ${error}`);
      stopVoice(false, false); // error → full stop
    };

    sttProvider.onEnd = () => {}; // Auto-restart handled by provider in continuous mode

    try {
      sttProvider.start({ continuous: true, interimResults: true, language: "en-US" });
    } catch {
      sttAvailable = false;
    }
  }

  // Start MediaRecorder for Whisper fallback (always, alongside Web Speech)
  mediaRecorderChunks = [];
  if (micStream) {
    try {
      const mr = new MediaRecorder(micStream, { mimeType: "audio/webm;codecs=opus" });
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) mediaRecorderChunks.push(e.data);
      };
      mr.start(250); // collect chunks every 250ms
      mediaRecorder = mr;
    } catch {
      // MediaRecorder not available — Web Speech only
    }
  }

  // UI state
  micState = "voice";
  voiceFinalTranscript = "";
  voiceInterimTranscript = "";
  voiceTranscript.textContent = "";
  inputBarWrapper.classList.add("listening");
  micBtn.classList.add("active");
  micBtn.classList.remove("ambient");
  updateVoiceGlowColor();

  sizeWaveformCanvas();
  startWaveformLoop();
}

/**
 * Stop voice recognition.
 * transfer:  true = put transcript in input field, false = discard
 * toAmbient: true = keep mic alive, creature feels the room. false = release mic.
 */
function stopVoice(transfer: boolean, toAmbient: boolean): void {
  // Reset silence detection state
  speechActiveInVoice = false;
  silenceOnsetTime = 0;

  // Stop recognition
  if (sttProvider.listening) {
    sttProvider.stop();
  }

  // Stop MediaRecorder
  const recorderWasActive = mediaRecorder?.state === "recording";
  if (mediaRecorder) {
    try { mediaRecorder.stop(); } catch { /* */ }
    mediaRecorder = null;
  }

  // Stop waveform
  if (waveformAnimationId) {
    cancelAnimationFrame(waveformAnimationId);
    waveformAnimationId = 0;
  }
  const ctx2d = voiceWaveform.getContext("2d");
  if (ctx2d) ctx2d.clearRect(0, 0, voiceWaveform.width, voiceWaveform.height);

  // Determine transcript source
  const webSpeechText = (voiceFinalTranscript + voiceInterimTranscript).trim();
  voiceFinalTranscript = "";
  voiceInterimTranscript = "";

  if (transfer && webSpeechText && sttAvailable) {
    // Web Speech API produced a transcript — use it directly
    finishVoiceTranscript(webSpeechText, toAmbient);
  } else if (transfer && recorderWasActive && mediaRecorderChunks.length > 0) {
    // No Web Speech transcript — fall back to Whisper via MediaRecorder audio
    micState = "transcribing";
    inputBarWrapper.classList.remove("listening");
    micBtn.classList.remove("active");
    micBtn.classList.add("ambient");
    voiceTranscript.textContent = "Transcribing...";
    voiceTranscript.style.display = "block";

    void transcribeWithWhisper(toAmbient);
  } else {
    // No transfer or no audio — just clean up
    finishVoiceTranscript("", toAmbient);
  }
}

/** Transcribe recorded audio chunks via Whisper (Tauri command). */
async function transcribeWithWhisper(toAmbient: boolean): Promise<void> {
  try {
    const blob = new Blob(mediaRecorderChunks, { type: "audio/webm;codecs=opus" });
    mediaRecorderChunks = [];

    // Convert to base64
    const arrayBuf = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    const audioBase64 = btoa(binary);

    if (!currentConfig?.isTauri || !currentConfig?.invoke) {
      addMessage("system", "Whisper transcription requires the desktop app (Tauri)");
      finishVoiceTranscript("", toAmbient);
      return;
    }

    // Get Whisper API key from keyring (if set)
    let whisperApiKey: string | undefined;
    try {
      const keyVal = await currentConfig.invoke<string | null>("keyring_get", { key: "whisper_api_key" });
      whisperApiKey = keyVal ?? undefined;
    } catch {
      // No key available
    }

    const transcript = await currentConfig.invoke<string>("transcribe_audio", {
      audioBase64,
      apiKey: whisperApiKey ?? null,
    });

    finishVoiceTranscript(transcript.trim(), toAmbient);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    addMessage("system", msg);
    finishVoiceTranscript("", toAmbient);
  }
}

/** Complete voice input: put transcript in input, optionally auto-send, transition state. */
function finishVoiceTranscript(text: string, toAmbient: boolean): void {
  // UI — clear voice state
  inputBarWrapper.classList.remove("listening");
  micBtn.classList.remove("active");
  voiceTranscript.textContent = "";
  voiceTranscript.style.display = "";

  if (text) {
    chatInput.value = text;
  }

  if (toAmbient) {
    micState = "ambient";
    micBtn.classList.add("ambient");
    if (sileroVad) void sileroVad.start();
    startAmbientLoop();
  } else {
    micState = "off";
    micBtn.classList.remove("ambient");
    releaseAudioResources();
    app.setAudioReactivity(null);
  }

  chatInput.focus();

  // Auto-send if enabled and there's text
  if (voiceAutoSend && text) {
    void handleSend();
  }
}

/** Stop ambient sensing and release mic. */
function stopAmbient(): void {
  stopAmbientLoop();
  if (sileroVad) {
    void sileroVad.destroy();
    sileroVad = null;
  }
  releaseAudioResources();
  app.setAudioReactivity(null);
  micState = "off";
  micBtn.classList.remove("ambient");
  fallbackSpeechConfidence = 0;
  fallbackSpeechOnsetTime = 0;
}

function stopAmbientLoop(): void {
  if (ambientAnimationId) {
    cancelAnimationFrame(ambientAnimationId);
    ambientAnimationId = 0;
  }
}

/** Ambient analysis loop — feeds audio energy to the creature's body. No waveform drawing. */
function startAmbientLoop(): void {
  if (!analyserNode) return;

  const timeDomain = new Uint8Array(analyserNode.frequencyBinCount);
  const freqDomain = new Uint8Array(analyserNode.frequencyBinCount);
  let smoothedRms = 0;
  let smoothedLow = 0;
  let smoothedMid = 0;
  let smoothedHigh = 0;
  let smoothedFlatness = 0;

  const analyze = (): void => {
    if (micState !== "ambient" || !analyserNode) return;

    analyserNode.getByteTimeDomainData(timeDomain);
    analyserNode.getByteFrequencyData(freqDomain);

    // RMS — gentler smoothing (body language, not visualization)
    let sumSq = 0;
    for (let j = 0; j < timeDomain.length; j++) {
      const v = (timeDomain[j]! / 128.0) - 1.0;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / timeDomain.length);
    smoothedRms += (rms > smoothedRms ? 0.3 : 0.04) * (rms - smoothedRms);

    // Noise floor: slow rise (absorbs sustained ambient), fast fall (recovers sensitivity)
    noiseFloor += (rms > noiseFloor ? 0.003 : 0.05) * (rms - noiseFloor);

    // Frequency bands
    const binCount = freqDomain.length;
    const lowEnd = Math.max(1, Math.floor(binCount * 0.06));
    const midEnd = Math.max(2, Math.floor(binCount * 0.25));
    let lowE = 0, midE = 0, highE = 0;
    for (let j = 0; j < binCount; j++) {
      const v = freqDomain[j]! / 255;
      if (j < lowEnd) lowE += v;
      else if (j < midEnd) midE += v;
      else highE += v;
    }
    lowE /= lowEnd;
    midE /= (midEnd - lowEnd);
    highE /= (binCount - midEnd);

    smoothedLow += (lowE > smoothedLow ? 0.3 : 0.04) * (lowE - smoothedLow);
    smoothedMid += (midE > smoothedMid ? 0.3 : 0.04) * (midE - smoothedMid);
    smoothedHigh += (highE > smoothedHigh ? 0.25 : 0.03) * (highE - smoothedHigh);

    // Mid-band spectral flatness (geom/arith mean, 0 = tonal, 1 = noise)
    let logSum = 0;
    let linSum = 0;
    for (let j = lowEnd; j < midEnd; j++) {
      const v = freqDomain[j]! / 255 + 1e-10;
      logSum += Math.log(v);
      linSum += v;
    }
    const flatBins = midEnd - lowEnd;
    const rawFlatness = linSum > 1e-8 ? Math.exp(logSum / flatBins) / (linSum / flatBins) : 0;
    smoothedFlatness += 0.08 * (rawFlatness - smoothedFlatness);

    // Gate: only energy above the noise floor drives response
    const gatedRms = Math.max(0, smoothedRms - noiseFloor);
    const gate = smoothedRms > 0.001 ? gatedRms / smoothedRms : 0;

    // Shape: flatness controls response quality (multiplicative, not branching)
    const flat2 = smoothedFlatness * smoothedFlatness;
    const damping = Math.max(0.15, 1 - flat2 * 0.9);     // noise → suppress
    const shimmer = 1 + (1 - smoothedFlatness) * 0.6;     // tonal → boost iridescence

    app.setAudioReactivity({
      rms: gatedRms * damping,
      low: smoothedLow * gate * damping,
      mid: smoothedMid * gate * damping,
      high: smoothedHigh * gate * damping * shimmer,
    });

    // VAD: detect speech onset → transition to voice mode
    // When Silero VAD is active, it handles onset via onSpeechStart callback.
    // Fallback energy heuristic only runs if Silero failed to load.
    if (sileroVadFailed) {
      const isSpeechLike =
        smoothedFlatness < 0.65 &&   // tonal (speech), not flat (noise)
        gatedRms > 0.02 &&           // energy above adaptive noise floor
        smoothedMid > 0.08;          // formant band presence

      if (isSpeechLike) {
        fallbackSpeechConfidence += 0.08 * (1 - fallbackSpeechConfidence);
        if (fallbackSpeechConfidence > VAD_CONFIDENCE_THRESHOLD) {
          if (fallbackSpeechOnsetTime === 0) {
            fallbackSpeechOnsetTime = performance.now();
          } else if (performance.now() - fallbackSpeechOnsetTime > VAD_ONSET_MS) {
            // Sustained speech detected — enter voice mode
            fallbackSpeechConfidence = 0;
            fallbackSpeechOnsetTime = 0;
            void startVoice();
            return; // exit ambient loop — startVoice takes over
          }
        }
      } else {
        fallbackSpeechConfidence *= 0.9;
        if (fallbackSpeechConfidence < 0.2) {
          fallbackSpeechOnsetTime = 0;
        }
      }
    }

    ambientAnimationId = requestAnimationFrame(analyze);
  };

  ambientAnimationId = requestAnimationFrame(analyze);
}

// === TTS (Text-to-Speech) ===

/** Speak text via TTS provider. Fire-and-forget with ttsSpeaking guard. */
function speakText(text: string): void {
  if (!voiceResponseEnabled || !text.trim()) return;

  ttsProvider.cancel(); // Clear any queued speech
  ttsSpeaking = true;
  micState = "speaking";
  micBtn.classList.remove("active");
  micBtn.classList.add("ambient");
  startTTSPulse();

  ttsProvider.speak(text).then(() => {
    if (!ttsSpeaking) return; // Already cancelled
    ttsSpeaking = false;
    stopTTSPulse();
    if (micStream && audioContext && analyserNode) {
      micState = "ambient";
      micBtn.classList.add("ambient");
      if (sileroVad) void sileroVad.start();
      startAmbientLoop();
    } else {
      micState = "off";
      micBtn.classList.remove("ambient");
    }
  }).catch(() => {
    if (!ttsSpeaking) return; // Already cancelled
    ttsSpeaking = false;
    stopTTSPulse();
    if (micState === "speaking") {
      micState = micStream ? "ambient" : "off";
      if (micState === "ambient") {
        if (sileroVad) void sileroVad.start();
        startAmbientLoop();
      }
    }
  });
}

/** Cancel ongoing TTS. */
function cancelTTS(): void {
  if (ttsSpeaking) {
    ttsProvider.cancel();
    ttsSpeaking = false;
    stopTTSPulse();
  }
}

/** Simulated creature audio reactivity during TTS — pulse at speech rhythm. */
function startTTSPulse(): void {
  stopTTSPulse();
  let phase = 0;
  const pulse = (): void => {
    if (!ttsSpeaking) return;
    phase += 0.05;
    // Gentle pulsing — simulates the creature's voice
    const base = 0.15;
    const wave = Math.sin(phase * 3.7) * 0.08 + Math.sin(phase * 7.1) * 0.04;
    app.setAudioReactivity({
      rms: base + wave,
      low: base * 0.8 + wave * 0.5,
      mid: base * 1.2 + wave,
      high: base * 0.4 + Math.sin(phase * 11.3) * 0.03,
    });
    ttsPulseAnimationId = requestAnimationFrame(pulse);
  };
  ttsPulseAnimationId = requestAnimationFrame(pulse);
}

function stopTTSPulse(): void {
  if (ttsPulseAnimationId) {
    cancelAnimationFrame(ttsPulseAnimationId);
    ttsPulseAnimationId = 0;
  }
  if (!ttsSpeaking) {
    app.setAudioReactivity(null);
  }
}

/** Speak an assistant response if voice response is enabled. Strips tags. */
function speakAssistantResponse(text: string): void {
  if (!voiceResponseEnabled) return;
  const clean = stripTags(text).trim();
  if (clean) speakText(clean);
}

function sizeWaveformCanvas(): void {
  const rect = inputBarWrapper.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  voiceWaveform.width = rect.width * dpr;
  voiceWaveform.height = rect.height * dpr;
  voiceWaveform.style.width = rect.width + "px";
  voiceWaveform.style.height = rect.height + "px";
}

/** Waveform render loop for voice mode — draws multi-wave visualization + feeds creature body. */
function startWaveformLoop(): void {
  const ctx2d = voiceWaveform.getContext("2d");
  if (!ctx2d || !analyserNode) return;

  const timeDomain = new Uint8Array(analyserNode.frequencyBinCount);
  const freqDomain = new Uint8Array(analyserNode.frequencyBinCount);
  let smoothedRms = 0;
  let smoothedLow = 0;
  let smoothedMid = 0;
  let smoothedHigh = 0;
  let smoothedFlatness = 0;

  // Edge attenuation: 1 - x^6, wide flat top with smooth rolloff
  const att = (x: number): number => {
    const d = 2 * x - 1;
    const d2 = d * d;
    return 1 - d2 * d2 * d2;
  };

  // Four wave layers — each with unique motion and frequency-band affinity.
  // In silence they nearly overlap (one line). When speaking they separate
  // and respond to different aspects of speech (bass/mid/treble).
  const waves = [
    { tf: 0.7,  sf: 6.5,  amp: 0.40, alpha: 0.10, lw: 16,  band: 0 }, // slow wide glow — bass
    { tf: 1.1,  sf: 9.3,  amp: 0.32, alpha: 0.28, lw: 4.5, band: 1 }, // mid halo — formants
    { tf: 1.5,  sf: 13.1, amp: 0.25, alpha: 0.50, lw: 2.5, band: 1 }, // sharp — formants
    { tf: 2.1,  sf: 17.4, amp: 0.15, alpha: 0.88, lw: 1.5, band: 2 }, // crisp center — consonants
  ];

  const N = 64;
  const waveY = new Float32Array(N);

  const draw = (timestamp: number): void => {
    if (micState !== "voice" || !analyserNode) return;

    const t = timestamp / 1000;
    const w = voiceWaveform.width;
    const h = voiceWaveform.height;
    const dpr = window.devicePixelRatio || 1;

    ctx2d.clearRect(0, 0, w, h);

    analyserNode.getByteTimeDomainData(timeDomain);
    analyserNode.getByteFrequencyData(freqDomain);

    // RMS — asymmetric attack/decay
    let sumSq = 0;
    for (let j = 0; j < timeDomain.length; j++) {
      const v = (timeDomain[j]! / 128.0) - 1.0;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / timeDomain.length);
    smoothedRms += (rms > smoothedRms ? 0.4 : 0.06) * (rms - smoothedRms);

    // Noise floor: slow rise (absorbs sustained ambient), fast fall (recovers sensitivity)
    noiseFloor += (rms > noiseFloor ? 0.003 : 0.05) * (rms - noiseFloor);

    // Frequency band energies
    const binCount = freqDomain.length;
    const lowEnd = Math.max(1, Math.floor(binCount * 0.06));
    const midEnd = Math.max(2, Math.floor(binCount * 0.25));
    let lowE = 0, midE = 0, highE = 0;
    for (let j = 0; j < binCount; j++) {
      const v = freqDomain[j]! / 255;
      if (j < lowEnd) lowE += v;
      else if (j < midEnd) midE += v;
      else highE += v;
    }
    lowE /= lowEnd;
    midE /= (midEnd - lowEnd);
    highE /= (binCount - midEnd);

    smoothedLow += (lowE > smoothedLow ? 0.35 : 0.05) * (lowE - smoothedLow);
    smoothedMid += (midE > smoothedMid ? 0.35 : 0.05) * (midE - smoothedMid);
    smoothedHigh += (highE > smoothedHigh ? 0.3 : 0.04) * (highE - smoothedHigh);
    const bands = [smoothedLow, smoothedMid, smoothedHigh];

    // Mid-band spectral flatness (geom/arith mean, 0 = tonal, 1 = noise)
    let logSum = 0;
    let linSum = 0;
    for (let j = lowEnd; j < midEnd; j++) {
      const v = freqDomain[j]! / 255 + 1e-10;
      logSum += Math.log(v);
      linSum += v;
    }
    const flatBins = midEnd - lowEnd;
    const rawFlatness = linSum > 1e-8 ? Math.exp(logSum / flatBins) / (linSum / flatBins) : 0;
    smoothedFlatness += 0.08 * (rawFlatness - smoothedFlatness);

    // Gate: only energy above the noise floor drives creature response
    const gatedRms = Math.max(0, smoothedRms - noiseFloor);
    const gate = smoothedRms > 0.001 ? gatedRms / smoothedRms : 0;

    // Shape: flatness controls response quality
    const flat2 = smoothedFlatness * smoothedFlatness;
    const damping = Math.max(0.15, 1 - flat2 * 0.9);
    const shimmer = 1 + (1 - smoothedFlatness) * 0.6;

    // The body feels pressure waves — gated and shaped by surface tension
    app.setAudioReactivity({
      rms: gatedRms * damping,
      low: smoothedLow * gate * damping,
      mid: smoothedMid * gate * damping,
      high: smoothedHigh * gate * damping * shimmer,
    });

    // Auto end-of-speech: detect sustained silence → stop recording, return to ambient
    if (gatedRms > 0.03) {
      speechActiveInVoice = true;
      silenceOnsetTime = 0;
    } else if (speechActiveInVoice && gatedRms < SPEECH_RMS_THRESHOLD) {
      if (silenceOnsetTime === 0) {
        silenceOnsetTime = performance.now();
      } else if (performance.now() - silenceOnsetTime > SILENCE_DURATION_MS) {
        // Sustained silence after speech — auto-stop
        speechActiveInVoice = false;
        silenceOnsetTime = 0;
        stopVoice(true, true); // process transcript, return to ambient
        return; // exit waveform loop
      }
    }

    const pad = 24 * dpr;
    const drawW = w - pad * 2;
    const midY = h / 2;

    const voiceGain = Math.min(smoothedRms * 10, 1.8);
    const amplitude = h * (0.22 + voiceGain * 0.18);
    const sampleDecay = 0.08 + voiceGain * 0.15;

    for (let i = 0; i < N; i++) {
      const bufIdx = Math.floor((i / N) * timeDomain.length);
      const raw = (timeDomain[bufIdx]! / 128.0) - 1.0;
      const target = raw * (1 + voiceGain * 5);
      waveformSmoothed[i] = waveformSmoothed[i]! + (target - waveformSmoothed[i]!) * sampleDecay;
    }

    const { r: cr, g: cg, b: cb } = waveformColor;

    ctx2d.lineCap = "round";
    ctx2d.lineJoin = "round";
    const stepX = drawW / (N - 1);

    const spread = voiceGain * 0.7;

    for (const wave of waves) {
      const bandVal = bands[wave.band] ?? 0;
      const bandBoost = 1 + bandVal * 3.5;

      for (let i = 0; i < N; i++) {
        const pos = i / (N - 1);
        const a = att(pos);

        const organic =
          Math.sin(t * wave.tf + pos * wave.sf) * wave.amp +
          Math.sin(t * wave.tf * 1.73 + pos * wave.sf * 1.61) * wave.amp * 0.5;

        const val = (waveformSmoothed[i]! + organic * (0.5 + spread)) * bandBoost * a;
        waveY[i] = midY + val * amplitude;
      }

      ctx2d.beginPath();
      ctx2d.moveTo(pad, waveY[0]!);
      for (let i = 1; i < N - 1; i++) {
        const x = pad + i * stepX;
        const nx = pad + (i + 1) * stepX;
        ctx2d.quadraticCurveTo(x, waveY[i]!, (x + nx) / 2, (waveY[i]! + waveY[i + 1]!) / 2);
      }
      ctx2d.lineTo(pad + drawW, waveY[N - 1]!);

      ctx2d.strokeStyle = `rgba(${cr},${cg},${cb},${wave.alpha})`;
      ctx2d.lineWidth = wave.lw * dpr;
      ctx2d.stroke();
    }

    waveformAnimationId = requestAnimationFrame(draw);
  };

  waveformAnimationId = requestAnimationFrame(draw);
}

// === MCP Server List ===

function renderMcpServerList(): void {
  mcpServerList.innerHTML = "";
  const servers = app.getMcpStatus();
  if (mcpServersConfig.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:12px;color:rgba(255,255,255,0.3);padding:8px 0;";
    empty.textContent = "No MCP servers configured";
    mcpServerList.appendChild(empty);
    return;
  }
  for (const config of mcpServersConfig) {
    const status = servers.find(s => s.name === config.name);
    const row = document.createElement("div");
    row.className = "mcp-server-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "mcp-server-name";
    nameSpan.textContent = config.name;
    row.appendChild(nameSpan);

    const transportBadge = document.createElement("span");
    transportBadge.className = "mcp-badge";
    transportBadge.textContent = config.transport;
    row.appendChild(transportBadge);

    if (config.trusted) {
      const trustedBadge = document.createElement("span");
      trustedBadge.className = "mcp-badge trusted";
      trustedBadge.textContent = "trusted";
      row.appendChild(trustedBadge);
    }

    const statusDot = document.createElement("span");
    statusDot.className = "mcp-status-dot" + (status?.connected ? " connected" : "");
    row.appendChild(statusDot);

    const removeBtn = document.createElement("button");
    removeBtn.className = "mcp-remove-btn";
    removeBtn.textContent = "\u00d7";
    removeBtn.addEventListener("click", () => {
      mcpServersConfig = mcpServersConfig.filter(s => s.name !== config.name);
      void app.removeMcpServer(config.name);
      renderMcpServerList();
    });
    row.appendChild(removeBtn);
    mcpServerList.appendChild(row);
  }
}

// MCP add form
const mcpAddToggle = document.getElementById("mcp-add-toggle") as HTMLButtonElement;
const mcpAddForm = document.getElementById("mcp-add-form") as HTMLDivElement;
const mcpTransport = document.getElementById("mcp-transport") as HTMLSelectElement;
const mcpCommandField = document.getElementById("mcp-command-field") as HTMLDivElement;
const mcpUrlField = document.getElementById("mcp-url-field") as HTMLDivElement;

mcpAddToggle.addEventListener("click", () => {
  mcpAddForm.style.display = mcpAddForm.style.display === "none" ? "block" : "none";
});

mcpTransport.addEventListener("change", () => {
  mcpCommandField.style.display = mcpTransport.value === "stdio" ? "flex" : "none";
  mcpUrlField.style.display = mcpTransport.value === "http" ? "flex" : "none";
});

document.getElementById("mcp-add-cancel")!.addEventListener("click", () => {
  mcpAddForm.style.display = "none";
});

document.getElementById("mcp-add-confirm")!.addEventListener("click", () => {
  const name = (document.getElementById("mcp-name") as HTMLInputElement).value.trim();
  if (!name) return;
  const transport = mcpTransport.value as "stdio" | "http";
  const command = (document.getElementById("mcp-command") as HTMLInputElement).value.trim();
  const url = (document.getElementById("mcp-url") as HTMLInputElement).value.trim();
  const trusted = (document.getElementById("mcp-trusted") as HTMLInputElement).checked;

  const config: McpServerConfig = { name, transport, trusted };
  if (transport === "stdio" && command) {
    const parts = command.split(/\s+/);
    config.command = parts[0];
    config.args = parts.slice(1);
  } else if (transport === "http" && url) {
    config.url = url;
  }

  mcpServersConfig.push(config);
  renderMcpServerList();
  mcpAddForm.style.display = "none";
  (document.getElementById("mcp-name") as HTMLInputElement).value = "";
  (document.getElementById("mcp-command") as HTMLInputElement).value = "";
  (document.getElementById("mcp-url") as HTMLInputElement).value = "";
  (document.getElementById("mcp-trusted") as HTMLInputElement).checked = false;
});

// === Approval Presets ===

const APPROVAL_PRESET_CONFIGS: Record<string, Partial<PolicyConfig>> = {
  cautious: { maxRiskLevel: 3, requireApprovalAbove: 0, denyAbove: 3 },
  balanced: { maxRiskLevel: 3, requireApprovalAbove: 1, denyAbove: 3 },
  autonomous: { maxRiskLevel: 4, requireApprovalAbove: 3, denyAbove: 4 },
};

function selectApprovalPreset(preset: string): void {
  selectedApprovalPreset = preset;
  document.querySelectorAll(".preset-option").forEach(el => {
    const match = (el as HTMLElement).dataset.preset === preset;
    el.classList.toggle("selected", match);
    const radio = el.querySelector("input[type=radio]") as HTMLInputElement;
    if (radio) radio.checked = match;
  });
}

document.querySelectorAll(".preset-option").forEach(el => {
  el.addEventListener("click", () => {
    const preset = (el as HTMLElement).dataset.preset;
    if (preset) selectApprovalPreset(preset);
  });
});

// Persistence threshold live display
persistenceThreshold.addEventListener("input", () => {
  persistenceThresholdValue.textContent = parseFloat(persistenceThreshold.value).toFixed(2);
});

// === Identity Tab ===

function populateIdentityTab(): void {
  const info = app.getIdentityInfo();
  (document.getElementById("identity-motebit-id") as HTMLElement).textContent = info.motebitId || "-";
  (document.getElementById("identity-device-id") as HTMLElement).textContent = info.deviceId || "-";
  (document.getElementById("identity-public-key") as HTMLElement).textContent =
    info.publicKey ? info.publicKey.slice(0, 16) + "..." : "-";
  const syncBadge = document.getElementById("identity-sync-status") as HTMLElement;
  syncBadge.className = "sync-badge disconnected";
  syncBadge.textContent = "Not connected";
}

// Copy buttons
document.querySelectorAll(".copy-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const targetId = (btn as HTMLElement).dataset.copy;
    if (!targetId) return;
    const el = document.getElementById(targetId);
    if (el) {
      void navigator.clipboard.writeText(el.textContent || "").then(() => {
        const prev = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = prev; }, 1500);
      });
    }
  });
});

// Export button
document.getElementById("settings-export")!.addEventListener("click", () => {
  void app.exportAllData().then(json => {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `motebit-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

// Documentation button
document.getElementById("settings-docs")!.addEventListener("click", () => {
  window.open("https://docs.motebit.dev", "_blank");
});

// === Pairing Dialog ===

const pairingBackdrop = document.getElementById("pairing-backdrop") as HTMLDivElement;
const pairingTitle = document.getElementById("pairing-title") as HTMLDivElement;
const pairingCodeDisplay = document.getElementById("pairing-code-display") as HTMLDivElement;
const pairingInputRow = document.getElementById("pairing-input-row") as HTMLDivElement;
const pairingCodeInput = document.getElementById("pairing-code-input") as HTMLInputElement;
const pairingClaimInfo = document.getElementById("pairing-claim-info") as HTMLDivElement;
const pairingStatus = document.getElementById("pairing-status") as HTMLDivElement;
const pairingActions = document.getElementById("pairing-actions") as HTMLDivElement;

let pairingPollTimer: ReturnType<typeof setInterval> | null = null;

function closePairingDialog(): void {
  pairingBackdrop.classList.remove("open");
  if (pairingPollTimer) {
    clearInterval(pairingPollTimer);
    pairingPollTimer = null;
  }
}

function resetPairingDialog(): void {
  pairingCodeDisplay.style.display = "none";
  pairingCodeDisplay.textContent = "";
  pairingInputRow.style.display = "none";
  pairingCodeInput.value = "";
  pairingClaimInfo.style.display = "none";
  pairingClaimInfo.textContent = "";
  pairingStatus.textContent = "";
  pairingActions.innerHTML = '<button class="pairing-btn-cancel" id="pairing-cancel">Cancel</button>';
  document.getElementById("pairing-cancel")!.addEventListener("click", closePairingDialog);
}

// Device A: "Link Another Device" from settings
document.getElementById("settings-link-device")!.addEventListener("click", () => {
  if (!currentConfig?.isTauri || !currentConfig?.invoke) {
    addMessage("system", "Pairing requires Tauri (not available in dev mode)");
    return;
  }
  const syncUrl = currentConfig.syncUrl;
  if (!syncUrl) {
    addMessage("system", "No sync relay configured — set sync_url in config");
    return;
  }

  closeSettings();
  resetPairingDialog();
  pairingTitle.textContent = "Link Another Device";
  pairingStatus.textContent = "Generating code...";
  pairingBackdrop.classList.add("open");

  const invoke = currentConfig.invoke;

  void (async () => {
    try {
      const { pairingCode, pairingId } = await app.initiatePairing(invoke, syncUrl);


      pairingCodeDisplay.textContent = pairingCode;
      pairingCodeDisplay.style.display = "block";
      pairingStatus.textContent = "Enter this code on the other device";

      // Poll for claim every 2s
      pairingPollTimer = setInterval(() => {
        void pollForClaim(invoke, syncUrl, pairingId);
      }, 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      pairingStatus.textContent = `Error: ${msg}`;
    }
  })();
});

async function pollForClaim(invoke: InvokeFn, syncUrl: string, pairingId: string): Promise<void> {
  try {
    const session: PairingSession = await app.getPairingSession(invoke, syncUrl, pairingId);

    if (session.status === "claimed") {
      // Stop polling, show approve/deny
      if (pairingPollTimer) {
        clearInterval(pairingPollTimer);
        pairingPollTimer = null;
      }

      pairingCodeDisplay.style.display = "none";
      pairingClaimInfo.style.display = "block";
      pairingClaimInfo.textContent = `"${session.claiming_device_name}" wants to join`;
      pairingStatus.textContent = "";

      pairingActions.innerHTML = "";
      const denyBtn = document.createElement("button");
      denyBtn.className = "pairing-btn-deny";
      denyBtn.textContent = "Deny";
      denyBtn.addEventListener("click", () => {
        void (async () => {
          try {
            await app.denyPairing(invoke, syncUrl, pairingId);
            closePairingDialog();
            addMessage("system", "Pairing denied");
          } catch (err: unknown) {
            pairingStatus.textContent = err instanceof Error ? err.message : String(err);
          }
        })();
      });

      const approveBtn = document.createElement("button");
      approveBtn.className = "pairing-btn-approve";
      approveBtn.textContent = "Approve";
      approveBtn.addEventListener("click", () => {
        void (async () => {
          try {
            approveBtn.disabled = true;
            denyBtn.disabled = true;
            pairingStatus.textContent = "Approving...";
            const result = await app.approvePairing(invoke, syncUrl, pairingId);
            closePairingDialog();
            addMessage("system", `Device linked (${result.deviceId.slice(0, 8)}...)`);
          } catch (err: unknown) {
            pairingStatus.textContent = err instanceof Error ? err.message : String(err);
            approveBtn.disabled = false;
            denyBtn.disabled = false;
          }
        })();
      });

      pairingActions.appendChild(denyBtn);
      pairingActions.appendChild(approveBtn);
    }
  } catch {
    // Polling errors are non-fatal
  }
}

// Device B: "I have an existing motebit" from welcome
function startPairingClaim(invoke: InvokeFn, syncUrl: string): void {
  resetPairingDialog();
  pairingTitle.textContent = "Link Existing Motebit";
  pairingInputRow.style.display = "block";
  pairingStatus.textContent = "Enter the code from your other device";

  const submitBtn = document.createElement("button");
  submitBtn.className = "pairing-btn-approve";
  submitBtn.textContent = "Submit";

  pairingActions.innerHTML = "";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "pairing-btn-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closePairingDialog);

  submitBtn.addEventListener("click", () => {
    const code = pairingCodeInput.value.trim().toUpperCase();
    if (code.length !== 6) {
      pairingStatus.textContent = "Code must be 6 characters";
      return;
    }
    void handlePairingClaim(invoke, syncUrl, code);
  });

  pairingCodeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitBtn.click();
  });

  pairingActions.appendChild(cancelBtn);
  pairingActions.appendChild(submitBtn);
  pairingBackdrop.classList.add("open");
  pairingCodeInput.focus();
}

async function handlePairingClaim(invoke: InvokeFn, syncUrl: string, code: string): Promise<void> {
  pairingStatus.textContent = "Claiming...";
  pairingInputRow.style.display = "none";

  try {
    const { pairingId } = await app.claimPairing(syncUrl, code);
    pairingStatus.textContent = "Waiting for approval...";

    // Remove submit button, keep only cancel
    pairingActions.innerHTML = "";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "pairing-btn-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", closePairingDialog);
    pairingActions.appendChild(cancelBtn);

    // Poll for approval every 2s
    pairingPollTimer = setInterval(() => {
      void (async () => {
        try {
          const status = await app.pollPairingStatus(syncUrl, pairingId);
          if (status.status === "approved" && status.device_id && status.motebit_id) {
            if (pairingPollTimer) {
              clearInterval(pairingPollTimer);
              pairingPollTimer = null;
            }
            await app.completePairing(invoke, {
              motebitId: status.motebit_id,
              deviceId: status.device_id,
              deviceToken: status.device_token || "",
            });
            closePairingDialog();
            // Close welcome if still open
            const welcomeBackdrop = document.getElementById("welcome-backdrop") as HTMLDivElement;
            welcomeBackdrop.classList.remove("open");
            addMessage("system", "Linked to existing motebit");
          } else if (status.status === "denied") {
            if (pairingPollTimer) {
              clearInterval(pairingPollTimer);
              pairingPollTimer = null;
            }
            pairingStatus.textContent = "Pairing was denied by the other device";
          }
        } catch {
          // Polling errors are non-fatal
        }
      })();
    }, 2000);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    pairingStatus.textContent = `Error: ${msg}`;
    pairingInputRow.style.display = "block";
  }
}

document.getElementById("pairing-cancel")!.addEventListener("click", closePairingDialog);

// === Settings Open / Close ===

function openSettings(): void {
  // Intelligence tab: populate from current config
  if (currentConfig) {
    settingsProvider.value = currentConfig.provider;
    settingsModel.value = currentConfig.model || "";
  }
  // API key: never rehydrate into DOM
  settingsApiKey.value = "";
  settingsApiKey.type = "password";
  settingsApiKeyToggle.textContent = "Show";
  settingsApiKey.placeholder = hasApiKeyInKeyring ? "API key stored" : "sk-ant-...";

  // Operator mode
  settingsOperatorMode.checked = app.isOperatorMode;

  // Voice settings
  settingsWhisperApiKey.value = "";
  settingsWhisperApiKey.type = "password";
  settingsWhisperApiKeyToggle.textContent = "Show";
  settingsWhisperApiKey.placeholder = hasWhisperKeyInKeyring ? "API key stored" : "sk-...";
  settingsVoiceAutoSend.checked = voiceAutoSend;
  settingsVoiceResponse.checked = voiceResponseEnabled;
  settingsTtsVoice.value = ttsVoice;

  // Appearance: track previous for cancel
  previousColorPreset = selectedColorPreset;
  buildColorSwatches();

  // MCP
  renderMcpServerList();

  // Governance
  selectApprovalPreset(selectedApprovalPreset);

  // Start on first tab
  switchTab("appearance");

  settingsBackdrop.classList.add("open");
  settingsModal.classList.add("open");
}

function closeSettings(): void {
  settingsBackdrop.classList.remove("open");
  settingsModal.classList.remove("open");
}

function cancelSettings(): void {
  // Restore previous color on cancel
  if (selectedColorPreset !== previousColorPreset) {
    selectedColorPreset = previousColorPreset;
    app.setInteriorColor(previousColorPreset);
  }
  closeSettings();
}

// === Save Settings ===

async function saveSettings(): Promise<void> {
  const provider = settingsProvider.value as DesktopAIConfig["provider"];
  const model = settingsModel.value.trim() || undefined;
  const apiKey = settingsApiKey.value.trim() || undefined;
  const whisperApiKey = settingsWhisperApiKey.value.trim() || undefined;
  const isTauri = typeof window !== "undefined" && !!window.__TAURI__;

  // Apply voice settings immediately
  voiceAutoSend = settingsVoiceAutoSend.checked;
  voiceResponseEnabled = settingsVoiceResponse.checked;
  ttsVoice = settingsTtsVoice.value;

  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");

    // Build config object with all settings
    const configData: Record<string, unknown> = {
      default_provider: provider,
      interior_color_preset: selectedColorPreset,
      approval_preset: selectedApprovalPreset,
      mcp_servers: mcpServersConfig,
      memory_governance: {
        persistence_threshold: parseFloat(persistenceThreshold.value),
        reject_secrets: rejectSecrets.checked,
      },
      budget: {
        maxCallsPerTurn: parseInt(maxCalls.value, 10) || 10,
      },
      voice: {
        auto_send: voiceAutoSend,
        voice_response: voiceResponseEnabled,
        tts_voice: ttsVoice,
      },
    };
    if (model) configData.default_model = model;
    await invoke("write_config", { json: JSON.stringify(configData) });

    // API key goes to keyring exclusively
    if (apiKey) {
      await invoke("keyring_set", { key: "api_key", value: apiKey });
      hasApiKeyInKeyring = true;
    }

    // Whisper API key to keyring
    if (whisperApiKey) {
      await invoke("keyring_set", { key: "whisper_api_key", value: whisperApiKey });
      hasWhisperKeyInKeyring = true;
    }

    // Rebuild TTS chain with updated voice setting
    rebuildTtsProvider(invoke as InvokeFn);
  }

  // Apply governance settings
  const approvalConfig = APPROVAL_PRESET_CONFIGS[selectedApprovalPreset];
  if (approvalConfig) {
    app.updatePolicyConfig({
      ...approvalConfig,
      operatorMode: settingsOperatorMode.checked,
      budget: { maxCallsPerTurn: parseInt(maxCalls.value, 10) || 10 },
    });
  }
  app.updateMemoryGovernance({
    persistenceThreshold: parseFloat(persistenceThreshold.value),
    rejectSecrets: rejectSecrets.checked,
  });

  // Apply operator mode (with PIN flow if enabling)
  const wantsOperator = settingsOperatorMode.checked;
  if (wantsOperator && !app.isOperatorMode) {
    const result = await app.setOperatorMode(true);
    if (!result.success) {
      if (result.needsSetup) {
        showPinDialog("setup");
      } else {
        showPinDialog("verify");
      }
      pendingSettingsSave = { provider, model, apiKey, isTauri };
      return;
    }
  } else if (!wantsOperator && app.isOperatorMode) {
    await app.setOperatorMode(false);
  }

  await finishSaveSettings(provider, model, apiKey, isTauri);
}

interface PendingSave {
  provider: DesktopAIConfig["provider"];
  model?: string;
  apiKey?: string;
  isTauri: boolean;
}
let pendingSettingsSave: PendingSave | null = null;

async function finishSaveSettings(
  provider: DesktopAIConfig["provider"],
  model?: string,
  apiKey?: string,
  isTauri = false,
): Promise<void> {
  const newConfig: DesktopAIConfig = {
    provider,
    model,
    apiKey: apiKey || currentConfig?.apiKey,
    isTauri,
    invoke: currentConfig?.invoke,
  };
  currentConfig = newConfig;

  if (await app.initAI(newConfig)) {
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

  const result = await app.setOperatorMode(true, pin);
  if (!result.success) {
    pinError.textContent = result.error || "Failed to enable operator mode";
    return;
  }

  pinBackdrop.classList.remove("open");
  if (pendingSettingsSave) {
    const s = pendingSettingsSave;
    pendingSettingsSave = null;
    await finishSaveSettings(s.provider, s.model, s.apiKey, s.isTauri);
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
settingsBackdrop.addEventListener("click", cancelSettings);
document.getElementById("settings-btn")!.addEventListener("click", openSettings);
document.getElementById("settings-cancel")!.addEventListener("click", cancelSettings);
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
settingsWhisperApiKeyToggle.addEventListener("click", () => {
  if (settingsWhisperApiKey.type === "password") {
    settingsWhisperApiKey.type = "text";
    settingsWhisperApiKeyToggle.textContent = "Hide";
  } else {
    settingsWhisperApiKey.type = "password";
    settingsWhisperApiKeyToggle.textContent = "Show";
  }
});

// Escape key: cancel voice/ambient/speaking first, then close modals
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (micState === "voice") {
      if (sileroVad) { void sileroVad.destroy(); sileroVad = null; }
      stopVoice(false, false);  // cancel voice, release mic
    } else if (micState === "speaking") {
      cancelTTS();
      stopAmbient();     // fully stop (destroys Silero)
    } else if (micState === "transcribing") {
      if (sileroVad) { void sileroVad.destroy(); sileroVad = null; }
      micState = "off";
      voiceTranscript.textContent = "";
      voiceTranscript.style.display = "";
      inputBarWrapper.classList.remove("listening");
      micBtn.classList.remove("active", "ambient");
      releaseAudioResources();
      app.setAudioReactivity(null);
    } else if (micState === "ambient") {
      stopAmbient();     // stop ambient sensing (destroys Silero)
    } else if (pinBackdrop.classList.contains("open")) {
      closePinDialog();
    } else if (goalsPanel.classList.contains("open")) {
      closeGoalsPanel();
    } else if (memoryPanel.classList.contains("open")) {
      closeMemoryPanel();
    } else if (conversationsPanel.classList.contains("open")) {
      closeConversationsPanel();
    } else if (settingsModal.classList.contains("open")) {
      cancelSettings();
    }
  }
});

// === Bootstrap ===

async function bootstrap(): Promise<void> {
  await app.init(canvas);
  app.start();

  // Resize handler
  const onResize = (): void => {
    app.resize(window.innerWidth, window.innerHeight);
    if (micState === "voice") sizeWaveformCanvas();
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
      // First launch — wait for consent or link existing
      const action = await new Promise<"create" | "link">((resolve) => {
        document.getElementById("welcome-start")!.addEventListener("click", () => resolve("create"));
        document.getElementById("welcome-link-existing")!.addEventListener("click", () => resolve("link"));
      });

      if (action === "link") {
        // Need sync URL for pairing
        const linkSyncUrl = (parsed.sync_url as string) || "";
        if (!linkSyncUrl) {
          welcomeBackdrop.classList.remove("open");
          addMessage("system", "No sync relay configured — set sync_url in config to link devices");
          // Fall through to create identity
          try {
            const result = await app.bootstrap(invoke);
            if (result.isFirstLaunch) {
              addMessage("system", "Your mote has been created");
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            addMessage("system", `Identity bootstrap failed: ${msg}`);
          }
        } else {
          // Bootstrap to generate keypair, then start pairing claim
          try {
            await app.bootstrap(invoke);
          } catch {
            // Non-fatal — we just need the keypair
          }
          startPairingClaim(invoke, linkSyncUrl);
          // Don't close welcome backdrop yet — pairing dialog sits on top
          // The completePairing flow will close it
        }
      } else {
        welcomeBackdrop.classList.remove("open");

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
    }

    // Load persisted settings from config
    if (typeof parsed.interior_color_preset === "string" && COLOR_PRESETS[parsed.interior_color_preset]) {
      selectedColorPreset = parsed.interior_color_preset;
      app.setInteriorColor(selectedColorPreset);
    }
    if (typeof parsed.approval_preset === "string") {
      selectedApprovalPreset = parsed.approval_preset;
    }
    if (Array.isArray(parsed.mcp_servers)) {
      mcpServersConfig = parsed.mcp_servers as McpServerConfig[];
    }
    if (parsed.memory_governance && typeof parsed.memory_governance === "object") {
      const mg = parsed.memory_governance as Record<string, unknown>;
      if (typeof mg.persistence_threshold === "number") {
        persistenceThreshold.value = String(mg.persistence_threshold);
        persistenceThresholdValue.textContent = mg.persistence_threshold.toFixed(2);
      }
      if (typeof mg.reject_secrets === "boolean") {
        rejectSecrets.checked = mg.reject_secrets;
      }
    }
    if (parsed.budget && typeof parsed.budget === "object") {
      const b = parsed.budget as Record<string, unknown>;
      if (typeof b.maxCallsPerTurn === "number") {
        maxCalls.value = String(b.maxCallsPerTurn);
      }
    }

    // Voice settings
    if (parsed.voice && typeof parsed.voice === "object") {
      const v = parsed.voice as Record<string, unknown>;
      if (typeof v.auto_send === "boolean") voiceAutoSend = v.auto_send;
      if (typeof v.voice_response === "boolean") voiceResponseEnabled = v.voice_response;
      if (typeof v.tts_voice === "string") ttsVoice = v.tts_voice;
    }

    // Build TTS fallback chain: OpenAI TTS (via Tauri IPC) → Web Speech
    rebuildTtsProvider(invoke as InvokeFn);

    // Check if API keys exist in keyring (for placeholder display)
    try {
      const keyVal = await invoke<string | null>("keyring_get", { key: "api_key" });
      hasApiKeyInKeyring = !!keyVal;
    } catch {
      // Keyring unavailable
    }
    try {
      const whisperVal = await invoke<string | null>("keyring_get", { key: "whisper_api_key" });
      hasWhisperKeyInKeyring = !!whisperVal;
    } catch {
      // Keyring unavailable
    }
  } else {
    // Non-Tauri (dev mode) — no identity bootstrap
    welcomeBackdrop.classList.remove("open");
  }

  // AI init
  if (await app.initAI(config)) {
    const label = config.provider === "ollama" ? "Ollama" : "Anthropic";
    addMessage("system", `AI connected (${label})`);

    // Surface governance status
    const gov = app.governanceStatus;
    if (!gov.governed && gov.reason !== "dev mode") {
      addMessage("system", `Tools disabled — ${gov.reason}. The agent can chat but cannot act.`);
    }

    // Restore previous conversation messages on reopen
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
          const summary = event.summary ? `: ${event.summary.slice(0, 120)}` : "";
          addMessage("system", `Goal completed "${promptSnippet}"${summary}`);
        } else {
          const err = event.error ? `: ${event.error.slice(0, 80)}` : "";
          addMessage("system", `Goal failed "${promptSnippet}"${err}`);
        }
      });
      app.onGoalApproval((event: GoalApprovalEvent) => {
        const promptSnippet = event.goalPrompt.length > 50
          ? event.goalPrompt.slice(0, 50) + "..."
          : event.goalPrompt;
        addMessage("system", `Goal "${promptSnippet}" needs approval:`);
        showGoalApprovalCard(event);
      });
      app.startGoalScheduler(config.invoke);
    }

    // Connect MCP servers via Tauri IPC bridge
    if (config.isTauri && config.invoke) {
      const invoke = config.invoke;
      for (const mcpConfig of mcpServersConfig) {
        void app.connectMcpServerViaTauri(mcpConfig, invoke).catch(() => {
          // MCP connection failures are non-fatal
        });
      }
    }

    // Sync conversations alongside event sync (if relay configured)
    if (config.syncUrl) {
      void app.syncConversations(config.syncUrl, config.syncMasterToken).catch(() => {
        // Conversation sync failures are non-fatal at startup
      });
    }
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
      if (micState === "voice") {
        stopVoice(true, true);  // transfer transcript, enter ambient (auto-send handled by stopVoice)
        return; // stopVoice → finishVoiceTranscript handles send
      }
      void handleSend();
    }
  });

  // Voice input: always show mic button (Web Speech + Whisper fallback)
  micBtn.style.display = "flex";
  micBtn.addEventListener("click", toggleVoice);
  updateVoiceGlowColor();
}

bootstrap().catch((err: unknown) => {
  console.error("Motebit bootstrap failed:", err);
});
