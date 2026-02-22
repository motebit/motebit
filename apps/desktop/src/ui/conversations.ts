import type { DesktopContext } from "../types";
import { formatTimeAgo } from "../types";
import { addMessage, showToast } from "./chat";

// === DOM Refs ===

const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const conversationsPanel = document.getElementById("conversations-panel") as HTMLDivElement;
const conversationsBackdrop = document.getElementById("conversations-backdrop") as HTMLDivElement;
const convList = document.getElementById("conv-list") as HTMLDivElement;
const exportBtn = document.getElementById("conv-export-btn") as HTMLButtonElement;
const exportMenu = document.getElementById("conv-export-menu") as HTMLDivElement;

// === Fade Helpers ===

/** Fade out all chat bubbles, then clear the log. Returns a promise that resolves when done. */
function fadeOutMessages(): Promise<void> {
  const bubbles = chatLog.querySelectorAll(".chat-bubble");
  if (bubbles.length === 0) {
    chatLog.innerHTML = "";
    return Promise.resolve();
  }

  // Stagger fade-out slightly for visual flow
  for (let i = 0; i < bubbles.length; i++) {
    const bubble = bubbles[i] as HTMLElement;
    bubble.style.transitionDelay = `${i * 20}ms`;
    bubble.classList.add("fade-out");
  }

  return new Promise((resolve) => {
    // Wait for the last bubble's transition to finish
    const duration = 200 + (bubbles.length - 1) * 20;
    setTimeout(() => {
      chatLog.innerHTML = "";
      resolve();
    }, duration);
  });
}

// === Download Helpers ===

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatDateForFilename(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function messagesToMarkdown(messages: Array<{ role: string; content: string }>, title?: string): string {
  const lines: string[] = [];
  if (title) {
    lines.push(`# ${title}`, "");
  }
  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "assistant") {
      const heading = msg.role === "user" ? "User" : "Assistant";
      lines.push(`## ${heading}`, "", msg.content, "");
    }
  }
  return lines.join("\n");
}

// === Conversations Panel ===

export interface ConversationsAPI {
  open(): void;
  close(): void;
}

