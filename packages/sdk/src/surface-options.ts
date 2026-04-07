/**
 * Shared option lists for surface settings UIs.
 *
 * These are the dropdown / radio / chip options every surface needs
 * to render the same choices the same way: the six OpenAI TTS voices,
 * and the three theme preferences.
 *
 * Previously each surface redeclared these inline. Now there's one
 * source — a new TTS voice added here shows up in every settings tab.
 *
 * The shapes are intentionally presentation-neutral: a key + label
 * pair. Each surface layers its own visual styling (chip vs radio vs
 * dropdown) on top. The key is what gets persisted; the label is what
 * the user sees.
 */

// === TTS voices ===

export interface TtsVoiceOption {
  key: string;
  label: string;
}

/**
 * OpenAI TTS voices. Reference: https://platform.openai.com/docs/guides/text-to-speech/voice-options
 *
 * These map 1:1 onto the `VoiceConfig.ttsVoice` field. Surfaces with
 * non-OpenAI TTS providers can supplement this list with their own
 * voice options, but the default catalogue lives here.
 */
export const TTS_VOICE_OPTIONS: TtsVoiceOption[] = [
  { key: "alloy", label: "Alloy" },
  { key: "echo", label: "Echo" },
  { key: "fable", label: "Fable" },
  { key: "onyx", label: "Onyx" },
  { key: "nova", label: "Nova" },
  { key: "shimmer", label: "Shimmer" },
];

// === Theme preferences ===

export type ThemePreference = "light" | "dark" | "system";

export interface ThemeOption {
  key: ThemePreference;
  label: string;
}

export const THEME_OPTIONS: ThemeOption[] = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "system", label: "System" },
];
