// Shared time-formatting utilities for the Goals family.
//
// The countdown formatter lived in two places before: web's
// goals-runner.ts and web's gated-panels.ts (two slightly different
// copies). When desktop's Goals panel grew a countdown affordance, a
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