export function initConversations(ctx: DesktopContext): ConversationsAPI {
  function open(): void {
    conversationsPanel.classList.add("open");
    conversationsBackdrop.classList.add("open");
    populateConversationsList();
  }

  function close(): void {
    conversationsPanel.classList.remove("open");
    conversationsBackdrop.classList.remove("open");
    exportMenu.classList.remove("open");
  }

  function populateConversationsList(): void {
    convList.innerHTML = "";
    void ctx.app.listConversationsAsync(30).then(conversations => {
      if (conversations.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "font-size:12px;color:rgba(0,0,0,0.3);padding:16px;text-align:center;";
        empty.textContent = "No conversations yet";
        convList.appendChild(empty);
        return;
      }

      const currentId = ctx.app.currentConversationId;
      for (const conv of conversations) {
        const item = document.createElement("div");
        item.className = "conv-item" + (conv.conversationId === currentId ? " active" : "");

        const titleDiv = document.createElement("div");
        titleDiv.className = "conv-item-title";
        titleDiv.textContent = conv.title || "Untitled conversation";
        item.appendChild(titleDiv);

        if (conv.summary) {
          const summaryDiv = document.createElement("div");
          summaryDiv.className = "conv-item-summary";
          summaryDiv.textContent = conv.summary.length > 120
            ? conv.summary.slice(0, 120) + "..."
            : conv.summary;
          item.appendChild(summaryDiv);
        }

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
    close();
    await fadeOutMessages();

    try {
      // Show summary at the top if one exists
      const summary = await ctx.app.getConversationSummary(conversationId);
      if (summary) {
        addMessage("system", `Summary: ${summary}`);
      }

      const messages = await ctx.app.loadConversationById(conversationId);
      for (const msg of messages) {
        if (msg.role === "user" || msg.role === "assistant") {
          addMessage(msg.role, msg.content);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addMessage("system", `Failed to load conversation: ${msg}`);
    }

    chatInput.focus();
  }

  // === Export Logic ===

  function exportCurrentJson(): void {
    const conversationId = ctx.app.currentConversationId;
    if (!conversationId) {
      showToast("No active conversation");
      return;
    }
    const messages = ctx.app.getConversationHistory();
    if (messages.length === 0) {
      showToast("No messages to export");
      return;
    }
    const date = formatDateForFilename();
    const data = {
      motebit_id: ctx.app.motebitId,
      conversation_id: conversationId,
      exported_at: new Date().toISOString(),
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
    };
    downloadFile(JSON.stringify(data, null, 2), `motebit-conversation-${conversationId.slice(0, 8)}-${date}.json`, "application/json");
    exportMenu.classList.remove("open");
  }

  function exportCurrentMarkdown(): void {
    const conversationId = ctx.app.currentConversationId;
    if (!conversationId) {
      showToast("No active conversation");
      return;
    }
    const messages = ctx.app.getConversationHistory();
    if (messages.length === 0) {
      showToast("No messages to export");
      return;
    }
    const date = formatDateForFilename();
    const md = messagesToMarkdown(messages);
    downloadFile(md, `motebit-conversation-${date}.md`, "text/markdown");
    exportMenu.classList.remove("open");
  }

  async function exportAllJson(): Promise<void> {
    try {
      const conversations = await ctx.app.listConversationsAsync(100);
      if (conversations.length === 0) {
        showToast("No conversations to export");
        return;
      }

      const allData: Array<{
        conversation_id: string;
        title: string | null;
        started_at: number;
        last_active_at: number;
        messages: Array<{ role: string; content: string }>;
      }> = [];

      for (const conv of conversations) {
        const messages = await ctx.app.loadConversationById(conv.conversationId);
        allData.push({
          conversation_id: conv.conversationId,
          title: conv.title,
          started_at: conv.startedAt,
          last_active_at: conv.lastActiveAt,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
        });
      }

      const date = formatDateForFilename();
      const data = {
        motebit_id: ctx.app.motebitId,
        exported_at: new Date().toISOString(),
        conversations: allData,
      };
      downloadFile(JSON.stringify(data, null, 2), `motebit-conversations-${date}.json`, "application/json");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Export failed: ${msg}`);
    }
    exportMenu.classList.remove("open");
  }

  async function exportAllMarkdown(): Promise<void> {
    try {
      const conversations = await ctx.app.listConversationsAsync(100);
      if (conversations.length === 0) {
        showToast("No conversations to export");
        return;
      }

      const sections: string[] = [];
      for (const conv of conversations) {
        const messages = await ctx.app.loadConversationById(conv.conversationId);
        const title = conv.title || "Untitled conversation";
        sections.push(messagesToMarkdown(messages, title));
      }

      const date = formatDateForFilename();
      const md = sections.join("\n---\n\n");
      downloadFile(md, `motebit-conversations-${date}.md`, "text/markdown");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Export failed: ${msg}`);
    }
    exportMenu.classList.remove("open");
  }

  // === Event Listeners ===

  document.getElementById("conversations-btn")!.addEventListener("click", open);
  document.getElementById("conv-close-btn")!.addEventListener("click", close);
  conversationsBackdrop.addEventListener("click", close);
  document.getElementById("conv-new-btn")!.addEventListener("click", () => {
    close();
    ctx.app.startNewConversation();
    void fadeOutMessages().then(() => {
      chatInput.focus();
    });
  });

  // Export menu toggle
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    exportMenu.classList.toggle("open");
  });

  // Close export menu on outside click
  document.addEventListener("click", (e) => {
    if (!exportMenu.contains(e.target as Node) && e.target !== exportBtn) {
      exportMenu.classList.remove("open");
    }
  });

  // Export handlers
  document.getElementById("conv-export-json")!.addEventListener("click", exportCurrentJson);
  document.getElementById("conv-export-md")!.addEventListener("click", exportCurrentMarkdown);
  document.getElementById("conv-export-all-json")!.addEventListener("click", () => { void exportAllJson(); });
  document.getElementById("conv-export-all-md")!.addEventListener("click", () => { void exportAllMarkdown(); });

  return { open, close };
}
