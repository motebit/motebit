// Mobile Storage Keys — Single Source of Truth
//
// The mobile app persists data across three storage backends with different
// purposes and different naming conventions. Each backend's keys are
// enumerated here so future vendors and settings additions stay consistent.
//
// Conventions (do not mix — each backend has its own style):
//
//   SecureStore  → "motebit_*"  underscore prefix, for encrypted secrets
//                  (API keys, device private keys, identity material)
//
//   AsyncStorage → "@motebit/*" slash prefix, for plain JSON settings
//                  and non-sensitive state (user prefs, caches, tokens)
//
//   Keyring      → "motebit_*"  underscore, routed through the Expo
//                  keyring adapter (cross-device identity bindings)
//
// Do NOT rename existing values — users have keys stored under these names.
// If you must rename, write a migration that copies old → new and leaves
// the old key untouched until the migration has been deployed for a release.

// === SecureStore (encrypted on-device secrets) ===

export const SECURE_STORE_KEYS = {
  /** Anthropic API key for BYOK chat provider. */
  anthropicApiKey: "motebit_anthropic_api_key",
  /**
   * OpenAI API key for Whisper voice transcription + TTS.
   * Kept distinct from `openaiChatKey` so the user can use OpenAI for voice
   * while running a different chat provider.
   */
  openaiVoiceKey: "motebit_openai_api_key",
  /**
   * ElevenLabs API key for BYOK TTS. The name deliberately uses the
   * `tts.<vendor>.apiKey` shape so future TTS vendors (Deepgram, Cartesia,
   * etc.) can land under the same convention without clashing with the
   * `motebit_*` slots that pre-date the BYOK-TTS split.
   */
  elevenLabsVoiceKey: "tts.elevenlabs.apiKey",
  /**
   * OpenAI API key for BYOK chat provider (distinct from voice key above).
   * Historical name: `motebit_openai_provider_key`.
   */
  openaiChatKey: "motebit_openai_provider_key",
  /** Google API key for BYOK chat provider (OpenAI-compatible endpoint). */
  googleApiKey: "motebit_google_api_key",
  /** Identity binding: motebit_id persisted from first launch. */
  motebitId: "motebit_motebit_id",
  /** Identity binding: device_id persisted from first launch. */
  deviceId: "motebit_device_id",
  /** Identity binding: device public key (hex). */
  devicePublicKey: "motebit_device_public_key",
} as const;

// === AsyncStorage (plain JSON settings + state) ===

export const ASYNC_STORAGE_KEYS = {
  /** Root MobileSettings blob (appearance, intelligence, governance, voice). */
  settings: "@motebit/settings",
  /** The motebit.md identity file contents when one has been issued. */
  identityFile: "@motebit/identity_file",
  /** Configured MCP servers (name, transport, URL/command). */
  mcpServers: "@motebit/mcp_servers",
  /** Cached proxy token for Motebit Cloud mode. */
  proxyToken: "@motebit/proxy_token",
  /**
   * User-configured motebit cloud relay base URL override.
   *
   * The canonical key is `@motebit/relay_url`. The historical name
   * `@motebit/proxy_url` is preserved as `legacyRelayUrl` and read as a
   * fallback during the migration window. Do not delete `legacyRelayUrl`
   * — installs upgrading from older releases still have data there.
   */
  relayUrl: "@motebit/relay_url",
  /** Legacy key for relay URL. Read-only fallback during migration. */
  legacyRelayUrl: "@motebit/proxy_url",
} as const;

// === Keyring (cross-device identity via expo keyring adapter) ===

export const KEYRING_KEYS = {
  /** Canonical motebit_id written through the keyring adapter. */
  motebitId: "motebit_id",
} as const;
