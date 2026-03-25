/**
 * Synthetic speech energy — organic speech-like reactivity from layered sinusoids.
 *
 * Layered noise at syllable, word, and breath rates produces irregular bursts
 * with pauses that mimic real speech energy, not a smooth cycle.
 *
 * Pure function, no side effects. Each surface maps the returned bands
 * to its own `setAudioReactivity` API.
 */
export interface SpeechEnergyBands {
  /** RMS-like overall energy (~25% of user voice intensity) */
  rms: number;
  /** Low-frequency band (breath/word envelope) */
  low: number;
  /** Mid-frequency band (word-level energy) */
  mid: number;
  /** High-frequency band (syllable transients) */
  high: number;
}

export function computeSpeechEnergy(timeSeconds: number): SpeechEnergyBands {
  const t = timeSeconds;
  const syllable = Math.max(0, Math.sin(t * 8.3) * Math.sin(t * 5.1)); // ~3-4 Hz bursts
  const word = Math.max(0, Math.sin(t * 2.7 + 0.5)) * 0.5 + 0.5; // word-level envelope
  const breath = Math.max(0, Math.sin(t * 0.8)) * 0.3 + 0.7; // slow breathing modulation
  const jitter = Math.sin(t * 31.7) * 0.02; // micro-variation
  const energy = (syllable * 0.5 + 0.05 + jitter) * word * breath;
  const rms = energy * 0.25;
  return {
    rms,
    low: rms * 1.2,
    mid: energy * 0.12,
    high: syllable * word * 0.04,
  };
}
