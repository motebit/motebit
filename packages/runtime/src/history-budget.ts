/**
 * Per-tier history ceilings — the policy half of the window-derived history
 * budget (docs/design/context-trimming-parity.md, P1). The window half lives
 * in `@motebit/sdk` (`contextWindowForModel`) and the arithmetic in
 * `@motebit/ai-core` (`historyBudgetForWindow`).
 */

import type { ModelCapabilityTier } from "@motebit/sdk";
import { DEFAULT_HISTORY_CEILING_TOKENS } from "@motebit/ai-core";

/** `RuntimeConfig.historyCeilingTokens`: one number, or one per tier. */
export type HistoryCeilingConfig =
  number | Partial<Record<ModelCapabilityTier, number>> | undefined;

const TIERS: readonly ModelCapabilityTier[] = ["frontier", "capable", "minimal"];

/** The history ceiling for a capability tier (default 64,000). */
export function historyCeilingForTier(
  config: HistoryCeilingConfig,
  tier: ModelCapabilityTier,
): number {
  if (typeof config === "number") return config;
  return config?.[tier] ?? DEFAULT_HISTORY_CEILING_TOKENS;
}

/**
 * The in-memory token bound for a ceiling config: twice the largest ceiling
 * any tier can get, so the bound never releases a message a turn's budget
 * could send, whichever model is selected later in the session.
 */
export function historyBoundForCeilings(config: HistoryCeilingConfig): number {
  return 2 * Math.max(...TIERS.map((t) => historyCeilingForTier(config, t)));
}
