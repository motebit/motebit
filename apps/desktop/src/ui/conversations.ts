import type { DesktopContext } from "../types";
import { formatTimeAgo } from "../types";
import { addMessage } from "./chat";

// === DOM Refs ===

const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const conversationsPanel = document.getElementById("conversations-panel") as HTMLDivElement;
const conversationsBackdrop = document.getElementById("conversations-backdrop") as HTMLDivElement;
const convList = document.getElementById("conv-list") as HTMLDivElement;

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
    chatLog.innerHTML = "";

    try {
      const messages = await ctx.app.loadConversationById(conversationId);
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

  // Event listeners
  document.getElementById("conversations-btn")!.addEventListener("click", open);
  document.getElementById("conv-close-btn")!.addEventListener("click", close);
  conversationsBackdrop.addEventListener("click", close);
  document.getElementById("conv-new-btn")!.addEventListener("click", () => {
    close();
    ctx.app.startNewConversation();
    chatLog.innerHTML = "";
  });

  return { open, close };
}
