/**
 * Shared approval presets for tool governance.
 *
 * Canonical source — imported by all surfaces (web, desktop, mobile).
 * Each preset defines the risk thresholds for automatic tool approval.
 */

export type ApprovalPreset = "cautious" | "balanced" | "autonomous";

export interface ApprovalPresetConfig {
  label: string;
  description: string;
  maxRiskLevel: number;
  requireApprovalAbove: number;
  denyAbove: number;
}

export const APPROVAL_PRESET_CONFIGS: Record<string, ApprovalPresetConfig> = {
  cautious: {
    label: "Cautious",
    description: "Approve everything above read-only",
    maxRiskLevel: 3,
    requireApprovalAbove: 0,
    denyAbove: 3,
  },
  balanced: {
    label: "Balanced",
    description: "Auto-allow low risk, approve medium",
    maxRiskLevel: 3,
    requireApprovalAbove: 1,
    denyAbove: 3,
  },
  autonomous: {
    label: "Autonomous",
    description: "Auto-allow most, deny only dangerous",
    maxRiskLevel: 4,
    requireApprovalAbove: 3,
    denyAbove: 4,
  },
};
