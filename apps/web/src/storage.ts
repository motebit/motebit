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
//                          motebit:device_public_key, motebit:mcp_servers.
//                          Defined in web-app.ts / main.ts.
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

import { type UnifiedProviderConfig } from "@motebit/sdk";

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
    const parsed = JSON.parse(raw) as UnifiedProviderConfig;
    // Fall through to defaults if stored value isn't a current UnifiedProviderConfig
    // (e.g. legacy pre-1.0 shape predating the three-mode architecture).
    if (parsed.mode === "on-device" || parsed.mode === "motebit-cloud" || parsed.mode === "byok") {
      return parsed;
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

// === Soul Color (Appearance) ===
//
// The authoritative `AppearanceConfig` shape lives in `@motebit/sdk`. Web
// persists it as-is; legacy localStorage blobs (with `preset` instead of
// `colorPreset`) are normalized on load via the canonical
// `migrateAppearanceConfig` helper.

import { migrateAppearanceConfig, type AppearanceConfig } from "@motebit/sdk";
export type { AppearanceConfig };

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

/** Canonical relay URL. Override via VITE_RELAY_URL. */
export const DEFAULT_RELAY_URL: string =
  (import.meta as unknown as Record<string, Record<string, string> | undefined>).env
    ?.VITE_RELAY_URL ?? "https://relay.motebit.com";

/** Normalize a user-entered relay URL: trim, prepend https:// if no scheme. */
export function normalizeRelayUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

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

// === Proactive Interior Config ===
//
// Mirrors `DesktopAIConfig.proactive`. Defaults to disabled — sovereign
// fail-closed posture matches the doctrine in
// `docs/doctrine/proactive-interior.md`.

export interface WebProactiveConfig {
  enabled: boolean;
  anchorOnchain: boolean;
}

const PROACTIVE_KEY = "motebit-proactive";

const DEFAULT_PROACTIVE_CONFIG: WebProactiveConfig = {
  enabled: false,
  anchorOnchain: false,
};

export function saveProactiveConfig(config: WebProactiveConfig): void {
  try {
    localStorage.setItem(PROACTIVE_KEY, JSON.stringify(config));
  } catch {
    // localStorage unavailable
  }
}

export function loadProactiveConfig(): WebProactiveConfig {
  try {
    const raw = localStorage.getItem(PROACTIVE_KEY);
    if (raw == null || raw === "") return { ...DEFAULT_PROACTIVE_CONFIG };
    const parsed = JSON.parse(raw) as Partial<WebProactiveConfig>;
    return { ...DEFAULT_PROACTIVE_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_PROACTIVE_CONFIG };
  }
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

// === TTS BYOK Keys ===
//
// Per-vendor voice API keys. Kept separate from VoiceConfig because the
// canonical VoiceConfig in @motebit/sdk crosses surfaces — secrets do not
// belong in its type surface. Browser storage is the best we can do without
// OS keyring; the secret never leaves this device.
//
// Voice section is dual-purpose by vendor: one ElevenLabs key powers TTS
// (premium voices) AND Scribe STT, one Deepgram key powers Speak TTS AND
// Nova streaming STT, one Inworld key powers Inworld TTS AND Inworld
// streaming STT. Storage reflects this — keys are namespaced by vendor,
// not by function.
//
// Storage namespace: `motebit-vendor-key-<vendor>`.
//
// Lazy migration: legacy keys lived under `motebit-tts-key-*` and
// `motebit-stt-key-*`. On read, if the unified key is absent but a legacy
// key exists, copy it to the unified slot and remove the legacy ones.
// Invisible to the user; no startup hook required.

/** Vendor identifiers for voice BYOK. Voice section's three majors. */
export type VendorKey = "elevenlabs" | "deepgram" | "inworld";

const VENDOR_KEY_PREFIX = "motebit-vendor-key-";
const LEGACY_TTS_KEY_PREFIX = "motebit-tts-key-";
const LEGACY_STT_KEY_PREFIX = "motebit-stt-key-";

export function getVendorKey(vendor: VendorKey): string | null {
  try {
    const unified = localStorage.getItem(VENDOR_KEY_PREFIX + vendor);
    if (unified != null && unified !== "") return unified;

    // Lazy migration from legacy prefixes. Check TTS prefix first
    // (ElevenLabs lived there), then STT prefix (Deepgram lived there).
    const legacyTts = localStorage.getItem(LEGACY_TTS_KEY_PREFIX + vendor);
    const legacyStt = localStorage.getItem(LEGACY_STT_KEY_PREFIX + vendor);
    const migrated = legacyTts ?? legacyStt;
    if (migrated != null && migrated !== "") {
      localStorage.setItem(VENDOR_KEY_PREFIX + vendor, migrated);
      // Remove legacy slots so we don't keep migrating on every read.
      localStorage.removeItem(LEGACY_TTS_KEY_PREFIX + vendor);
      localStorage.removeItem(LEGACY_STT_KEY_PREFIX + vendor);
      return migrated;
    }
    return null;
  } catch {
    return null;
  }
}

export function setVendorKey(vendor: VendorKey, key: string | null): void {
  try {
    if (key == null || key === "") {
      localStorage.removeItem(VENDOR_KEY_PREFIX + vendor);
      // Also clean up any legacy slots for the same vendor so the user's
      // "I cleared this key" intent is total.
      localStorage.removeItem(LEGACY_TTS_KEY_PREFIX + vendor);
      localStorage.removeItem(LEGACY_STT_KEY_PREFIX + vendor);
    } else {
      localStorage.setItem(VENDOR_KEY_PREFIX + vendor, key);
    }
  } catch {
    // localStorage unavailable
  }
}

// ---------------------------------------------------------------------------
// Legacy aliases — kept for callers that haven't migrated yet. Both read
// from and write to the unified `getVendorKey` / `setVendorKey` so behavior
// is consistent regardless of which API a caller uses. Will be removed
// once all surfaces have migrated.
// ---------------------------------------------------------------------------

/** @deprecated Use `VendorKey` and `getVendorKey` / `setVendorKey`. */
export type TTSVendorKey = VendorKey;

/** @deprecated Use `getVendorKey`. */
export function getTTSKey(vendor: TTSVendorKey): string | null {
  return getVendorKey(vendor);
}

/** @deprecated Use `setVendorKey`. */
export function setTTSKey(vendor: TTSVendorKey, key: string | null): void {
  setVendorKey(vendor, key);
}

/** @deprecated Use `VendorKey` and `getVendorKey` / `setVendorKey`. */
export type STTVendorKey = VendorKey;

/** @deprecated Use `getVendorKey`. */
export function getSTTKey(vendor: STTVendorKey): string | null {
  return getVendorKey(vendor);
}

/** @deprecated Use `setVendorKey`. */
export function setSTTKey(vendor: STTVendorKey, key: string | null): void {
  setVendorKey(vendor, key);
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
