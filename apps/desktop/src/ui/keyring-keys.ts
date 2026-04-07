// Desktop Keyring Keys — Single Source of Truth
//
// All keyring slot names live here so future vendors and features don't
// invent parallel naming conventions. Desktop keyring keys use underscore
// snake_case without any prefix (the OS keyring namespaces them by app).
//
// Per-vendor BYOK slots were introduced after the provider-mode refactor
// (2026-04-06). Before that, desktop used a single `api_key` slot shared by
// all BYOK vendors — switching providers silently overwrote the previous
// vendor's key. The legacy slot is retained for migration read-back; new
// writes go to the per-vendor slots below.

import type { DesktopProvider } from "../index";

// === Identity ===

/** Device-bound Ed25519 private key (hex). */
export const DEVICE_PRIVATE_KEY_SLOT = "device_private_key";

// === BYOK API keys (per-vendor) ===

/** Anthropic API key for BYOK chat provider. */
export const ANTHROPIC_API_KEY_SLOT = "anthropic_api_key";
/** OpenAI API key for BYOK chat provider. */
export const OPENAI_API_KEY_SLOT = "openai_api_key";
/** Google API key for BYOK chat provider (via OpenAI-compatible endpoint). */
export const GOOGLE_API_KEY_SLOT = "google_api_key";

// === Voice ===

/** OpenAI Whisper API key for voice transcription. */
export const WHISPER_API_KEY_SLOT = "whisper_api_key";

// === Sync ===

/** Master sync token for the configured relay. */
export const SYNC_MASTER_TOKEN_SLOT = "sync_master_token";

// === Legacy ===

/**
 * Single-slot BYOK key from before per-vendor slots existed. Read-only:
 * `loadDesktopConfig` falls back to this when the per-vendor slot is empty,
 * so existing installations continue to work. Do not write to this slot.
 */
export const LEGACY_API_KEY_SLOT = "api_key";

/**
 * Return the keyring slot name for the BYOK API key of a given provider,
 * or `null` if the provider doesn't use a BYOK key (ollama, proxy).
 */
export function byokKeyringKey(provider: DesktopProvider): string | null {
  switch (provider) {
    case "anthropic":
      return ANTHROPIC_API_KEY_SLOT;
    case "openai":
      return OPENAI_API_KEY_SLOT;
    case "google":
      return GOOGLE_API_KEY_SLOT;
    case "local-server":
    case "proxy":
      return null;
  }
}
