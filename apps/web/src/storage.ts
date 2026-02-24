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
