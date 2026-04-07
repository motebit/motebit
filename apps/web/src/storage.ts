// === Storage Key Conventions ===
//
// The web app uses two intentional localStorage prefix namespaces. Do not mix
// them — pick the right one based on what the value represents. Renaming
// existing keys breaks saved user state, so only add new keys to the
// appropriate namespace.
//
//   "motebit-*"  (dash)  — User preferences and cached UI state.
//                          Examples: motebit-provider, motebit-soul-color,
//                          motebit-governance, motebit-voice, motebit-proxy-token,
//                          motebit-balance, motebit-conv-*.
//                          Defined below in this file (storage.ts).
//
//   "motebit:*"  (colon) — Identity and system-level state managed by WebApp.
//                          Examples: motebit:motebit_id, motebit:device_id,
//                          motebit:device_public_key, motebit:mcp_servers,
//                          motebit:goals. Defined in web-app.ts / main.ts.
//
// Rule of thumb: if a new key is a user preference a user would toggle in
// settings, it belongs in the dash namespace (this file). If it's cryptographic
// identity material or internal system state the runtime manages, it belongs
// in the colon namespace.
//
// === Provider Config ===
//
// Uses the three-mode architecture from @motebit/sdk:
//   - "on-device"   (webllm, local-server, future apple-fm/mlx)
//   - "motebit-cloud" (the product — proxy + subscription)
//   - "byok"        (user's own API key for anthropic/openai/google)
//
// `loadProviderConfig` transparently migrates old flat-union configs.

import {
  migrateLegacyProvider,
  type UnifiedProviderConfig,
  type LegacyProviderConfig,
} from "@motebit/sdk";

export type ProviderConfig = UnifiedProviderConfig;

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
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LegacyProviderConfig;
    return migrateLegacyProvider(parsed);
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

// === Soul Color (Appearance) ===
//
// The authoritative `AppearanceConfig` shape lives in `@motebit/sdk`. Web
// persists it as-is; legacy localStorage blobs (with `preset` instead of
// `colorPreset`) are normalized on load via the canonical
// `migrateAppearanceConfig` helper. The legacy type alias `SoulColorConfig`
// is kept as a re-export of `AppearanceConfig` for source-compat with any
// existing internal callers.

import { migrateAppearanceConfig, type AppearanceConfig } from "@motebit/sdk";
export type { AppearanceConfig };
/** @deprecated Use `AppearanceConfig` from `@motebit/sdk`. Kept as alias. */
export type SoulColorConfig = AppearanceConfig;

const SOUL_COLOR_KEY = "motebit-soul-color";

export function saveSoulColor(config: AppearanceConfig): void {
  try {
    localStorage.setItem(SOUL_COLOR_KEY, JSON.stringify(config));
  } catch {
    // localStorage unavailable
  }
}

export function loadSoulColor(): AppearanceConfig | null {
  try {
    const raw = localStorage.getItem(SOUL_COLOR_KEY);
    if (raw == null || raw === "") return null;
    return migrateAppearanceConfig(JSON.parse(raw));
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

import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from "@motebit/sdk";
export type { GovernanceConfig } from "@motebit/sdk";

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
    if (raw == null || raw === "") return null;
    const parsed = JSON.parse(raw) as Partial<GovernanceConfig>;
    // Fill in any fields missing from legacy blobs (e.g. older persisted
    // data written before `maxMemoriesPerTurn` was promoted to canonical).
    return { ...DEFAULT_GOVERNANCE_CONFIG, ...parsed };
  } catch {
    // localStorage unavailable or corrupt
  }
  return null;
}

// === Voice Config ===
//
// The authoritative `VoiceConfig` shape lives in `@motebit/sdk`. Web persists
// it as-is; legacy localStorage blobs (with `voiceResponse` instead of
// `speakResponses`, and no `enabled` field) are normalized on load via the
// canonical `migrateVoiceConfig` helper.

import { migrateVoiceConfig, type VoiceConfig } from "@motebit/sdk";
export type { VoiceConfig };

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
    if (raw == null || raw === "") return null;
    return migrateVoiceConfig(JSON.parse(raw));
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

// === Proxy Token / Balance ===

const PROXY_TOKEN_KEY = "motebit-proxy-token";
const BALANCE_KEY = "motebit-balance";

export interface ProxyTokenData {
  token: string; // The full signed token string
  balance: number; // micro-units
  balanceUsd: number; // dollars for display
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

export function saveBalance(balanceUsd: number): void {
  try {
    localStorage.setItem(BALANCE_KEY, String(balanceUsd));
  } catch {
    // localStorage unavailable
  }
}

export function loadBalance(): number {
  try {
    const raw = localStorage.getItem(BALANCE_KEY);
    return raw != null ? parseFloat(raw) : 0;
  } catch {
    return 0;
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
