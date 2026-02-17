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

const SECRET_PATTERNS: { pattern: RegExp; label: string }[] = [
  // API keys (various formats)
  { pattern: /\b(sk|pk|api|key|token|secret)[_-]?[a-zA-Z0-9]{20,}\b/gi, label: "API_KEY" },
  // AWS keys
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_KEY" },
  // Bearer tokens
  { pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/g, label: "BEARER_TOKEN" },
  // JWTs
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: "JWT" },
  // Private keys (PEM) — capped at 10KB to avoid catastrophic backtracking
  { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]{0,10000}?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g, label: "PRIVATE_KEY" },
  // US SSN
  { pattern: /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g, label: "SSN" },
  // Hex secrets: only match when preceded by an assignment-like context (key=, secret:, token=, etc.)
  { pattern: /\b(?:key|secret|token|password|credential)\s*[:=]\s*[0-9a-f]{32,}\b/gi, label: "HEX_SECRET" },
  // Base64 encoded secrets (long base64 strings)
  { pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, label: "ENCODED_SECRET" },
  // Seed phrases: require exactly 12 or 24 BIP-39-length words (3-8 chars each)
  // \b anchors to word boundaries. Negative lookaround prevents matching a
  // substring of a longer sentence (no preceding/following lowercase word).
  { pattern: /\b(?<![a-z] )(?:[a-z]{3,8} ){11}[a-z]{3,8}\b(?! [a-z])/g, label: "SEED_PHRASE" },
  { pattern: /\b(?<![a-z] )(?:[a-z]{3,8} ){23}[a-z]{3,8}\b(?! [a-z])/g, label: "SEED_PHRASE" },
  // Connection strings
  { pattern: /\b(?:postgres|mysql|mongodb|redis):\/\/[^\s]+/gi, label: "CONNECTION_STRING" },
  // Generic password patterns
  { pattern: /\bpassword\s*[:=]\s*\S+/gi, label: "PASSWORD" },
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
