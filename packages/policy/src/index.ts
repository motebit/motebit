// Surface tension — the control plane of the agent.

export { classifyTool, isToolAllowed } from "./risk-model.js";
export { BudgetEnforcer, DEFAULT_BUDGET } from "./budget.js";
export type { BudgetConfig, BudgetCheckResult } from "./budget.js";
export { RedactionEngine } from "./redaction.js";
export {
  ContentSanitizer,
  INJECTION_DEFENSE_PROMPT,
  DIRECTIVE_DENSITY_THRESHOLD,
} from "./sanitizer.js";
export type { SanitizeResult } from "./sanitizer.js";
export { AuditLogger, InMemoryAuditSink } from "./audit.js";
export type { AuditLogSink } from "./audit.js";
export { PolicyGate, DEFAULT_POLICY } from "./policy-gate.js";
export type { PolicyConfig } from "./policy-gate.js";
export { MemoryGovernor, MemoryClass, DEFAULT_MEMORY_GOVERNANCE } from "./memory-governance.js";
export type { MemoryGovernanceConfig, MemoryDecision } from "./memory-governance.js";
export { computeReputationScore } from "./reputation.js";

// Re-export SDK types used in the policy API
export type {
  RiskLevel,
  DataClass,
  SideEffect,
  ToolRiskProfile,
  PolicyDecision,
  TurnContext,
  ToolAuditEntry,
} from "@motebit/sdk";
