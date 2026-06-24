/**
 * RedactionEngine — detects and redacts secrets before they reach the model.
 *
 * The invariant: "never send secrets to the model."
 * Secrets include API keys, passwords, tokens, SSNs, seed phrases, private keys.
 */

/** Simple Luhn checksum validation for card number detection. */
function passesLuhn(digits: string): boolean {
  const nums = digits.replace(/\D/g, "");
  if (nums.length < 13 || nums.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let d = parseInt(nums[i]!, 10);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// `cloudEgress: true` marks the high-precision CREDENTIAL-class patterns that are
// redacted from a user's outbound message to a NON-SOVEREIGN (cloud) provider
// (see `redactForCloudEgress` + the runtime's secret-redacting provider). The
// excluded patterns (SSN, bare-base64 ENCODED_SECRET, and the Luhn card path
// below) are deliberately NOT egress-redacted: SSNs and card numbers are
// financial/PII a user often legitimately wants the model to use, and bare base64
// false-positives on legitimate content — those stay user-controlled (set the
// session sensitivity tier or use an on-device provider). Storage/memory/tool-
// result redaction (`redact`) still runs the FULL set; egress redaction is the
// narrower, near-zero-false-positive subset. Doctrine: docs/doctrine/security-boundaries.md.
const SECRET_PATTERNS: { pattern: RegExp; label: string; cloudEgress: boolean }[] = [
  // API keys (various formats)
  {
    pattern: /\b(sk|pk|api|key|token|secret)[_-]?[a-zA-Z0-9]{20,}\b/gi,
    label: "API_KEY",
    cloudEgress: true,
  },
  // AWS keys
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_KEY", cloudEgress: true },
  // Bearer tokens
  { pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/g, label: "BEARER_TOKEN", cloudEgress: true },
  // JWTs
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    label: "JWT",
    cloudEgress: true,
  },
  // Private keys (PEM) — capped at 10KB to avoid catastrophic backtracking
  {
    pattern:
      /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]{0,10000}?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
    label: "PRIVATE_KEY",
    cloudEgress: true,
  },
  // US SSN — financial/PII, often legitimately used; NOT egress-redacted.
  { pattern: /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g, label: "SSN", cloudEgress: false },
  // Hex secrets: only match when preceded by an assignment-like context (key=, secret:, token=, etc.)
  {
    pattern: /\b(?:key|secret|token|password|credential)\s*[:=]\s*[0-9a-f]{32,}\b/gi,
    label: "HEX_SECRET",
    cloudEgress: true,
  },
  // Base64 encoded secrets — low-precision (false-positives on legitimate base64);
  // NOT egress-redacted so a user can paste a base64 blob to a cloud model.
  { pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, label: "ENCODED_SECRET", cloudEgress: false },
  // Seed phrases: require exactly 12 or 24 BIP-39-length words (3-8 chars each)
  // \b anchors to word boundaries. Negative lookaround prevents matching a
  // substring of a longer sentence (no preceding/following lowercase word).
  {
    pattern: /\b(?<![a-z] )(?:[a-z]{3,8} ){11}[a-z]{3,8}\b(?! [a-z])/g,
    label: "SEED_PHRASE",
    cloudEgress: true,
  },
  {
    pattern: /\b(?<![a-z] )(?:[a-z]{3,8} ){23}[a-z]{3,8}\b(?! [a-z])/g,
    label: "SEED_PHRASE",
    cloudEgress: true,
  },
  // Connection strings
  {
    pattern: /\b(?:postgres|mysql|mongodb|redis):\/\/[^\s]+/gi,
    label: "CONNECTION_STRING",
    cloudEgress: true,
  },
  // Generic password patterns
  { pattern: /\bpassword\s*[:=]\s*\S+/gi, label: "PASSWORD", cloudEgress: true },
];

/**
 * Card number pattern — used separately because we validate with Luhn.
 * Matches sequences of 13-19 digits (with optional spaces/dashes).
 */
const CARD_NUMBER_PATTERN = /\b(\d[ -]*?){13,19}\b/g;

export class RedactionEngine {
  private extraPatterns: { pattern: RegExp; label: string }[] = [];

  /** Add custom redaction patterns. */
  addPattern(pattern: RegExp, label: string): void {
    this.extraPatterns.push({ pattern, label });
  }

  /**
   * Redact detected secrets from text, replacing with [REDACTED:LABEL].
   * Returns the redacted text and the count of redactions made.
   */
  redact(text: string): { text: string; redactionCount: number } {
    let result = text;
    let count = 0;

    for (const { pattern, label } of [...SECRET_PATTERNS, ...this.extraPatterns]) {
      // Clone regex to avoid stateful lastIndex issues
      const re = new RegExp(pattern.source, pattern.flags);
      const matches = result.match(re);
      if (matches) {
        count += matches.length;
        result = result.replace(re, `[REDACTED:${label}]`);
      }
    }

    // Card numbers: validate with Luhn before redacting
    const cardRe = new RegExp(CARD_NUMBER_PATTERN.source, CARD_NUMBER_PATTERN.flags);
    result = result.replace(cardRe, (match) => {
      if (passesLuhn(match)) {
        count++;
        return "[REDACTED:CARD_NUMBER]";
      }
      return match;
    });

    return { text: result, redactionCount: count };
  }

  /**
   * Redact ONLY the high-precision credential-class patterns (`cloudEgress: true`)
   * — for masking a user's own typed message before it reaches a NON-SOVEREIGN
   * (cloud) provider. Deliberately narrower than {@link redact}: it does NOT touch
   * SSNs, card numbers, or bare base64, which a user often legitimately wants the
   * model to use and which would false-positive. The model almost never needs to
   * SEE a raw credential (agents use keys via the credential/tool path), so masking
   * keys/tokens/seed-phrases/connection-strings from the prompt protects without
   * breaking the request. The egress gate (`assertSensitivityPermitsAiCall`) still
   * blocks a whole call when the SESSION tier is medical/financial/secret; this is
   * the additive floor for secrets typed into an UNMARKED cloud session.
   */
  redactForCloudEgress(text: string): { text: string; redactionCount: number } {
    let result = text;
    let count = 0;
    for (const { pattern, label, cloudEgress } of SECRET_PATTERNS) {
      if (!cloudEgress) continue;
      const re = new RegExp(pattern.source, pattern.flags);
      const matches = result.match(re);
      if (matches) {
        count += matches.length;
        result = result.replace(re, `[REDACTED:${label}]`);
      }
    }
    return { text: result, redactionCount: count };
  }

  /**
   * Check if text contains content that should never be stored in memory.
   */
  containsSecrets(text: string): boolean {
    for (const { pattern } of [...SECRET_PATTERNS, ...this.extraPatterns]) {
      const re = new RegExp(pattern.source, pattern.flags);
      if (re.test(text)) return true;
    }

    // Check for Luhn-valid card numbers
    const cardRe = new RegExp(CARD_NUMBER_PATTERN.source, CARD_NUMBER_PATTERN.flags);
    let match: RegExpExecArray | null;
    while ((match = cardRe.exec(text)) !== null) {
      if (passesLuhn(match[0])) return true;
    }

    return false;
  }
}
