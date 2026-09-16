import { RiskLevel, AgentTrustLevel } from "@motebit/protocol";
import type {
  ToolDefinition,
  ToolResult,
  ToolRiskProfile,
  PolicyDecision,
  TurnContext,
  InjectionWarning,
  ApprovalQuorum,
  RunEvidenceSink,
  RunEvidenceEntry,
  RunEvidenceWithheldReason,
} from "@motebit/protocol";
import { classifyTool, isToolAllowed } from "./risk-model.js";
import { BudgetEnforcer } from "./budget.js";
import type { BudgetConfig } from "./budget.js";
import { RedactionEngine } from "./redaction.js";
import {
  scopeDelta,
  postureDelta,
  grantRequiredDelta,
  quorumShortfallDelta,
} from "./authority-delta.js";
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
 * How much of a tool's returned text is kept as the re-checkable span.
 *
 * A pointer exists to be re-checked, not to store the document — and a
 * prefix of a substring is still a substring, so bounding costs the law
 * nothing. Wide enough to identify WHICH record was read when a person
 * re-fetches it; far short of keeping the record itself, which would
 * put retrieved content under a retention policy it never entered.
 */
const EVIDENCE_SPAN_MAX_CHARS = 512;

/**
 * Where an evidence-write failure goes when nobody wired anywhere else.
 * Console rather than nothing: a surface that forgot to inject a logger
 * should still see the failure, because the alternative is a record
 * that goes quiet and reads as though nothing was retrieved.
 */
const defaultEvidenceLogger = {
  warn(message: string): void {
    // eslint-disable-next-line no-console -- last-resort channel; see above
    console.warn(message);
  },
};

/**
 * Does this reference carry a secret in its query string?
 *
 * Name-keyed on purpose: in a URL the parameter name says what the
 * value is, and an opaque token has no shape a value-matcher can find.
 * Deliberately conservative about what counts as a value — a one or two
 * character parameter is a page number, not a key.
 */
