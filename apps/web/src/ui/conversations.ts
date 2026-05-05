import type { WebContext } from "../types";

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

export function initConversations(
  ctx: WebContext,
  callbacks: ConversationsCallbacks,
): ConversationsAPI {
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
    const conversations = ctx.app.listConversations();

    if (conversations.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText =
        "font-size:12px;color:var(--text-ghost);padding:16px;text-align:center;";
      empty.textContent = "No conversations yet";
      convList.appendChild(empty);
      return;
    }

    const activeId = ctx.app.activeConversationId;

    for (const entry of conversations) {
      const item = document.createElement("div");
      item.className = "conv-item" + (entry.conversationId === activeId ? " active" : "");

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
      deleteBtn.title = "Delete conversation";
      deleteBtn.textContent = "\u00d7";
      let confirmTimer: ReturnType<typeof setTimeout> | null = null;
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (deleteBtn.classList.contains("confirming")) {
          // Second tap — delete. The privacy-layer choke point signs
          // a flush cert per message and lands a DeleteRequested event
          // before erasing; we kick off the async path and refresh the
          // list once it resolves so the UI never shows a half-deleted
          // conversation.
          if (confirmTimer != null) clearTimeout(confirmTimer);
          void ctx.app.deleteConversation(entry.conversationId).then(() => {
            if (entry.conversationId === activeId) {
              callbacks.onLoad();
            }
            populateList();
          });
        } else {
          // First tap — ask for confirmation
          deleteBtn.classList.add("confirming");
          deleteBtn.textContent = "Delete?";
          confirmTimer = setTimeout(() => {
            deleteBtn.classList.remove("confirming");
            deleteBtn.textContent = "\u00d7";
          }, 3000);
        }
      });
      metaDiv.appendChild(deleteBtn);

      item.appendChild(metaDiv);

      item.addEventListener("click", () => {
        void ctx.app
          .loadConversationById(entry.conversationId)
          .then(() => {
            close();
            callbacks.onLoad();
          })
          .catch((err: unknown) => {
            // A silent failure here manifests as "click does nothing" —
            // the exact symptom the user reported. Close the panel so
            // the surface returns to a known state, surface a toast so
            // the failure is visible (not buried in devtools), and log
            // the full detail for diagnosis.
            close();
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[conversations] load failed:", msg);
            ctx.showToast("Couldn't open that conversation — try again");
            callbacks.onLoad();
          });
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
    const history = ctx.app.getConversationHistory();
    if (history.length === 0) return;

    // Build markdown
    const lines: string[] = ["# Motebit Conversation", ""];
    for (const msg of history) {
      if (msg.role === "tool") continue;
      const label = msg.role === "user" ? "You" : "Motebit";
      lines.push(`**${label}**`);
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
