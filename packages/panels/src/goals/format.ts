// Shared time-formatting utilities for the Goals family.
//
// The countdown formatter lived in two places before: web's goals
// wiring and web's gated-panels.ts (two slightly different copies).
// When desktop's Goals panel grew a countdown affordance, a
// third copy would have landed on the other side of the surface
// boundary — the exact drift the records-vs-acts + sibling-boundary
// rules exist to prevent. Lifting the formatter here keeps it a
// single source of truth.
//
// Output grammar (stable across surfaces):
//
//   targetMs <= nowMs     → "any moment"
//   < 60 seconds          → "in Ns"
//   < 60 minutes          → "in Nm"
//   < 24 hours            → "in Nh" or "in Nh Mm" (M != 0)
//   >= 24 hours           → "in Nd" or "in Nd Mh" (M != 0)
//
// Surfaces pass their own `now` for deterministic rendering.

/**
 * Format a future timestamp as a human-readable countdown from `nowMs`.
 * Returns `"any moment"` if the target is at or before `nowMs`.
 */
export function formatCountdownUntil(targetMs: number, nowMs: number = Date.now()): string {
  const diff = targetMs - nowMs;
  if (diff <= 0) return "any moment";
  const s = Math.round(diff / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm === 0 ? `in ${h}h` : `in ${h}h ${mm}m`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh === 0 ? `in ${d}d` : `in ${d}d ${hh}h`;
}

/**
 * Format a token count at axis-native scale for the bounded-commitment
 * envelope ("12k / 50k tokens"). Thousands → `k`, millions → `M`, with a
 * single decimal only when the value isn't a clean multiple (`50k`, not
 * `50.0k`; `1.5k` for 1500). Sub-1000 counts render verbatim.
 *
 * This is the v1 `tokens`-axis renderer per
 * `docs/doctrine/panel-temporal-registers.md` §"Bounded commitment is
 * multi-dimensional". It lived as a byte-identical copy on web, desktop,
 * and mobile before — value-formatting, not the per-surface time-of-day
 * formatting that CLAUDE.md rule 6 keeps at the surface — so it belongs
 * here beside `formatCountdownUntil` as the single source of truth.
 * Future axes (voice-seconds, tool-calls) get sibling formatters here as
 * they land.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}
