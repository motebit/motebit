/**
 * Canonical voice configuration shape.
 *
 * Every surface (web, mobile, desktop, spatial) has historically carried its
 * own voice config — with drifted field names (`voiceResponse` vs
 * `voiceResponseEnabled` vs `speakResponses`, `autoSend` vs `voiceAutoSend`)
 * and different subsets of the feature set. This module is the authoritative
 * vocabulary. Surfaces may keep UI-internal state in their own shapes, but
 * anything crossing the SDK boundary — sync, import/export, cross-surface
 * helpers — speaks `VoiceConfig`.
 *
 * Migration helpers are provided for the legacy shapes so each surface can
 * normalize on load without inventing its own migration one-offs.
 */

/**
 * The canonical voice configuration. Narrow, descriptive, surface-agnostic.
 *
 * - `enabled`: master on/off for the voice pipeline (VAD + STT + TTS).
 * - `autoSend`: after a transcription lands, auto-submit without a manual
 *   press. Off means the user edits/approves the transcript first.
 * - `speakResponses`: read agent replies aloud via the TTS backend.
 * - `ttsVoice`: opaque voice identifier — the specific string space depends
 *   on the TTS provider (OpenAI voices, platform voices, …).
 * - `neuralVad`: opt into ML-based VAD where the platform supports it
 *   (currently iOS via Silero). Absent/false uses the default RMS VAD.
 */
export interface VoiceConfig {
  enabled: boolean;
  autoSend: boolean;
  speakResponses: boolean;
  ttsVoice: string;
  neuralVad?: boolean;
}

/** Default voice config — voice off, sensible behavior when it's turned on. */
export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: false,
  autoSend: true,
  speakResponses: true,
  ttsVoice: "alloy",
  neuralVad: true,
};

/**
 * Normalize any of the historical surface-specific voice shapes onto the
 * canonical `VoiceConfig`. Unknown fields are ignored. Missing fields fall
 * back to `DEFAULT_VOICE_CONFIG`.
 *
 * Accepted legacy keys:
 *   - web:     `{ttsVoice, autoSend, voiceResponse}`
 *   - mobile:  `{voiceEnabled, voiceAutoSend, voiceResponseEnabled, neuralVadEnabled, ttsVoice}`
 *   - desktop: `{ttsVoice, voiceAutoSend, voiceResponseEnabled}`
 *   - spatial: `{voiceEnabled, ttsVoice}`
 *
 * The function is intentionally defensive — it operates on `unknown` because
 * the typical caller is reading from `localStorage` / `AsyncStorage` / a
 * Tauri JSON config, all of which return untyped blobs.
 */
export function migrateVoiceConfig(raw: unknown): VoiceConfig {
  if (raw == null || typeof raw !== "object") return { ...DEFAULT_VOICE_CONFIG };
  const obj = raw as Record<string, unknown>;

  const pick = <T>(keys: string[], isType: (v: unknown) => v is T): T | undefined => {
    for (const key of keys) {
      const v = obj[key];
      if (isType(v)) return v;
    }
    return undefined;
  };
  const isBool = (v: unknown): v is boolean => typeof v === "boolean";
  const isStr = (v: unknown): v is string => typeof v === "string";

  return {
    enabled: pick(["enabled", "voiceEnabled"], isBool) ?? DEFAULT_VOICE_CONFIG.enabled,
    autoSend: pick(["autoSend", "voiceAutoSend"], isBool) ?? DEFAULT_VOICE_CONFIG.autoSend,
    speakResponses:
      pick(["speakResponses", "voiceResponse", "voiceResponseEnabled"], isBool) ??
      DEFAULT_VOICE_CONFIG.speakResponses,
    ttsVoice: pick(["ttsVoice"], isStr) ?? DEFAULT_VOICE_CONFIG.ttsVoice,
    neuralVad: pick(["neuralVad", "neuralVadEnabled"], isBool),
  };
}
