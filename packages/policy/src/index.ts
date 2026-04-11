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
export type { AuditLogSink, AuditStatsSince } from "./audit.js";
export { PolicyGate, DEFAULT_POLICY } from "./policy-gate.js";
export type { PolicyConfig } from "./policy-gate.js";
export { MemoryGovernor, MemoryClass, DEFAULT_MEMORY_GOVERNANCE } from "./memory-governance.js";
export type { MemoryGovernanceConfig, MemoryDecision } from "./memory-governance.js";
export { computeReputationScore } from "./reputation.js";
export {
  appendAuditEntry,
  verifyAuditChain,
  getChainHead,
  computeEntryHash,
  InMemoryAuditChainStore,
  GENESIS_HASH,
} from "./audit-chain.js";
export type { AuditEntry, AuditChainStore } from "./audit-chain.js";

// Re-export SDK types and enums used in the policy API
export { RiskLevel, DataClass, SideEffect } from "@motebit/protocol";
export type {
  ToolRiskProfile,
  PolicyDecision,
  TurnContext,
  ToolAuditEntry,
} from "@motebit/protocol";
