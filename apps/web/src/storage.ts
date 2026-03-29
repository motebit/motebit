// === Provider Config ===

export type ProviderType = "anthropic" | "openai" | "ollama" | "webllm" | "proxy";

export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  /** Proxy auth token — injected as x-proxy-token header for authenticated proxy requests. */
  proxyToken?: string;
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

// === Sync Relay URL ===

const SYNC_URL_KEY = "motebit-sync-url";

export function saveSyncUrl(url: string): void {
  try {
    localStorage.setItem(SYNC_URL_KEY, url);
  } catch {
    // localStorage unavailable
  }
}

export function loadSyncUrl(): string | null {
  try {
    return localStorage.getItem(SYNC_URL_KEY);
  } catch {
    return null;
  }
}

export function clearSyncUrl(): void {
  try {
    localStorage.removeItem(SYNC_URL_KEY);
  } catch {
    // localStorage unavailable
  }
}

// === Governance Config ===

export interface GovernanceConfig {
  approvalPreset: "cautious" | "balanced" | "autonomous";
  persistenceThreshold: number;
  rejectSecrets: boolean;
  maxCallsPerTurn: number;
}

const GOVERNANCE_KEY = "motebit-governance";

export function saveGovernanceConfig(config: GovernanceConfig): void {
  try {
    localStorage.setItem(GOVERNANCE_KEY, JSON.stringify(config));
  } catch {
    // localStorage unavailable
  }
}

export function loadGovernanceConfig(): GovernanceConfig | null {
  try {
    const raw = localStorage.getItem(GOVERNANCE_KEY);
    if (raw) {
      return JSON.parse(raw) as GovernanceConfig;
    }
  } catch {
    // localStorage unavailable or corrupt
  }
  return null;
}

// === Voice Config ===

export interface VoiceConfig {
  ttsVoice: string;
  autoSend: boolean;
  voiceResponse: boolean;
}

const VOICE_KEY = "motebit-voice";

export function saveVoiceConfig(config: VoiceConfig): void {
  try {
    localStorage.setItem(VOICE_KEY, JSON.stringify(config));
  } catch {
    // localStorage unavailable
  }
}

export function loadVoiceConfig(): VoiceConfig | null {
  try {
    const raw = localStorage.getItem(VOICE_KEY);
    if (raw) {
      return JSON.parse(raw) as VoiceConfig;
    }
  } catch {
    // localStorage unavailable or corrupt
  }
  return null;
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

// === Subscription / Proxy Token ===

const PROXY_TOKEN_KEY = "motebit-proxy-token";
const SUBSCRIPTION_TIER_KEY = "motebit-subscription-tier";

export interface ProxyTokenData {
  token: string; // The full signed token string
  tier: string; // "free" | "pro"
  expiresAt: number; // epoch ms
  motebitId: string; // for display
}

export function saveProxyToken(data: ProxyTokenData): void {
  try {
    localStorage.setItem(PROXY_TOKEN_KEY, JSON.stringify(data));
  } catch {
    // localStorage unavailable
  }
}

export function loadProxyToken(): ProxyTokenData | null {
  try {
    const raw = localStorage.getItem(PROXY_TOKEN_KEY);
    if (raw) {
      return JSON.parse(raw) as ProxyTokenData;
    }
  } catch {
    // localStorage unavailable or corrupt
  }
  return null;
}

export function clearProxyToken(): void {
  try {
    localStorage.removeItem(PROXY_TOKEN_KEY);
  } catch {
    // localStorage unavailable
  }
}

export function saveSubscriptionTier(tier: string): void {
  try {
    localStorage.setItem(SUBSCRIPTION_TIER_KEY, tier);
  } catch {
    // localStorage unavailable
  }
}

export function loadSubscriptionTier(): string {
  try {
    return localStorage.getItem(SUBSCRIPTION_TIER_KEY) ?? "free";
  } catch {
    return "free";
  }
}

// === Legacy Conversation Migration ===
// One-time migration from localStorage conversations to IDB.

interface LegacyConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

interface LegacyConversationEntry {
  id: string;
  title: string;
  lastActiveAt: number;
  messageCount: number;
}

const CONV_INDEX_KEY = "motebit-conv-index";
const CONV_PREFIX = "motebit-conv-";
const MIGRATION_DONE_KEY = "motebit-idb-migrated";

export function needsMigration(): boolean {
  try {
    if (localStorage.getItem(MIGRATION_DONE_KEY) === "1") return false;
    return localStorage.getItem(CONV_INDEX_KEY) != null;
  } catch {
    return false;
  }
}

export function loadLegacyConversations(): Array<{
  id: string;
  title: string;
  lastActiveAt: number;
  messages: LegacyConversationMessage[];
}> {
  const results: Array<{
    id: string;
    title: string;
    lastActiveAt: number;
    messages: LegacyConversationMessage[];
  }> = [];

  try {
    const raw = localStorage.getItem(CONV_INDEX_KEY);
    if (!raw) return results;

    const index = JSON.parse(raw) as LegacyConversationEntry[];
    for (const entry of index) {
      const msgRaw = localStorage.getItem(CONV_PREFIX + entry.id);
      if (msgRaw) {
        const messages = JSON.parse(msgRaw) as LegacyConversationMessage[];
        results.push({
          id: entry.id,
          title: entry.title,
          lastActiveAt: entry.lastActiveAt,
          messages,
        });
      }
    }
  } catch {
    // Corrupt data — skip migration
  }

  return results;
}

export function markMigrationDone(): void {
  try {
    localStorage.setItem(MIGRATION_DONE_KEY, "1");
  } catch {
    // ignore
  }
}
