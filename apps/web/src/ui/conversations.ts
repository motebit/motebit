import type { WebContext } from "../types";
import { loadConversationIndex, deleteConversationById, loadConversationById } from "../storage";

// === DOM Refs ===

const conversationsPanel = document.getElementById("conversations-panel") as HTMLDivElement;
const conversationsBackdrop = document.getElementById("conversations-backdrop") as HTMLDivElement;
const convList = document.getElementById("conv-list") as HTMLDivElement;

// === Time Formatting ===

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

// === Conversations Panel ===

export interface ConversationsCallbacks {
  onLoad(): void;
}

export interface ConversationsAPI {
  open(): void;
  close(): void;
}

export function initConversations(ctx: WebContext, callbacks: ConversationsCallbacks): ConversationsAPI {
  function open(): void {
    conversationsPanel.classList.add("open");
    conversationsBackdrop.classList.add("open");
    populateList();
  }

  function close(): void {
    conversationsPanel.classList.remove("open");
    conversationsBackdrop.classList.remove("open");
  }

  function populateList(): void {
    convList.innerHTML = "";
    const index = loadConversationIndex();

    if (index.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "font-size:12px;color:var(--text-ghost);padding:16px;text-align:center;";
      empty.textContent = "No conversations yet";
      convList.appendChild(empty);
      return;
    }

    const activeId = ctx.app.activeConversationId;

    for (const entry of index) {
      const item = document.createElement("div");
      item.className = "conv-item" + (entry.id === activeId ? " active" : "");

      const titleDiv = document.createElement("div");
      titleDiv.className = "conv-item-title";
      titleDiv.textContent = entry.title || "New conversation";
      item.appendChild(titleDiv);

      const metaDiv = document.createElement("div");
      metaDiv.className = "conv-item-meta";

      const timeSpan = document.createElement("span");
      timeSpan.textContent = formatTimeAgo(entry.lastActiveAt);
      metaDiv.appendChild(timeSpan);

      const countSpan = document.createElement("span");
      countSpan.textContent = `${entry.messageCount} msgs`;
      metaDiv.appendChild(countSpan);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "conv-delete-btn";
      deleteBtn.textContent = "\u00d7";
      deleteBtn.title = "Delete conversation";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteConversationById(entry.id);
        // If deleting the active conversation, start fresh
        if (entry.id === ctx.app.activeConversationId) {
          ctx.app.resetConversation();
          callbacks.onLoad();
        }
        populateList();
      });
      metaDiv.appendChild(deleteBtn);

      item.appendChild(metaDiv);

      item.addEventListener("click", () => {
        ctx.app.loadConversationById(entry.id);
        close();
        callbacks.onLoad();
      });

      convList.appendChild(item);
    }
  }

  // === Event Listeners ===

  document.getElementById("conversations-btn")!.addEventListener("click", open);
  document.getElementById("conv-close-btn")!.addEventListener("click", close);
  conversationsBackdrop.addEventListener("click", close);

  document.getElementById("conv-new-btn")!.addEventListener("click", () => {
    close();
    ctx.app.resetConversation();
    callbacks.onLoad();
  });

  // === Export ===

  document.getElementById("conv-export-btn")!.addEventListener("click", () => {
    const activeId = ctx.app.activeConversationId;
    if (!activeId) return;
    const messages = loadConversationById(activeId);
    if (messages.length === 0) return;

    // Build markdown
    const lines: string[] = ["# Motebit Conversation", ""];
    for (const msg of messages) {
      if (msg.role === "system") continue;
      const label = msg.role === "user" ? "You" : "Motebit";
      const time = new Date(msg.timestamp).toLocaleString();
      lines.push(`**${label}** _(${time})_`);
      lines.push("");
      lines.push(msg.content);
      lines.push("");
    }

    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `motebit-conversation-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });

  return { open, close };
}
