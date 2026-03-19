import { RiskLevel, AgentTrustLevel } from "@motebit/sdk";
import type {
  ToolDefinition,
  ToolResult,
  ToolRiskProfile,
  PolicyDecision,
  TurnContext,
  InjectionWarning,
  ApprovalQuorum,
} from "@motebit/sdk";
import { classifyTool, isToolAllowed } from "./risk-model.js";
import { BudgetEnforcer } from "./budget.js";
import type { BudgetConfig } from "./budget.js";
import { RedactionEngine } from "./redaction.js";
import { ContentSanitizer } from "./sanitizer.js";
import { AuditLogger } from "./audit.js";
import type { AuditLogSink } from "./audit.js";

// === Scope Parsing (inlined to avoid cross-layer dependency on @motebit/crypto) ===

function parseScopeSet(scope: string): Set<string> {
  if (scope === "*") return new Set(["*"]);
  return new Set(
    scope
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

// === Policy Configuration ===

export interface PolicyConfig {
  /** Operator Mode: when false, only R0/R1 tools are available (ambient companion).
   *  When true, R2+ become available with full enforcement (operator). */
  operatorMode: boolean;

  /** Maximum risk level allowed (derived from operatorMode if not set).
   *  In ambient mode: R1_DRAFT. In operator mode: R4_MONEY. */
  maxRiskLevel?: RiskLevel;

  /** Three-band governance thresholds (from motebit.md governance section).
   *  When set, these override the simpler maxRiskLevel / requiresApproval logic:
   *    - risk <= requireApprovalAbove → auto-allow (no approval needed)
   *    - risk > denyAbove → hard deny
   *    - between → allowed but requiresApproval=true */
  requireApprovalAbove?: RiskLevel;
  denyAbove?: RiskLevel;

  /** Budget constraints per turn. */
  budget?: Partial<BudgetConfig>;

  /** Explicit tool allowlist (if set, only these tools are available). */
  toolAllowList?: string[];

  /** Explicit tool denylist (always blocked). */
  toolDenyList?: string[];

  /** Filesystem path allowlist for file tools. */
  pathAllowList?: string[];

  /** Domain allowlist for web tools (empty = all allowed). */
  domainAllowList?: string[];

  /** Per-tool risk overrides (tool name → risk level). */
  riskOverrides?: Record<string, RiskLevel>;

  /** Multi-party approval quorum configuration (opt-in). */
  approvalQuorum?: ApprovalQuorum;
}

export const DEFAULT_POLICY: PolicyConfig = {
  operatorMode: false,
};

// === PolicyGate ===

/**
 * PolicyGate — the surface tension of the agent.
 *
 * Sits between the agentic loop and the tool registry. Every tool call passes
 * through the gate. The gate decides: allowed? needs approval? denied?
 *
 * The gate also:
 * - Filters which tools the model can see (based on mode + risk)
 * - Sanitizes tool results (prompt injection defense)
 * - Redacts secrets from content before it reaches the model
 * - Enforces budgets (calls, time, cost)
 * - Emits audit entries for every decision
 */
export class PolicyGate {
  private config: PolicyConfig;
  private budget: BudgetEnforcer;
  private redaction: RedactionEngine;
  private sanitizer: ContentSanitizer;
  readonly audit: AuditLogger;
  private profileCache = new Map<string, ToolRiskProfile>();

  constructor(config?: Partial<PolicyConfig>, auditSink?: AuditLogSink) {
    // Deep-copy config to prevent external mutation
    const merged = { ...DEFAULT_POLICY, ...config };
    this.config = {
      ...merged,
      toolAllowList: merged.toolAllowList ? [...merged.toolAllowList] : undefined,
      toolDenyList: merged.toolDenyList ? [...merged.toolDenyList] : undefined,
      pathAllowList: merged.pathAllowList ? [...merged.pathAllowList] : undefined,
      domainAllowList: merged.domainAllowList ? [...merged.domainAllowList] : undefined,
      riskOverrides: merged.riskOverrides ? { ...merged.riskOverrides } : undefined,
      budget: merged.budget ? { ...merged.budget } : undefined,
    };
    this.budget = new BudgetEnforcer(this.config.budget);
    this.redaction = new RedactionEngine();
    this.sanitizer = new ContentSanitizer();
    this.audit = new AuditLogger(auditSink);
  }

  // === Configuration ===

  get operatorMode(): boolean {
    return this.config.operatorMode;
  }

  setOperatorMode(enabled: boolean): void {
    const previous = this.config.operatorMode;
    this.config.operatorMode = enabled;
    this.profileCache.clear();

    // Audit the mode change
    if (previous !== enabled) {
      this.audit.logDecision(
        "system",
        crypto.randomUUID(),
        "__operator_mode_change",
        { from: previous, to: enabled },
        {
          allowed: true,
          requiresApproval: false,
          reason: `Operator mode ${enabled ? "enabled" : "disabled"}`,
        },
      );
    }
  }

  getEffectiveMaxRisk(): RiskLevel {
    if (this.config.maxRiskLevel !== undefined) return this.config.maxRiskLevel;
    return this.config.operatorMode ? RiskLevel.R4_MONEY : RiskLevel.R1_DRAFT;
  }

  // === Tool Classification ===

  /**
   * Classify a tool's risk profile. Uses cached result if available.
   */
  classify(tool: ToolDefinition): ToolRiskProfile {
    const cached = this.profileCache.get(tool.name);
    if (cached) return cached;

    const profile = classifyTool(tool);

    // Apply risk overrides — only change risk level, preserve original approval semantics
    if (this.config.riskOverrides?.[tool.name] !== undefined) {
      const originalApproval = profile.requiresApproval;
      profile.risk = this.config.riskOverrides[tool.name]!;
      // Approval is the max of: what the original tool required, what the new risk implies
      profile.requiresApproval = originalApproval || profile.risk >= RiskLevel.R2_WRITE;
    }

    this.profileCache.set(tool.name, profile);
    return profile;
  }

  // === Tool Filtering ===

  /**
   * Filter tools to only those visible in the current mode.
   * This is what gets sent to the model in the ContextPack.
   */
  filterTools(tools: ToolDefinition[]): ToolDefinition[] {
    const maxRisk = this.getEffectiveMaxRisk();

    return tools.filter((tool) => {
      // Denylist always blocks
      if (this.config.toolDenyList?.includes(tool.name)) return false;

      // Allowlist (if set) must include the tool
      if (this.config.toolAllowList && !this.config.toolAllowList.includes(tool.name)) return false;

      // Risk check
      const profile = this.classify(tool);
      return isToolAllowed(profile, maxRisk);
    });
  }

  // === Validation ===

  /**
   * Validate a tool call before execution.
   * Returns the policy decision: allowed, needs approval, or denied.
   */
  validate(tool: ToolDefinition, args: Record<string, unknown>, ctx: TurnContext): PolicyDecision {
    const profile = this.classify(tool);
    const maxRisk = this.getEffectiveMaxRisk();
    const callId = crypto.randomUUID();

    // 1. Denylist check
    if (this.config.toolDenyList?.includes(tool.name)) {
      const decision: PolicyDecision = {
        allowed: false,
        requiresApproval: false,
        reason: `Tool "${tool.name}" is on the deny list`,
      };
      this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision, ctx.runId);
      return decision;
    }

    // 2. Delegation scope enforcement — fail-closed
    if (ctx.delegationScope !== undefined) {
      const scopeSet = parseScopeSet(ctx.delegationScope);
      if (!scopeSet.has("*") && !scopeSet.has(tool.name)) {
        const decision: PolicyDecision = {
          allowed: false,
          requiresApproval: false,
          reason: `Tool "${tool.name}" is outside delegated scope "${ctx.delegationScope}"`,
        };
        this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision, ctx.runId);
        return decision;
      }
    }

    // 3. Risk level check — three-band governance when thresholds are set
    const hasBands =
      this.config.requireApprovalAbove !== undefined && this.config.denyAbove !== undefined;

    if (hasBands) {
      // Three-band: auto-allow / require-approval / hard-deny
      if (profile.risk > this.config.denyAbove!) {
        const decision: PolicyDecision = {
          allowed: false,
          requiresApproval: false,
          reason: `Tool "${tool.name}" risk ${RiskLevel[profile.risk]} exceeds deny threshold ${RiskLevel[this.config.denyAbove!]}`,
        };
        this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision, ctx.runId);
        return decision;
      }
    } else {
      // Legacy two-state: allowed or denied based on maxRiskLevel
      if (!isToolAllowed(profile, maxRisk)) {
        const decision: PolicyDecision = {
          allowed: false,
          requiresApproval: false,
          reason: `Tool "${tool.name}" requires risk level ${RiskLevel[profile.risk]} but max allowed is ${RiskLevel[maxRisk]}. Enable Operator Mode for higher-risk tools.`,
        };
        this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision, ctx.runId);
        return decision;
      }
    }

    // 3. Budget check
    const budgetResult = this.budget.check(ctx);
    if (!budgetResult.allowed) {
      const decision: PolicyDecision = {
        allowed: false,
        requiresApproval: false,
        reason: budgetResult.reason,
        budgetRemaining: {
          calls: budgetResult.remaining.calls,
          timeMs: budgetResult.remaining.timeMs,
          cost: budgetResult.remaining.cost,
        },
      };
      this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision, ctx.runId);
      return decision;
    }

    // 4. Path allowlist check for file tools — uses segment boundary matching
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- args.path is any from tool schema
    if (this.config.pathAllowList && args.path && typeof args.path === "string") {
      const argPath = args.path;
      const allowed = this.config.pathAllowList.some((p) => {
        if (argPath === p) return true;
        // Ensure match is at a directory boundary: /home/user/project/file.ts is ok,
        // but /home/user/project-evil/file.ts is not
        const prefix = p.endsWith("/") ? p : p + "/";
        return argPath.startsWith(prefix);
      });
      if (!allowed) {
        const decision: PolicyDecision = {
          allowed: false,
          requiresApproval: false,
          reason: `Path "${argPath}" is outside allowed paths`,
        };
        this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision, ctx.runId);
        return decision;
      }
    }

    // 5. Domain allowlist check for URL tools — deny on invalid URL
    if (
      this.config.domainAllowList &&
      this.config.domainAllowList.length > 0 &&
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- args.url is any from tool schema
      args.url &&
      typeof args.url === "string"
    ) {
      let hostname: string;
      try {
        hostname = new URL(args.url).hostname;
      } catch {
        // Invalid URL — deny rather than silently allowing
        const decision: PolicyDecision = {
          allowed: false,
          requiresApproval: false,
          reason: `Invalid URL "${args.url}" — cannot verify domain allowlist`,
        };
        this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision, ctx.runId);
        return decision;
      }

      const allowed = this.config.domainAllowList.some(
        (d) => hostname === d || hostname.endsWith(`.${d}`),
      );
      if (!allowed) {
        const decision: PolicyDecision = {
          allowed: false,
          requiresApproval: false,
          reason: `Domain "${hostname}" is not in the allowed domains list`,
        };
        this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision, ctx.runId);
        return decision;
      }
    }

    // 6. Approval check — three-band governance vs legacy
    let needsApproval: boolean;
    if (hasBands) {
      // Approval band: risk > requireApprovalAbove but <= denyAbove
      needsApproval = profile.risk > this.config.requireApprovalAbove!;
    } else {
      // Legacy: derived from tool classification (R2+ requires approval)
      needsApproval = profile.requiresApproval;
    }

    // 7. Caller trust level — adjust approval based on verified caller identity
    if (ctx.callerTrustLevel != null) {
      switch (ctx.callerTrustLevel) {
        case AgentTrustLevel.Blocked: {
          const decision: PolicyDecision = {
            allowed: false,
            requiresApproval: false,
            reason: `Caller "${ctx.callerMotebitId ?? "unknown"}" is blocked`,
          };
          this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision, ctx.runId);
          return decision;
        }
        case AgentTrustLevel.Trusted:
          // Trusted callers get same privileges as local user
          needsApproval = false;
          break;
        case AgentTrustLevel.FirstContact:
        case AgentTrustLevel.Unknown:
          // Unknown/first-contact callers: all tools require approval
          needsApproval = true;
          break;
        case AgentTrustLevel.Verified:
          // Verified callers: standard policy applies, no change
          break;
      }
    }

    // 8. Motebit type differentiation — adjust approval based on remote agent type
    if (ctx.remoteMotebitType === "service") {
      // Service motebits are expected to call tools — lower threshold by one risk level.
      // R1 tools auto-approve (no approval needed) for service callers.
      if (needsApproval && profile.risk <= RiskLevel.R1_DRAFT) {
        needsApproval = false;
      }
    } else if (ctx.remoteMotebitType === "personal") {
      // Personal motebits inbound: stricter — require approval for anything above R0.
      if (profile.risk > RiskLevel.R0_READ) {
        needsApproval = true;
      }
    }
    // collaborative: use standard policy (no adjustment), logged via normal audit

    // 9. Multi-party approval quorum — attach quorum metadata when configured
    const quorum = this.config.approvalQuorum;
    let quorumMeta: PolicyDecision["quorum"];
    if (needsApproval && quorum && quorum.threshold > 1) {
      // Check risk floor — only apply quorum at or above the configured risk level
      const meetsFloor =
        !quorum.risk_floor || profile.risk >= this.parseRiskFloor(quorum.risk_floor);
      if (meetsFloor) {
        quorumMeta = {
          required: quorum.threshold,
          approvers: quorum.approvers,
          collected: [],
        };
      }
    }

    const decision: PolicyDecision = {
      allowed: true,
      requiresApproval: needsApproval,
      budgetRemaining: {
        calls: budgetResult.remaining.calls,
        timeMs: budgetResult.remaining.timeMs,
        cost: budgetResult.remaining.cost,
      },
      ...(quorumMeta ? { quorum: quorumMeta } : {}),
    };

    this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision, ctx.runId);
    return decision;
  }

  // === Sanitization ===

  /**
   * Sanitize a tool result before it enters the conversation.
   * Wraps content in data boundaries (prompt injection defense)
   * and redacts any detected secrets.
   */
  sanitizeResult(result: ToolResult, toolName: string): ToolResult {
    return this.sanitizeAndCheck(result, toolName).result;
  }

  /**
   * Sanitize a tool result and report whether injection was detected.
   * Used by the agentic loop to yield injection_warning chunks.
   */
  sanitizeAndCheck(
    result: ToolResult,
    toolName: string,
  ): {
    result: ToolResult;
    injectionDetected: boolean;
    injectionPatterns: string[];
    directiveDensity?: number;
    structuralFlags?: string[];
  } {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- result.data is unknown, falsy check is intentional
    if (!result.data) {
      return { result, injectionDetected: false, injectionPatterns: [] };
    }

    const text = typeof result.data === "string" ? result.data : JSON.stringify(result.data);

    // Redact secrets (always, even if pre-sanitized)
    const { text: redacted } = this.redaction.redact(text);

    // Always apply full sanitization (boundary-wrap + scan) at the enforcement
    // boundary, regardless of upstream _sanitized flag. MCP client wrapping is
    // defense-in-depth; inner boundaries get safely escaped.
    const sanitized = this.sanitizer.sanitize(redacted, `tool:${toolName}`);
    return {
      result: { ...result, data: sanitized.content },
      injectionDetected: sanitized.injectionDetected,
      injectionPatterns: sanitized.injectionPatterns,
      directiveDensity: sanitized.directiveDensity,
      structuralFlags: sanitized.structuralFlags,
    };
  }

  /**
   * Log an injection detection event to the audit trail.
   */
  logInjection(
    turnId: string,
    callId: string,
    tool: string,
    args: Record<string, unknown>,
    injection: InjectionWarning,
    blocked: boolean,
    runId?: string,
  ): void {
    this.audit.logInjection(turnId, callId, tool, args, injection, blocked, runId);
  }

  /**
   * Redact secrets from arbitrary text (e.g., before sending to model).
   */
  redact(text: string): string {
    return this.redaction.redact(text).text;
  }

  /**
   * Check if text contains secrets that should never be stored in memory.
   */
  containsSecrets(text: string): boolean {
    return this.redaction.containsSecrets(text);
  }

  /** Parse a risk floor string (e.g. "R2_WRITE") into a RiskLevel enum value. */
  private parseRiskFloor(floor: string): RiskLevel {
    const map: Record<string, RiskLevel> = {
      R0_READ: RiskLevel.R0_READ,
      R1_DRAFT: RiskLevel.R1_DRAFT,
      R2_WRITE: RiskLevel.R2_WRITE,
      R3_EXECUTE: RiskLevel.R3_EXECUTE,
      R4_MONEY: RiskLevel.R4_MONEY,
    };
    return map[floor] ?? RiskLevel.R0_READ;
  }

  // === Turn Management ===

  /**
   * Create a new turn context.
   */
  createTurnContext(runId?: string): TurnContext {
    return {
      turnId: crypto.randomUUID(),
      runId,
      toolCallCount: 0,
      turnStartMs: Date.now(),
      costAccumulated: 0,
    };
  }

  /**
   * Increment the tool call count in a turn context.
   */
  recordToolCall(ctx: TurnContext, cost = 0): TurnContext {
    return {
      ...ctx,
      toolCallCount: ctx.toolCallCount + 1,
      costAccumulated: ctx.costAccumulated + cost,
    };
  }
}
