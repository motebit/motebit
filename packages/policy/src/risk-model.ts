import { RiskLevel, DataClass, SideEffect } from "@motebit/sdk";
import type { ToolDefinition, ToolRiskProfile } from "@motebit/sdk";

/**
 * Risk classification rules — pattern-based inference when tools don't declare
 * their own riskHint. The first matching rule wins.
 */
const RISK_RULES: { pattern: RegExp; profile: Partial<ToolRiskProfile> }[] = [
  // R4 Money
  { pattern: /\b(pay|payment|charge|invoice|refund|transfer|checkout|stripe|billing)\b/i, profile: { risk: RiskLevel.R4_MONEY, sideEffect: SideEffect.IRREVERSIBLE } },
  // R3 Execute
  { pattern: /\b(shell|exec|run|command|deploy|restart|kill)\b/i, profile: { risk: RiskLevel.R3_EXECUTE, sideEffect: SideEffect.IRREVERSIBLE } },
  // R2 Write
  { pattern: /\b(write|create|update|delete|remove|send|post|push|merge)\b/i, profile: { risk: RiskLevel.R2_WRITE, sideEffect: SideEffect.REVERSIBLE } },
  // R1 Draft
  { pattern: /\b(draft|compose|generate|suggest|plan|prepare|format)\b/i, profile: { risk: RiskLevel.R1_DRAFT, sideEffect: SideEffect.NONE } },
  // R0 Read (default)
  { pattern: /\b(read|get|list|search|fetch|query|recall|check|view|browse)\b/i, profile: { risk: RiskLevel.R0_READ, sideEffect: SideEffect.NONE } },
];

const DATA_CLASS_RULES: { pattern: RegExp; dataClass: DataClass }[] = [
  { pattern: /\b(secret|credential|token|password|key|seed|ssn|private_key)\b/i, dataClass: DataClass.SECRET },
  { pattern: /\b(personal|private|memory|calendar|email|inbox|contact|photo)\b/i, dataClass: DataClass.PRIVATE },
];

/**
 * Classify a tool's risk profile from its definition.
 * Uses the tool's own riskHint if provided, otherwise infers from name + description.
 */
export function classifyTool(tool: ToolDefinition): ToolRiskProfile {
  const hint = tool.riskHint;
  const text = `${tool.name} ${tool.description}`;

  // Risk level: explicit hint > pattern match > R0
  let risk = hint?.risk;
  if (risk === undefined) {
    for (const rule of RISK_RULES) {
      if (rule.pattern.test(text)) {
        risk = rule.profile.risk!;
        break;
      }
    }
  }
  risk ??= RiskLevel.R0_READ;

  // Data class: explicit hint > pattern match > PUBLIC
  let dataClass = hint?.dataClass;
  if (dataClass === undefined) {
    for (const rule of DATA_CLASS_RULES) {
      if (rule.pattern.test(text)) {
        dataClass = rule.dataClass;
        break;
      }
    }
  }
  dataClass ??= DataClass.PUBLIC;

  // Side effect: explicit hint > inferred from risk level
  let sideEffect = hint?.sideEffect;
  if (sideEffect === undefined) {
    if (risk >= RiskLevel.R3_EXECUTE) sideEffect = SideEffect.IRREVERSIBLE;
    else if (risk >= RiskLevel.R2_WRITE) sideEffect = SideEffect.REVERSIBLE;
    else sideEffect = SideEffect.NONE;
  }

  // Approval is derived: R2+ always requires approval, or tool's explicit flag
  const requiresApproval =
    tool.requiresApproval === true || risk >= RiskLevel.R2_WRITE;

  return { risk, dataClass, sideEffect, requiresApproval };
}

/**
 * Check if a tool is allowed under a given maximum risk level.
 */
export function isToolAllowed(profile: ToolRiskProfile, maxRisk: RiskLevel): boolean {
  return profile.risk <= maxRisk;
}
