import type { MotebitState } from "@motebit/sdk";

// === Word lists ===

const POSITIVE_WORDS = [
  "happy",
  "glad",
  "wonderful",
  "love",
  "great",
  "excited",
  "joy",
  "amazing",
  "fantastic",
  "delighted",
  "cheerful",
  "thrilled",
];

const NEGATIVE_WORDS = [
  "sorry",
  "sad",
  "unfortunately",
  "difficult",
  "worry",
  "miss",
  "struggle",
  "afraid",
  "upset",
  "frustrated",
  "confused",
  "lost",
];

const HEDGING_WORDS = [
  "maybe",
  "perhaps",
  "might",
  "not sure",
  "i think",
  "possibly",
  "probably",
  "could be",
  "uncertain",
];

const DEFINITIVE_WORDS = [
  "certainly",
  "absolutely",
  "definitely",
  "clearly",
  "exactly",
  "without doubt",
  "of course",
];

// === Ranges (from policy-invariants) ===

const FIELD_RANGES: Record<string, [number, number]> = {
  attention: [0, 1],
  processing: [0, 1],
  confidence: [0, 1],
  affect_valence: [-1, 1],
  affect_arousal: [0, 0.35],
  social_distance: [0, 1],
  curiosity: [0, 1],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampField(field: string, value: number): number {
  const range = FIELD_RANGES[field];
  if (!range) return value;
  return clamp(value, range[0], range[1]);
}

// === Helpers ===

function wordBoundaryPattern(words: string[]): RegExp {
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "gi");
}

function hasMatch(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

// === Main inference ===

/**
 * Infer gentle state nudges from response text when the model doesn't emit
 * explicit `<state>` tags. Returns only the fields that should change.
 *
 * Nudges are ±0.1–0.2 relative to current state and clamped to valid ranges.
 * The caller feeds the result into the same EMA pipeline as explicit tags.
 */
export function inferStateFromText(
  text: string,
  currentState: MotebitState,
): Partial<MotebitState> {
  const updates: Partial<MotebitState> = {};

  // --- affect_valence ---
  const hasPositive = hasMatch(text, wordBoundaryPattern(POSITIVE_WORDS));
  const hasNegative = hasMatch(text, wordBoundaryPattern(NEGATIVE_WORDS));
  if (hasPositive && !hasNegative) {
    updates.affect_valence = clampField("affect_valence", currentState.affect_valence + 0.15);
  } else if (hasNegative && !hasPositive) {
    updates.affect_valence = clampField("affect_valence", currentState.affect_valence - 0.15);
  }

  // --- curiosity (question marks) ---
  const questionCount = (text.match(/\?/g) ?? []).length;
  if (questionCount > 0) {
    const nudge = Math.min(questionCount * 0.1, 0.2);
    updates.curiosity = clampField("curiosity", currentState.curiosity + nudge);
  }

  // --- attention (response length) ---
  if (text.length > 200) {
    updates.attention = clampField("attention", currentState.attention + 0.1);
  } else if (text.length < 50) {
    updates.attention = clampField("attention", currentState.attention - 0.1);
  }

  // --- confidence ---
  const hasHedging = hasMatch(text, wordBoundaryPattern(HEDGING_WORDS));
  const hasDefinitive = hasMatch(text, wordBoundaryPattern(DEFINITIVE_WORDS));
  if (hasHedging && !hasDefinitive) {
    updates.confidence = clampField("confidence", currentState.confidence - 0.1);
  } else if (hasDefinitive && !hasHedging) {
    updates.confidence = clampField("confidence", currentState.confidence + 0.1);
  }

  // --- social_distance (informal markers) ---
  const hasExclamation = text.includes("!");
  const hasEllipsis = text.includes("...");
  const hasEmoji = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(text);
  const informalCount = [hasExclamation, hasEllipsis, hasEmoji].filter(Boolean).length;
  if (informalCount > 0) {
    updates.social_distance = clampField(
      "social_distance",
      currentState.social_distance - 0.05 * informalCount,
    );
  }

  return updates;
}
