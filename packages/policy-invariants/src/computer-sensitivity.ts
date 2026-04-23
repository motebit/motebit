/**
 * Computer-use sensitivity classifier — fail-closed privacy at the
 * computer-use observation and action boundary.
 *
 * Why this exists. `CLAUDE.md` foundation law: *"Fail-closed privacy.
 * Deny on error. Sensitivity levels enforced at storage, retrieval,
 * sync, and context boundaries. Medical/financial/secret never reach
 * external AI."* The real Rust dispatcher landed, which means every
 * `type` action and every screenshot observation now crosses a real
 * context boundary (AI ↔ user's OS). Without a classifier, the spec's
 * `ComputerRedaction` field is inert and the boundary is advisory.
 *
 * Scope of v1 (regex + heuristics, no ML):
 *
 *   - **Action classification** for `type`: scan the text the AI wants
 *     to type for financial (credit card + Luhn) and secret (API keys,
 *     JWTs, AWS / GitHub tokens, private keys) patterns. Return
 *     `require_approval` by default — the doctrine-ambiguous case is
 *     "AI typing a secret" which MIGHT be legitimate (user asked it
 *     to) and MIGHT be a data exfiltration attempt. Approval is the
 *     honest answer; the user decides.
 *
 *   - **Screenshot observation classification**: without OCR the
 *     classifier can't find sensitive regions inside pixels. v1 emits
 *     a typed, truthful `ComputerRedaction` with
 *     `projection_kind: "raw"` and `classified_regions_count: 0`,
 *     stamped with a `policy_version`. The seam is the permanent
 *     shape; swapping the classifier for an OCR-backed implementation
 *     in v2 does not change the contract.
 *
 * Not in scope for v1:
 *
 *   - OCR-based pixel-region redaction.
 *   - Target-hint-aware password-field detection (the `type` action
 *     doesn't carry target_hint in the wire format; retrofitting
 *     "last clicked hint" as session state is a separate pass).
 *   - Medical patterns (harder to regex — HPI text ≈ English prose).
 *     Deferred until the classifier gets an ML backend.
 *
 * Everything here is pure, synchronous, deterministic — it runs in the
 * session manager's hot path, so no I/O, no Date.now(), no random.
 */

import type { ComputerAction } from "@motebit/sdk";

/**
 * Policy version stamped onto every `ComputerRedaction` the classifier
 * produces. Bumping this invalidates prior verifier expectations — keep
 * it monotonic and commit the change alongside the rule changes it
 * describes.
 */
export const COMPUTER_SENSITIVITY_POLICY_VERSION = "v1.0.0";

/**
 * Sensitivity level assigned to matched text. Aligns with the CLAUDE.md
 * foundation-law taxonomy (none/personal/medical/financial/secret).
 * `medical` is reserved for when medical-pattern detection lands — v1
 * never emits it.
 */
export type SensitivityLevel = "none" | "personal" | "medical" | "financial" | "secret";

export interface SensitivityMatch {
  /** The rule id that fired — stable identifier for audit logs. */
  readonly rule: string;
  readonly level: SensitivityLevel;
  /** Character offset of the match in the scanned text. */
  readonly start: number;
  readonly end: number;
  /** Human-readable description for logs / approval prompts. */
  readonly description: string;
}

export interface TextSensitivityReport {
  /** Highest-severity level found. `"none"` when no matches. */
  readonly level: SensitivityLevel;
  readonly matches: readonly SensitivityMatch[];
}

/** Classifier decision for a computer-use action about to be dispatched. */
export interface ActionClassification {
  readonly decision: "allow" | "require_approval" | "deny";
  /** Machine-readable rule id that drove the decision, when applicable. */
  readonly rule?: string;
  /** Human-readable reason — surfaced to approval UX. */
  readonly reason?: string;
  /** Full sensitivity report — useful for receipts / audit logs. */
  readonly sensitivity?: TextSensitivityReport;
}

/**
 * Shape of the redaction metadata emitted onto a screenshot observation.
 * Matches `ComputerRedaction` in `@motebit/protocol` but duplicated
 * locally so this module stays free of wire-format imports at the
 * cross-layer boundary.
 */
