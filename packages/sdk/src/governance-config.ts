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
  maxCallsPerTurn: number;
}
