/**
 * Shared governance configuration schema.
 *
 * Canonical source — imported by surfaces that persist governance settings.
 * Platform-specific persistence (localStorage, Tauri, AsyncStorage) stays in each app.
 */

import type { ApprovalPreset } from "./approval-presets.js";

export interface GovernanceConfig {
  approvalPreset: ApprovalPreset;
  persistenceThreshold: number;
  rejectSecrets: boolean;
  /** Max tool calls in a single agentic turn. */
  maxCallsPerTurn: number;
  /** Max memories the MemoryGovernor will persist in a single turn. */
  maxMemoriesPerTurn: number;
}

/** Default governance config — matches `DEFAULT_MEMORY_GOVERNANCE` in policy. */
export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = {
  approvalPreset: "balanced",
  persistenceThreshold: 0.5,
  rejectSecrets: true,
  maxCallsPerTurn: 10,
  maxMemoriesPerTurn: 5,
};