export interface RedactionMetadata {
  readonly applied: boolean;
  readonly projection_kind: string;
  readonly policy_version: string;
  readonly classified_regions_count: number;
}

// ── Text patterns ────────────────────────────────────────────────────

/**
 * Card-number candidate: groups of 4 digits optionally separated by
 * spaces or hyphens, 13–19 digits total. Luhn-verified before we call
 * it a financial match to keep the false-positive rate low.
 */
const CARD_NUMBER_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * AWS access keys, GitHub tokens, OpenAI-style keys, Slack bot tokens,
 * generic `sk-*` / `pk-*` SDK keys. The patterns err on the side of
 * specific — the cost of missing one secret is smaller than the cost
 * of blocking every four-uppercase-letter prefix in normal prose.
 */
const SECRET_PATTERNS: ReadonlyArray<{ rule: string; pattern: RegExp; description: string }> = [
  {
    rule: "secret.aws_access_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    description: "AWS access key",
  },
  {
    rule: "secret.github_personal_token",
    pattern: /\bghp_[A-Za-z0-9]{36}\b/g,
    description: "GitHub personal access token",
  },
  {
    rule: "secret.github_oauth_token",
    pattern: /\bgho_[A-Za-z0-9]{36}\b/g,
    description: "GitHub OAuth token",
  },
  {
    rule: "secret.github_app_token",
    pattern: /\bghs_[A-Za-z0-9]{36}\b/g,
    description: "GitHub app installation token",
  },
  {
    rule: "secret.slack_bot_token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,48}\b/g,
    description: "Slack token",
  },
  {
    rule: "secret.openai_key",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
    description: "OpenAI-style SDK key",
  },
  {
    rule: "secret.anthropic_key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    description: "Anthropic API key",
  },
  {
    rule: "secret.jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    description: "JSON Web Token",
  },
  {
    rule: "secret.private_key_block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    description: "Private key PEM block",
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Luhn checksum. Returns true iff the digits satisfy the card-number
 * check. Non-digits are stripped first so `"4111-1111-1111-1111"` and
 * `"4111111111111111"` both validate.
 */
export function isValidLuhn(candidate: string): boolean {
  const digits = candidate.replace(/[^0-9]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Severity ordering for picking the dominant level from matches. */
const LEVEL_RANK: Record<SensitivityLevel, number> = {
  none: 0,
  personal: 1,
  medical: 2,
  financial: 3,
  secret: 4,
};

function higherLevel(a: SensitivityLevel, b: SensitivityLevel): SensitivityLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

// ── Text scanner ─────────────────────────────────────────────────────

/**
 * Scan arbitrary text for sensitivity patterns. Returns every match
 * plus the highest-severity level encountered. Pure / synchronous.
 *
 * Order of checks: secrets → financial (cards) → personal (SSN).
 * A single character span can match at most one rule (the first that
 * fires) to keep offsets disjoint for deterministic audit logs.
 */
export function scanText(text: string): TextSensitivityReport {
  if (!text || typeof text !== "string") {
    return { level: "none", matches: [] };
  }

  const matches: SensitivityMatch[] = [];
  const claimed: Array<[number, number]> = [];

  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => !(end <= s || start >= e));

  const record = (m: SensitivityMatch): void => {
    matches.push(m);
    claimed.push([m.start, m.end]);
  };

  // Secrets — exact tokens.
  for (const { rule, pattern, description } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = pattern.exec(text)) !== null) {
      const start = hit.index;
      const end = start + hit[0].length;
      if (overlaps(start, end)) continue;
      record({ rule, level: "secret", start, end, description });
    }
  }

  // Financial — card numbers, Luhn-verified.
  CARD_NUMBER_PATTERN.lastIndex = 0;
  let cardHit: RegExpExecArray | null;
  while ((cardHit = CARD_NUMBER_PATTERN.exec(text)) !== null) {
    const raw = cardHit[0];
    const start = cardHit.index;
    const end = start + raw.length;
    if (overlaps(start, end)) continue;
    if (!isValidLuhn(raw)) continue;
    record({
      rule: "financial.card_number",
      level: "financial",
      start,
      end,
      description: "Credit/debit card number (Luhn-verified)",
    });
  }

  // Personal — US SSN.
  SSN_PATTERN.lastIndex = 0;
  let ssnHit: RegExpExecArray | null;
  while ((ssnHit = SSN_PATTERN.exec(text)) !== null) {
    const start = ssnHit.index;
    const end = start + ssnHit[0].length;
    if (overlaps(start, end)) continue;
    record({
      rule: "personal.us_ssn",
      level: "personal",
      start,
      end,
      description: "US Social Security Number",
    });
  }

  let level: SensitivityLevel = "none";
  for (const m of matches) level = higherLevel(level, m.level);

  return { level, matches };
}

// ── Action classifier ────────────────────────────────────────────────

/**
 * Classify one `ComputerAction` about to be dispatched. v1 rules:
 *
 *   - `type` action whose text scans as `secret` or `financial` →
 *     `require_approval` so the user confirms the AI actually should
 *     type a secret. Ambiguous-case-honest: denying outright would
 *     block legitimate "type my API key I pasted above" flows.
 *   - `type` with `personal` (SSN only, today) → `require_approval`.
 *   - Every other action → `allow`.
 *
 * The decision is paired with a stable `rule` id so approval UX and
 * receipts can route on it without re-parsing the reason string.
 */
export function classifyComputerAction(action: ComputerAction): ActionClassification {
  if (action.kind === "type") {
    const report = scanText(action.text);
    if (report.level === "secret" || report.level === "financial" || report.level === "personal") {
      return {
        decision: "require_approval",
        rule: report.matches[0]?.rule ?? `sensitivity.${report.level}`,
        reason: `Action would type ${report.level} data (${report.matches.length} match${report.matches.length === 1 ? "" : "es"}); requires user approval.`,
        sensitivity: report,
      };
    }
  }
  return { decision: "allow" };
}

// ── Observation classifier ───────────────────────────────────────────

/**
 * Classify a screenshot observation's raster and emit the redaction
 * metadata. v1 stub — no OCR — so every observation returns
 * `applied: false, projection_kind: "raw", classified_regions_count: 0`
 * stamped with the current `policy_version`. The seam exists so the
 * v2 classifier (OCR + sensitivity regex against extracted text) plugs
 * in without changing the contract.
 *
 * The input is intentionally loose — the classifier inspects only the
 * fields it understands and tolerates extras. Bytes are not consumed
 * in v1 (no OCR).
 */
export function classifyScreenshotObservation(_input: {
  readonly width: number;
  readonly height: number;
  readonly bytes_base64?: string;
}): RedactionMetadata {
  return {
    applied: false,
    projection_kind: "raw",
    policy_version: COMPUTER_SENSITIVITY_POLICY_VERSION,
    classified_regions_count: 0,
  };
}

// ── Governance classifier factory ────────────────────────────────────

/**
 * Ready-to-wire governance classifier matching the
 * `ComputerGovernanceClassifier` interface in `@motebit/runtime`. Desktop
 * and other surfaces pass this into `createComputerSessionManager` to
 * get fail-closed defaults instead of the allow-all dev classifier.
 *
 * Kept as a factory (not a const) so callers can layer in additional
 * rules via composition: wrap the returned object, add their own
 * `classify`, fall through to this one on no-match.
 */
export interface ComputerGovernanceClassifierLike {
  classify(action: ComputerAction): Promise<"allow" | "require_approval" | "deny">;
  classifyObservation?(data: unknown): Promise<RedactionMetadata | undefined>;
}

export function createDefaultComputerGovernance(): ComputerGovernanceClassifierLike {
  return {
    classify(action) {
      return Promise.resolve(classifyComputerAction(action).decision);
    },
    classifyObservation(data) {
      if (!isScreenshotObservationLike(data)) return Promise.resolve(undefined);
      return Promise.resolve(classifyScreenshotObservation(data));
    },
  };
}

function isScreenshotObservationLike(
  v: unknown,
): v is { readonly kind: "screenshot"; readonly width: number; readonly height: number } {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return r.kind === "screenshot" && typeof r.width === "number" && typeof r.height === "number";
}
