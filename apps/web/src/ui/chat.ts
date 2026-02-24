import type { WebContext } from "../types";

// === DOM Refs ===

const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const toastContainer = document.getElementById("toast-container") as HTMLDivElement;

// === Toast State ===

let activeToast: HTMLElement | null = null;
let activeToastTimer: ReturnType<typeof setTimeout> | null = null;

// === Tool Status Tracking ===

const toolStatusElements = new Map<string, HTMLElement>();

// === Exported Functions ===

export function addMessage(role: "user" | "assistant" | "system", text: string): void {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
}

export function showToast(text: string, duration = 3000): void {
  if (activeToast) {
    activeToast.remove();
    if (activeToastTimer) clearTimeout(activeToastTimer);
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  toastContainer.appendChild(el);
  void el.offsetWidth;
  el.classList.add("show");
  activeToast = el;
  activeToastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
    if (activeToast === el) activeToast = null;
  }, duration);
}

export function showToolStatus(name: string): void {
  const el = document.createElement("div");
  el.className = "tool-status";
  el.textContent = `${name}...`;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  toolStatusElements.set(name, el);
}

export function completeToolStatus(name: string): void {
  const el = toolStatusElements.get(name);
  if (!el) return;
  el.textContent = `${name} done`;
  el.classList.add("done");
  setTimeout(() => {
    el.classList.add("fade-out");
    setTimeout(() => { el.remove(); toolStatusElements.delete(name); }, 500);
  }, 1000);
}

// === Chat Init ===

export interface ChatCallbacks {
  openSettings(): void;
}

export interface ChatAPI {
  handleSend(): Promise<void>;
}

export function initChat(ctx: WebContext, callbacks: ChatCallbacks): ChatAPI {
  async function handleSend(): Promise<void> {
    const text = chatInput.value.trim();
    if (!text || ctx.app.isProcessing) return;

    chatInput.value = "";

    // Handle /clear command
    if (text === "/clear") {
      ctx.app.resetConversation();
      chatLog.innerHTML = "";
      return;
    }

    // Handle /settings command
    if (text === "/settings") {
      callbacks.openSettings();
      return;
    }

    if (!ctx.app.isProviderConnected) {
      addMessage("system", "No provider connected. Open settings to configure one.");
      return;
    }

    addMessage("user", text);

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble assistant";
    const textEl = document.createElement("span");
    textEl.className = "bubble-text";
    bubble.appendChild(textEl);
    chatLog.appendChild(bubble);

    let accumulated = "";
    try {
      for await (const chunk of ctx.app.sendMessageStreaming(text)) {
        if (chunk.type === "text") {
          accumulated += chunk.text;
          textEl.textContent = accumulated;
          chatLog.scrollTop = chatLog.scrollHeight;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!textEl.textContent) {
        bubble.remove();
      }
      addMessage("system", `Error: ${msg}`);
    }
  }

  // Wire up Enter key
  chatInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  });

  return { handleSend };
}
