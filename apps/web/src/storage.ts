// === Provider Config ===

export type ProviderType = "anthropic" | "openai" | "ollama" | "webllm";

export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

const PROVIDER_KEY = "motebit-provider";

export function saveProviderConfig(config: ProviderConfig): void {
  try {
    localStorage.setItem(PROVIDER_KEY, JSON.stringify(config));
  } catch {
    // localStorage unavailable
  }
}

export function loadProviderConfig(): ProviderConfig | null {
  try {
    const raw = localStorage.getItem(PROVIDER_KEY);
    if (raw) {
      return JSON.parse(raw) as ProviderConfig;
    }
  } catch {
    // localStorage unavailable or corrupt
  }
  return null;
}

export function clearProviderConfig(): void {
  try {
    localStorage.removeItem(PROVIDER_KEY);
  } catch {
    // localStorage unavailable
  }
}

// === Soul Color ===

export interface SoulColorConfig {
  preset: string;
  customHue?: number;
  customSaturation?: number;
}

const SOUL_COLOR_KEY = "motebit-soul-color";

export function saveSoulColor(config: SoulColorConfig): void {
  try {
    localStorage.setItem(SOUL_COLOR_KEY, JSON.stringify(config));
  } catch {
    // localStorage unavailable
  }
}

export function loadSoulColor(): SoulColorConfig | null {
  try {
    const raw = localStorage.getItem(SOUL_COLOR_KEY);
    if (raw) {
      return JSON.parse(raw) as SoulColorConfig;
    }
  } catch {
    // localStorage unavailable or corrupt
  }
  return null;
}

// === Conversation ===

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

const CONVERSATION_KEY = "motebit-conversation";

export function saveConversation(messages: ConversationMessage[]): void {
  try {
    localStorage.setItem(CONVERSATION_KEY, JSON.stringify(messages));
  } catch {
    // localStorage unavailable
  }
}

export function loadConversation(): ConversationMessage[] {
  try {
    const raw = localStorage.getItem(CONVERSATION_KEY);
    if (raw) {
      return JSON.parse(raw) as ConversationMessage[];
    }
  } catch {
    // localStorage unavailable or corrupt
  }
  return [];
}

export function clearConversation(): void {
  try {
    localStorage.removeItem(CONVERSATION_KEY);
  } catch {
    // localStorage unavailable
  }
}

// === Multi-Conversation ===

export interface ConversationEntry {
  id: string;
  title: string;
  lastActiveAt: number;
  messageCount: number;
}

const CONV_INDEX_KEY = "motebit-conv-index";
const CONV_ACTIVE_KEY = "motebit-conv-active";
const CONV_PREFIX = "motebit-conv-";

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function loadConversationIndex(): ConversationEntry[] {
  try {
    const raw = localStorage.getItem(CONV_INDEX_KEY);
    if (raw) return JSON.parse(raw) as ConversationEntry[];
  } catch { /* ignore */ }
  return [];
}

function saveConversationIndex(index: ConversationEntry[]): void {
  try {
    localStorage.setItem(CONV_INDEX_KEY, JSON.stringify(index));
  } catch { /* ignore */ }
}

export function getActiveConversationId(): string | null {
  try {
    return localStorage.getItem(CONV_ACTIVE_KEY);
  } catch { /* ignore */ }
  return null;
}

export function setActiveConversationId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem(CONV_ACTIVE_KEY, id);
    } else {
      localStorage.removeItem(CONV_ACTIVE_KEY);
    }
  } catch { /* ignore */ }
}

export function loadConversationById(id: string): ConversationMessage[] {
  try {
    const raw = localStorage.getItem(CONV_PREFIX + id);
    if (raw) return JSON.parse(raw) as ConversationMessage[];
  } catch { /* ignore */ }
  return [];
}

export function saveConversationById(id: string, messages: ConversationMessage[]): void {
  try {
    localStorage.setItem(CONV_PREFIX + id, JSON.stringify(messages));
  } catch { /* ignore */ }

  // Update index entry
  const index = loadConversationIndex();
  const entry = index.find(e => e.id === id);
  const title = deriveTitle(messages);
  if (entry) {
    entry.lastActiveAt = Date.now();
    entry.messageCount = messages.filter(m => m.role !== "system").length;
    entry.title = title;
  } else {
    index.unshift({ id, title, lastActiveAt: Date.now(), messageCount: messages.filter(m => m.role !== "system").length });
  }
  // Sort by most recent
  index.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  saveConversationIndex(index);
}

export function deleteConversationById(id: string): void {
  try {
    localStorage.removeItem(CONV_PREFIX + id);
  } catch { /* ignore */ }
  const index = loadConversationIndex().filter(e => e.id !== id);
  saveConversationIndex(index);
}

export function ensureActiveConversation(): string {
  let activeId = getActiveConversationId();
  if (!activeId) {
    activeId = generateId();
    setActiveConversationId(activeId);
  }
  return activeId;
}

export function startNewConversation(): string {
  const id = generateId();
  setActiveConversationId(id);
  return id;
}

function deriveTitle(messages: ConversationMessage[]): string {
  const first = messages.find(m => m.role === "user");
  if (!first) return "New conversation";
  return first.content.length > 50 ? first.content.slice(0, 50) + "..." : first.content;
}

// === Sovereignty Ceiling CTA ===

const CEILING_KEY = "motebit-ceiling-shown";

export function hasCeilingBeenShown(): boolean {
  try {
    return sessionStorage.getItem(CEILING_KEY) === "1";
  } catch {
    return false;
  }
}

export function markCeilingShown(): void {
  try {
    sessionStorage.setItem(CEILING_KEY, "1");
  } catch {
    // sessionStorage unavailable
  }
}
