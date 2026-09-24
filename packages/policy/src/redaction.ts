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
// `shapeKeyed: true` marks the patterns that match a secret by its OWN
// shape rather than by an English word standing near it. That axis is
// what makes a pattern safe to run over THIRD-PARTY RETRIEVED CONTENT,
// where the words are someone else's: a documentation page that prints
// `postgres://localhost/mydb` as an example, or a help page with the
// line `Password: required`, is not a leak — but a keyword-keyed pattern
// cannot tell it from one. Used by `redactCredentialShapes`, which the
// run-evidence producer applies to fetched page text. Orthogonal to
// `cloudEgress`: a pattern can be high-precision for a user's own typed
// message and still wrong for a stranger's web page.
const SECRET_PATTERNS: {
  pattern: RegExp;
  label: string;
  cloudEgress: boolean;
  shapeKeyed: boolean;
}[] = [
  // API keys (various formats)
  {
    pattern: /\b(sk|pk|api|key|token|secret)[_-]?[a-zA-Z0-9]{20,}\b/gi,
    label: "API_KEY",
    cloudEgress: true,
    // NOT shape-keyed: this matches any long word beginning `key`,
    // `api`, `token` or `secret`, so a URL path segment like
    // `keyboardshortcutsandmoreinfo` fires it. Precise enough for a
    // user's own typed message, useless over a stranger's page.
    shapeKeyed: false,
  },
  // AWS keys
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_KEY", cloudEgress: true, shapeKeyed: true },
  // Bearer tokens
  {
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/g,
    label: "BEARER_TOKEN",
    cloudEgress: true,
    // NOT shape-keyed: the shape is the WORD "Bearer", so "Bearer bonds
    // were phased out in the 1980s" matches. True of an HTTP header,
    // not of a sentence on a fetched page.
    shapeKeyed: false,
  },
  // JWTs
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    label: "JWT",
    cloudEgress: true,
    shapeKeyed: true,
  },
  // Private keys (PEM) — capped at 10KB to avoid catastrophic backtracking
  {
    pattern:
      /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]{0,10000}?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
    label: "PRIVATE_KEY",
    cloudEgress: true,
    shapeKeyed: true,
  },
  // US SSN — financial/PII, often legitimately used; NOT egress-redacted.
  {
    pattern: /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g,
    label: "SSN",
    cloudEgress: false,
    shapeKeyed: false,
  },
  // Hex secrets: only match when preceded by an assignment-like context (key=, secret:, token=, etc.)
  {
    pattern: /\b(?:key|secret|token|password|credential)\s*[:=]\s*[0-9a-f]{32,}\b/gi,
    label: "HEX_SECRET",
    cloudEgress: true,
    // NOT shape-keyed: the pattern is an English word next to a hex
    // run, which is the property that disqualified CONNECTION_STRING
    // and PASSWORD above. An API-docs page printing `token: <32 hex>`
    // as an example — commit hashes, sample digests — would cost the
    // owner that fetch's evidence and report a credential that is not
    // there. Same mistake as the other three, made once more.
    shapeKeyed: false,
  },
  // Base64 encoded secrets — low-precision (false-positives on legitimate base64);
  // NOT egress-redacted so a user can paste a base64 blob to a cloud model.
  {
    pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
    label: "ENCODED_SECRET",
    cloudEgress: false,
    shapeKeyed: false,
  },
  // Seed phrases: require exactly 12 or 24 BIP-39-length words (3-8 chars each)
  // \b anchors to word boundaries. Negative lookaround prevents matching a
  // substring of a longer sentence (no preceding/following lowercase word).
  {
    pattern: /\b(?<![a-z] )(?:[a-z]{3,8} ){11}[a-z]{3,8}\b(?! [a-z])/g,
    label: "SEED_PHRASE",
    cloudEgress: true,
    // NOT shape-keyed: twelve short lowercase words is a statistical
    // shape, and ordinary prose has it — "the quick brown fox jumps
    // over some lazy dogs that ran away" matches. A seed phrase in a
    // user's own message is a near-certainty; the same run of words on
    // a fetched page is a sentence.
    shapeKeyed: false,
  },
  {
    pattern: /\b(?<![a-z] )(?:[a-z]{3,8} ){23}[a-z]{3,8}\b(?! [a-z])/g,
    label: "SEED_PHRASE",
    cloudEgress: true,
    // NOT shape-keyed: twelve short lowercase words is a statistical
    // shape, and ordinary prose has it — "the quick brown fox jumps
    // over some lazy dogs that ran away" matches. A seed phrase in a
    // user's own message is a near-certainty; the same run of words on
    // a fetched page is a sentence.
    shapeKeyed: false,
  },
  // Vendor key formats with a mandatory punctuation separator. Ordinary
  // words do not contain one, which is what makes this safe over
  // third-party prose where the bare-prefix API_KEY pattern above is
  // not. Also catches the `sk-proj-…` and `ghp_…` shapes that pattern
  // misses, because it allows only one separator.
  {
    pattern:
      /\b(?:(?:sk|pk|rk)[-_](?:[A-Za-z0-9]+[-_])*[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    label: "VENDOR_KEY",
    cloudEgress: true,
    shapeKeyed: true,
  },
  // Connection strings
  {
    pattern: /\b(?:postgres|mysql|mongodb|redis):\/\/[^\s]+/gi,
    label: "CONNECTION_STRING",
    cloudEgress: true,
    // Keyword-keyed: a docs page printing an example URL is not a leak.
    shapeKeyed: false,
  },
  // Generic password patterns
  { pattern: /\bpassword\s*[:=]\s*\S+/gi, label: "PASSWORD", cloudEgress: true, shapeKeyed: false },
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
   * Redact only the patterns that identify a secret by its own SHAPE.
   *
   * For third-party retrieved content, where the surrounding words
   * belong to someone else. A keyword-keyed pattern reads a docs page's
   * `postgres://localhost/mydb` example, or a help page's
   * `Password: required`, as a credential — and the run-evidence
   * producer's response to a credential is to record no pointer at all,
   * so a false positive costs an owner the evidence for that fetch and
   * tells them nothing was retrieved.
   */
  redactCredentialShapes(text: string): { text: string; redactionCount: number } {
    let result = text;
    let count = 0;
    for (const { pattern, label, shapeKeyed } of SECRET_PATTERNS) {
      if (!shapeKeyed) continue;
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
   * Redact a RETRIEVED SOURCE — a URL an owner is told to re-fetch.
   *
   * Two failure modes pull in opposite directions, and one membrane
   * cannot serve both, so this splits the string where the risk splits.
   *
   * A path is STRUCTURE, written by whoever published the page, and
   * running keyword-keyed patterns over it destroys the affordance the
   * URL exists for: `API_KEY` matches any long word beginning `key`,
   * `api`, `token` or `secret`, so
   * `…/apidocumentationandreference/v2` came back as
   * `…/[REDACTED:API_KEY]/v2` and the owner was handed a digest beside
   * a source they cannot see. So the path gets the shape-keyed set,
   * which recognises a secret by its own form and cannot be fooled by
   * someone else's vocabulary.
   *
   * A query is DATA, and it is where `?ssn=` and `?card=` live. The
   * credential-class sets both exclude those deliberately — for a
   * different boundary — so a statement URL crossed the relay with a
   * social-security number and a card number in the clear. The query
   * and fragment get the FULL set: a false positive there costs a
   * parameter, and being wrong the other way costs someone's PII.
   *
   * A `ref` that is not a URL at all gets the full set, because
   * unparseable is not a reason to disclose.
   */
  redactRetrievedSource(ref: string): string {
    try {
      new URL(ref);
    } catch {
      return this.redact(ref).text;
    }
    // Split the RAW string, never a string rebuilt from `URL` parts.
    //
    // `url.origin` is the literal `"null"` for every non-special scheme,
    // so `s3://reports/q3.csv` came back as `null/q3.csv` and
    // `file:///Users/d/report.txt` as `null/Users/d/report.txt` — the
    // bucket and the host silently dropped from the one string the
    // owner is told to re-fetch. Reassembly also swallowed `user:tok@`
    // with no marker, so the displayed ref differed from the recorded
    // one and said nothing about it. Only `read-url` writes an http
    // source today, but `ref` is a free string and this function is
    // documented as total.
    const cut = ref.search(/[?#]/);
    const head = cut === -1 ? ref : ref.slice(0, cut);
    const tail = cut === -1 ? "" : ref.slice(cut);
    return this.redactCredentialShapes(head).text + (tail === "" ? "" : this.redact(tail).text);
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
  redactForCloudEgress(text: string): {
    text: string;
    redactionCount: number;
    labels: string[];
  } {
    let result = text;
    let count = 0;
    const labels: string[] = [];
    for (const { pattern, label, cloudEgress } of SECRET_PATTERNS) {
      if (!cloudEgress) continue;
      const re = new RegExp(pattern.source, pattern.flags);
      const matches = result.match(re);
      if (matches) {
        count += matches.length;
        // Distinct pattern-class label names (e.g. "API_KEY") — safe audit metadata,
        // never the secret content. See SecretRedactedFromEgressPayload.
        if (!labels.includes(label)) labels.push(label);
        result = result.replace(re, `[REDACTED:${label}]`);
      }
    }
    return { text: result, redactionCount: count, labels };
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