const CREDENTIAL_PARAM =
  /[?&#][^=&\s]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|token|secret|password|passwd|pwd|signature|credential|sig)=[^&\s]{16,}/i;

/**
 * Userinfo credentials — `https://user:pass@host/…`. A different place
 * to hide the same thing.
 */
const URL_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

/**
 * The engine is passed in, not stashed.
 *
 * This read a module-level binding that `recordEvidence` reassigned on
 * every call — shared across every gate instance, retaining the last
 * one's engine after a policy swap, and initialised to a predicate
 * returning false. Correct only because the assignment sat one line
 * above the use; any reordering would have quietly degraded the guard
 * to query-string matching with nothing to notice.
 */
function looksLikeCredentialBearingUrl(
  ref: string,
  shapesFound: (text: string) => boolean,
): boolean {
  // Query AND fragment AND userinfo. The first version anchored on
  // `[?&]` alone, which reads the query string and nothing else — so an
  // OAuth implicit-grant callback (`…/cb#access_token=…`) and a userinfo
  // URL both walked past a guard whose stated purpose is that a
  // credential in a reference is never stored. Checking only the part
  // one happens to think of is the mistake this guard already made once.
  // The credential word can sit anywhere in the parameter NAME, not
  // only at its start. Anchored to the separator, the rule read
  // `?sig=` and missed every vendor-prefixed form — measured,
  // `X-Amz-Signature=` and `X-Goog-Signature=` both walked past, so a
  // presigned export link handed to the agent wrote its signature into
  // a row kept for the horizon and printed verbatim on return. Third
  // time this guard has been too narrow; each time the gap was a place
  // I had not thought to look rather than a rule that was wrong.
  //
  // The shape filter runs over the reference too, which catches a
  // vendor key embedded in a PATH rather than a query.
  return CREDENTIAL_PARAM.test(ref) || URL_USERINFO.test(ref) || shapesFound(ref);
}

/**
 * Cut the span to the bound WITHOUT splitting a character.
 *
 * `slice` counts UTF-16 code units, so a cut landing between the halves
 * of an astral character (an emoji, a rarer CJK glyph) leaves a lone
 * surrogate. SQLite stores TEXT as UTF-8 and turns that into U+FFFD, so
 * the span read back is not the span written — and
 * `verifyEvidenceProvenance` reports `span_absent` for a pointer this
 * producer made. A record that fails its own law is worse than a shorter
 * one, so the cut retreats to a whole character.
 */
function boundSpan(data: string): string {
  if (data.length <= EVIDENCE_SPAN_MAX_CHARS) return data;
  const cut = data.slice(0, EVIDENCE_SPAN_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  // A high surrogate at the end has lost its pair to the cut.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

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
  private evidenceSink: RunEvidenceSink | null = null;
  /**
   * Where an evidence-write failure is reported. Optional, and when it
   * is absent the failure still throws to the caller — what must never
   * happen is the failure going nowhere at all, because a missing
   * pointer then reads as "nothing was retrieved".
   */
  private evidenceLogger: { warn(message: string): void } | null = defaultEvidenceLogger;

  /**
   * `evidenceSink` is a CONSTRUCTOR parameter, not only a setter.
   *
   * It was setter-only, wired once at runtime construction — and
   * `updatePolicyConfig` builds a whole new gate, so changing any policy
   * setting silently produced a gate that recorded no evidence. Nothing
   * errored; `runs show` simply began printing "none recorded", which
   * this vocabulary insists must never read as "nothing was read". A
   * config-induced loss that is indistinguishable from an honest absence
   * is the worst shape this record can take. Passing it through the
   * constructor makes a gate that forgot it hard to build; the setter
   * stays for surfaces that wire storage after construction.
   */
  constructor(
    config?: Partial<PolicyConfig>,
    auditSink?: AuditLogSink,
    evidenceSink?: RunEvidenceSink | null,
    /**
     * Arrives WITH the sink, not after it. A gate holding a sink and no
     * logger swallows a store refusal with no output anywhere, which is
     * the silence-as-absence this record must never produce; the
     * default keeps that from being the easy thing to build.
     */
    evidenceLogger: { warn(message: string): void } | null = defaultEvidenceLogger,
  ) {
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
    this.evidenceSink = evidenceSink ?? null;
    this.evidenceLogger = evidenceLogger;
  }

  /**
   * Wire the sibling record that `recordResult`'s contract names: where
   * a run's re-checkable evidence pointers go. A gate without one
   * records no evidence, and every reader must render that as "none
   * recorded", never as "nothing was read".
   */
  setEvidenceSink(sink: RunEvidenceSink | null): void {
    this.evidenceSink = sink;
  }

  /** Report evidence-write failures somewhere. See `evidenceLogger`. */
  setEvidenceLogger(logger: { warn(message: string): void } | null): void {
    this.evidenceLogger = logger;
  }

  /**
   * Mint the evidence pointer for a tool call that content-addressed
   * what it read, and nothing otherwise.
   *
   * The span is the tool's OWN returned text, not a model's account of
   * it. `ToolResult.source_digest`'s contract is that its presence means
   * `data` is either a verbatim span of the raw bytes or the output of
   * the named byte-deterministic recipe over them — so `data` is a
   * substring of `projection(bytes)` by construction, which is exactly
   * the law `verifyEvidenceProvenance` applies. A span nobody fetched
   * cannot get in here, because the only writer is the fetch itself.
   *
   * Bounded, because a pointer is for re-checking, not for storing the
   * document: a prefix of a substring is still a substring, and
   * `locator` says which prefix. Absent digest, absent evidence — never
   * a bare claim this producer cannot back.
   */
  recordEvidence(
    ctx: Pick<TurnContext, "turnId" | "runId">,
    decision: PolicyDecision,
    tool: string,
    result: ToolResult,
  ): void {
    if (this.evidenceSink == null) return;
    const sink = this.evidenceSink;
    if (decision.callId == null) return;
    if (!result.ok || result.source_digest == null) return;
    if (typeof result.data !== "string" || result.data === "") return;

    const span = boundSpan(result.data);
    // Credential-class content means NO pointer, not a redacted one.
    //
    // The sibling audit row redacts its args before persisting, and this
    // row carries something stronger: verbatim retrieved content, which
    // `runs show` prints. But redacting a span would be worse than
    // either alternative — the law is that the span is an exact
    // substring of the bytes, so a `[REDACTED:…]` span is a claim that
    // fails re-verification, i.e. a pointer asserting something untrue.
    //
    // A pointer that is both safe and true is not available here, so we
    // record neither. Absence is the honest answer and the one this
    // vocabulary is built for: the producer never makes a claim it
    // cannot back. The tool's own result is unaffected; only the
    // durable pointer is withheld.
    //
    // The CREDENTIAL-class set, not the full one.
    //
    // `redact` deliberately includes three low-precision patterns —
    // bare 9-digit runs, any 40+ character alphanumeric token, and
    // Luhn-passing digit runs — which the pattern table itself marks
    // `cloudEgress: false` for exactly that reason. Using them here
    // withheld a pointer whenever a page's first 512 characters held a
    // commit hash, a reference number, or a long identifier, and the
    // person was told "none recorded". A guard that suppresses honest
    // evidence at that rate does not protect the record, it empties it.
    //
    // Narrowed twice. The full set fired on a git SHA and a bare
    // nine-digit reference. The cloud-egress subset still carried two
    // KEYWORD-keyed patterns — a connection-string URL and the word
    // "password" near a colon — which are about a user's own typed
    // message, not a stranger's web page: a docs page printing
    // `postgres://localhost/mydb` as an example, or a help page reading
    // `Password: required`, cost the owner the evidence for that fetch
    // and reported nothing retrieved. What is left keys on the secret's
    // own shape, which is the property that travels across whose words
    // these are.
    //
    // (That residual was closed in the same change by `VENDOR_KEY`,
    // which keys on the mandatory separator those formats carry. Noted
    // because a stale "known gap" invites someone to re-open it.)
    // Judged against the WHOLE result, not the bounded span.
    //
    // Bounding first meant a secret whose pattern needs bytes past the
    // cut could never match: a PEM block needs its BEGIN and END
    // delimiters, about 1.7KB apart, so an endpoint serving a private
    // key had ~470 characters of it stored verbatim, printed on return,
    // and kept for the horizon — past the guard whose entire job is that
    // credential-class content is never kept. The span is what gets
    // STORED; the data is what gets JUDGED.
    if (this.redaction.redactCredentialShapes(result.data).redactionCount > 0) {
      this.recordWithheld(sink, ctx, decision, tool, "credential_in_span");
      return;
    }
    // The SOURCE is guarded separately, by its own rule.
    //
    // `read_url` passes the request URL, and a URL carries credentials
    // in query parameters — so a fetch of `…/export?api_key=…` wrote the
    // key into the pointer's `ref`, past a guard that only looked at the
    // span. The shared credential patterns catch none of those forms:
    // measured, `api_key=`, `token=`, `access_token=` and `sig=` all
    // pass untouched, because the patterns key on the VALUE's shape and
    // a bare opaque string has none.
    //
    // In a URL the parameter NAME is the strong signal, which makes this
    // rule precise where a value-shape rule cannot be. It lives here
    // rather than in the shared table because it is true of URLs, not of
    // prose, and the shared table is applied to prose.
    if (
      result.source_ref != null &&
      looksLikeCredentialBearingUrl(
        result.source_ref,
        (text) => this.redaction.redactCredentialShapes(text).redactionCount > 0,
      )
    ) {
      this.recordWithheld(sink, ctx, decision, tool, "credential_in_source");
      return;
    }
    this.recordOrReport(sink, {
      evidence_id: crypto.randomUUID(),
      ...(ctx.runId != null ? { run_id: ctx.runId } : {}),
      turn_id: ctx.turnId,
      call_id: decision.callId,
      tool,
      recorded_at: Date.now(),
      evidence: {
        kind: "tool_result",
        // What was read, in the producing tool's own terms. Falls back
        // to the call id only when the tool named nothing — such a
        // pointer is still worth keeping beside its call, but it cannot
        // be re-fetched and no surface may imply it can.
        ref: result.source_ref ?? decision.callId,
        provenance: {
          digest: result.source_digest,
          ...(result.source_projection != null ? { projection: result.source_projection } : {}),
          // Carried only when the TOOL declares it. Absent means
          // spec-reproducible, the strong rung, so this producer must
          // never supply a default — defaulting would claim the strong
          // rung on behalf of a recipe that may meet only the weaker
          // one, which is the over-claim the class exists to prevent.
          ...(result.source_projection_class != null
            ? { projectionClass: result.source_projection_class }
            : {}),
          span,
          // No `locator`. It is advisory, and this gate is tool-agnostic:
          // asserting the span starts at offset 0 of `projection(bytes)`
          // happens to hold for today's only producer and would be
          // quietly wrong for any tool that returns a mid-document
          // excerpt. An absent advisory field costs a re-verifier
          // nothing, because the law is substring presence; a wrong one
          // sends them to the wrong place.
        },
      },
    });
  }

  /**
   * Record that a pointer WAS produced and deliberately not kept.
   *
   * The guard that withholds credential-class content had the same flaw
   * as the thing this vocabulary exists to remove: it made the evidence
   * simply vanish, so a reader could not tell a refusal from a tool that
   * retrieved nothing. Both printed "none recorded". A guard whose whole
   * justification is honesty was producing an ambiguous absence.
   *
   * The row carries no digest, no span and no source — keeping any of
   * those would defeat the withholding, and the source is itself one of
   * the places a credential hides. It says only that something was read
   * and refused, and why. That is enough to separate the two absences,
   * and enough that a guard firing where it should not becomes
   * observable instead of invisible — which, after four corrections
   * found by review rather than by me, is the part that matters.
   */
  private recordWithheld(
    sink: RunEvidenceSink,
    ctx: Pick<TurnContext, "turnId" | "runId">,
    decision: PolicyDecision,
    tool: string,
    reason: RunEvidenceWithheldReason,
  ): void {
    if (decision.callId == null) return;
    this.recordOrReport(sink, {
      evidence_id: crypto.randomUUID(),
      ...(ctx.runId != null ? { run_id: ctx.runId } : {}),
      turn_id: ctx.turnId,
      call_id: decision.callId,
      tool,
      recorded_at: Date.now(),
      evidence: { kind: "tool_result", ref: decision.callId },
      withheld_reason: reason,
    });
  }

  /**
   * Write the pointer, and if the store refuses, say so.
   *
   * The store raises rather than dropping rows, so the failure has to
   * land somewhere it can be seen. Reported here AND rethrown: the
   * primary tool path absorbs it (a pointer must not take down the work
   * it describes), and this is what stops the absorbing from becoming
   * silence.
   */
  private recordOrReport(sink: RunEvidenceSink, entry: RunEvidenceEntry): void {
    try {
      sink.record(entry);
    } catch (err: unknown) {
      this.evidenceLogger?.warn(
        `[policy] evidence not recorded for ${entry.tool}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
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
  filterTools(
    tools: ToolDefinition[],
    ctx?: Pick<TurnContext, "verifiedGrant" | "delegationScope">,
  ): ToolDefinition[] {
    const maxRisk = this.getEffectiveMaxRisk();

    return tools.filter((tool) => {
      // Denylist always blocks
      if (this.config.toolDenyList?.includes(tool.name)) return false;

      // Allowlist (if set) must include the tool
      if (this.config.toolAllowList && !this.config.toolAllowList.includes(tool.name)) return false;

      // Risk check
      const profile = this.classify(tool);
      if (isToolAllowed(profile, maxRisk)) return true;

      // Standing-authority extension of the OFFERING (decided 2026-07-07,
      // the ceremony blocker: with the payment rail wired,
      // delegate_to_agent classifies R4_MONEY and default governance
      // filtered it out of the model's tool list entirely — the signed
      // grant changed nothing about what could even be SEEN). A turn
      // carrying a VERIFIED grant offers grant-covered tools up to
      // R4_MONEY. Bounds that still hold: deny/allow lists above,
      // `denyAbove` (a hard ceiling the grant never overrides), the
      // scope fence at validate step 2, and the meter at the rail.
      // Doctrine: docs/doctrine/memory-never-confers-authority.md —
      // "a signed grant or a live human tap"; the grant IS the signed
      // artifact.
      return (
        ctx?.verifiedGrant != null &&
        this.grantCoversTool(ctx, tool.name) &&
        profile.risk <= RiskLevel.R4_MONEY &&
        (this.config.denyAbove === undefined || profile.risk <= this.config.denyAbove)
      );
    });
  }

  /**
   * Is `toolName` inside the turn's delegated scope? The scope string is
   * set BY the runtime FROM the verified grant's signed `scope` field at
   * presentation (never model output) — same set semantics as the
   * validate-step-2 fence.
   */
  private grantCoversTool(ctx: Pick<TurnContext, "delegationScope">, toolName: string): boolean {
    if (ctx.delegationScope === undefined) return false;
    const scopeSet = parseScopeSet(ctx.delegationScope);
    return scopeSet.has("*") || scopeSet.has(toolName);
  }

  // === Validation ===

  /**
   * Validate a tool call before execution.
   * Returns the policy decision: allowed, needs approval, or denied.
   *
   * Every decision is written to the audit sink BEFORE the caller can
   * execute, under a fresh `callId` that the returned decision carries
   * (`PolicyDecision.callId`). The executor closes the row with
   * `recordResult` once the tool returns. The pair is the durable
   * execution ledger: an allowed decision with no result after a
   * process death is an action whose external effect is UNKNOWN — it
   * proves the call was prepared, never that it happened. Recovery must
   * hold that ambiguity (`findUnresolvedActions` in audit.ts), never
   * treat it as safe to retry.
   */
  validate(tool: ToolDefinition, args: Record<string, unknown>, ctx: TurnContext): PolicyDecision {
    const callId = crypto.randomUUID();
    const decision = this.evaluate(tool, args, ctx, callId);
    return { ...decision, callId };
  }

  /**
   * Record that a decision which PAUSED for approval is now proceeding to
   * execution because a human satisfied the band out of band (a genuine
   * user tap, or a persisted approval applied after a restart). Appended
   * under the same `callId` BEFORE the call, as an allowed, un-paused
   * decision (`reason: "approval_satisfied:<by>"`). Without it the ledger
   * would show only the paused row, which `findUnresolvedActions`
   * deliberately ignores (the approval queue owns paused state) — so a
   * death between this execution and its completion row would read as
   * "nothing happened" instead of "prepared; effect unknown".
   */
  recordApprovalSatisfied(
    ctx: Pick<TurnContext, "turnId" | "runId">,
    decision: PolicyDecision,
    tool: string,
    args: Record<string, unknown>,
    by: "user-tap" | "human-approved",
  ): void {
    if (decision.callId == null) return;
    this.audit.logDecision(
      ctx.turnId,
      decision.callId,
      tool,
      args,
      { ...decision, allowed: true, requiresApproval: false, reason: `approval_satisfied:${by}` },
      ctx.runId,
    );
  }

  /**
   * Record the outcome of a tool execution against the decision row the
   * gate wrote for it. The completion half of the intent/completion pair
   * (see `validate`). No-op when the decision carries no `callId` (a
   * hand-built decision that never went through `validate`): a fresh id
   * here would mint an orphan row that correlates with nothing, which is
   * worse than an honest gap.
   *
   * `ok` is the tool's own verdict. It is attribution + the tool's report,
   * not an independent verification of the external effect — a claimed
   * result should link to evidence from the affected system
   * (docs/doctrine/evidence-provenance.md); that pointer is a sibling
   * artifact, never inferred from this row.
   *
   * Which executors close rows today: the AI loop, the resume-after-approval
   * path, and `invokeLocalTool`. The MCP-server, attached-surface and
   * grant-delegation executors validate without closing; their rows stay
   * open. Restart recovery scopes by `run_id`, which those paths do not
   * set, so they cannot cause a spurious hold — but the ledger invariant is
   * not yet enforced by a gate. See docs/drift-defenses.md.
   */
  recordResult(
    ctx: Pick<TurnContext, "turnId" | "runId">,
    decision: PolicyDecision,
    tool: string,
    args: Record<string, unknown>,
    ok: boolean,
    durationMs: number,
  ): void {
    if (decision.callId == null) return;
    this.audit.logResult(
      ctx.turnId,
      decision.callId,
      tool,
      args,
      decision,
      ok,
      durationMs,
      ctx.runId,
    );
  }

  private evaluate(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    ctx: TurnContext,
    callId: string,
  ): PolicyDecision {
    const profile = this.classify(tool);
    const maxRisk = this.getEffectiveMaxRisk();

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
          missing_authority: scopeDelta(tool.name),
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
          missing_authority: postureDelta(profile.risk, this.config.denyAbove!),
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
          missing_authority: postureDelta(profile.risk, maxRisk),
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

    // 8b. Standing-authority invariant — memory never confers authority.
    // An R4_MONEY tool call may auto-execute (no human approval) ONLY
    // when the turn carries a cryptographically verified live
    // standing-delegation grant (`ctx.verifiedGrant`, populated
    // exclusively by the runtime's dispatch-layer grant verifier from
    // signed artifacts — never from model output, recalled memory,
    // trust level, or configuration). This deliberately subordinates
    // every approval-lowering path above — the Trusted-caller bypass,
    // the service-motebit adjustment, governance presets — for R4 only:
    // they still clear R0–R3, but standing authority over money is a
    // signed grant or a live human tap, never an inference. There is no
    // config switch for this branch; that is what makes it an
    // invariant (docs/doctrine/runtime-invariants-over-prompt-rules.md).
    // Doctrine: docs/doctrine/memory-never-confers-authority.md.
    // Gate: check-money-authority.
    if (profile.risk >= RiskLevel.R4_MONEY && !needsApproval && ctx.verifiedGrant == null) {
      needsApproval = true;
    }

    // 8c. The disjunct's other half (decided 2026-07-07): a VERIFIED
    // in-scope standing grant IS the R4 authorizer — "a signed grant or
    // a live human tap" (memory-never-confers-authority.md), implemented
    // as an OR at last. Strictly narrower than every lowering path 8b
    // subordinates: it requires the cryptographically verified grant
    // (produced only by the dispatch-layer verifier from signed
    // artifacts) AND the tool inside the grant's SIGNED scope. It runs
    // AFTER the denyAbove hard-deny (which already returned — the grant
    // never overrides a hard ceiling) and cannot be reached by trust
    // levels, memory, or config alone. Enforcement downstream is
    // unchanged: the blast-radius meter + rail wrapper bound every
    // spend to the grant's signed ceiling; the tick nonce bounds
    // frequency; revocation is terminal.
    if (
      needsApproval &&
      profile.risk >= RiskLevel.R4_MONEY &&
      ctx.verifiedGrant != null &&
      this.grantCoversTool(ctx, tool.name)
    ) {
      needsApproval = false;
    }

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

    // Owner-facing residual for a RAISED (not denied) decision: what
    // authority would let this auto-execute. Single producer module;
    // grant-required takes precedence over quorum shortfall (the grant
    // is the deeper missing artifact). Model-visible channels never
    // carry this — see AuthorityDelta's asymmetry invariant.
    // R4 pending approval without a verified grant: the missing authority
    // IS a grant (or the live tap) — true whether the band or 8b raised
    // it. Otherwise a pending quorum names its shortfall.
    const raiseDelta =
      profile.risk >= RiskLevel.R4_MONEY && ctx.verifiedGrant == null
        ? grantRequiredDelta(profile.risk)
        : quorumMeta != null
          ? quorumShortfallDelta(quorumMeta.required - quorumMeta.collected.length)
          : undefined;

    const decision: PolicyDecision = {
      allowed: true,
      requiresApproval: needsApproval,
      budgetRemaining: {
        calls: budgetResult.remaining.calls,
        timeMs: budgetResult.remaining.timeMs,
        cost: budgetResult.remaining.cost,
      },
      ...(quorumMeta ? { quorum: quorumMeta } : {}),
      ...(needsApproval && raiseDelta != null ? { missing_authority: raiseDelta } : {}),
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
   * Redact ONLY the high-precision credential-class secrets — for masking a user's
   * own typed message before it reaches a non-sovereign (cloud) provider. Narrower
   * than {@link redact} (no SSN / card / bare-base64). See
   * `RedactionEngine.redactForCloudEgress`.
   */
  redactForCloudEgress(text: string): { text: string; redactionCount: number; labels: string[] } {
    return this.redaction.redactForCloudEgress(text);
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
