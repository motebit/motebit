import { RiskLevel } from "@motebit/sdk";
import type {
  ToolDefinition,
  ToolResult,
  ToolRiskProfile,
  PolicyDecision,
  TurnContext,
} from "@motebit/sdk";
import { classifyTool, isToolAllowed } from "./risk-model.js";
import { BudgetEnforcer } from "./budget.js";
import type { BudgetConfig } from "./budget.js";
import { RedactionEngine } from "./redaction.js";
import { ContentSanitizer } from "./sanitizer.js";
import { AuditLogger } from "./audit.js";
import type { AuditLogSink } from "./audit.js";

// === Policy Configuration ===

export interface PolicyConfig {
  /** Operator Mode: when false, only R0/R1 tools are available (ambient companion).
   *  When true, R2+ become available with full enforcement (operator). */
  operatorMode: boolean;

  /** Maximum risk level allowed (derived from operatorMode if not set).
   *  In ambient mode: R1_DRAFT. In operator mode: R4_MONEY. */
  maxRiskLevel?: RiskLevel;

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
        { allowed: true, requiresApproval: false, reason: `Operator mode ${enabled ? "enabled" : "disabled"}` },
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
  validate(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    ctx: TurnContext,
  ): PolicyDecision {
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
      this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision);
      return decision;
    }

    // 2. Risk level check
    if (!isToolAllowed(profile, maxRisk)) {
      const decision: PolicyDecision = {
        allowed: false,
        requiresApproval: false,
        reason: `Tool "${tool.name}" requires risk level ${RiskLevel[profile.risk]} but max allowed is ${RiskLevel[maxRisk]}. Enable Operator Mode for higher-risk tools.`,
      };
      this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision);
      return decision;
    }

    // 3. Budget check
    const budgetResult = this.budget.check(ctx);
    if (!budgetResult.allowed) {
      const decision: PolicyDecision = {
        allowed: false,
        requiresApproval: false,
        reason: budgetResult.reason,
        budgetRemaining: { calls: budgetResult.remaining.calls, timeMs: budgetResult.remaining.timeMs },
      };
      this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision);
      return decision;
    }

    // 4. Path allowlist check for file tools — uses segment boundary matching
    if (this.config.pathAllowList && args.path && typeof args.path === "string") {
      const argPath = args.path as string;
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
        this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision);
        return decision;
      }
    }

    // 5. Domain allowlist check for URL tools — deny on invalid URL
    if (this.config.domainAllowList && this.config.domainAllowList.length > 0 && args.url && typeof args.url === "string") {
      let hostname: string;
      try {
        hostname = new URL(args.url as string).hostname;
      } catch {
        // Invalid URL — deny rather than silently allowing
        const decision: PolicyDecision = {
          allowed: false,
          requiresApproval: false,
          reason: `Invalid URL "${args.url as string}" — cannot verify domain allowlist`,
        };
        this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision);
        return decision;
      }

      const allowed = this.config.domainAllowList.some((d) =>
        hostname === d || hostname.endsWith(`.${d}`),
      );
      if (!allowed) {
        const decision: PolicyDecision = {
          allowed: false,
          requiresApproval: false,
          reason: `Domain "${hostname}" is not in the allowed domains list`,
        };
        this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision);
        return decision;
      }
    }

    // 6. Approval check (derived from risk, not manual)
    const decision: PolicyDecision = {
      allowed: true,
      requiresApproval: profile.requiresApproval,
      budgetRemaining: { calls: budgetResult.remaining.calls, timeMs: budgetResult.remaining.timeMs },
    };

    this.audit.logDecision(ctx.turnId, callId, tool.name, args, decision);
    return decision;
  }

  // === Sanitization ===

  /**
   * Sanitize a tool result before it enters the conversation.
   * Wraps content in data boundaries (prompt injection defense)
   * and redacts any detected secrets.
   */
  sanitizeResult(result: ToolResult, toolName: string): ToolResult {
    if (!result.data) return result;

    const text = typeof result.data === "string" ? result.data : JSON.stringify(result.data);

    // Redact secrets
    const { text: redacted } = this.redaction.redact(text);

    // Wrap in injection-safe boundary
    const sanitized = this.sanitizer.sanitizeToolResult(redacted, toolName);

    return { ...result, data: sanitized };
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

  // === Turn Management ===

  /**
   * Create a new turn context.
   */
  createTurnContext(): TurnContext {
    return {
      turnId: crypto.randomUUID(),
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
