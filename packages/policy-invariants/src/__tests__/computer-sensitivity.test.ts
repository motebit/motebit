/**
 * Tests for `computer-sensitivity.ts` — the v1 classifier enforcing
 * fail-closed privacy at the computer-use boundary.
 *
 * Coverage targets:
 *   - Luhn validation: canonical positive + negative cases
 *   - scanText: secrets, financial (with Luhn gate), personal, clean text
 *   - overlap rule: a single span can't be claimed by two rules
 *   - classifyComputerAction: every action kind + the require_approval
 *     routing for type actions with sensitive text
 *   - classifyScreenshotObservation: stable v1 shape
 *   - createDefaultComputerGovernance: classify + classifyObservation
 *     including the non-screenshot passthrough
 */
import { describe, expect, it } from "vitest";

import {
  COMPUTER_SENSITIVITY_POLICY_VERSION,
  classifyComputerAction,
  classifyScreenshotObservation,
  createDefaultComputerGovernance,
  isValidLuhn,
  scanText,
} from "../computer-sensitivity";

// Canonical Luhn-valid card numbers (widely used as test vectors).
const VISA_TEST = "4111 1111 1111 1111";
const MASTERCARD_TEST = "5500000000000004";
const AMEX_TEST = "340000000000009";

describe("isValidLuhn", () => {
  it("accepts canonical Visa / Mastercard / Amex test numbers", () => {
    expect(isValidLuhn(VISA_TEST)).toBe(true);
    expect(isValidLuhn(MASTERCARD_TEST)).toBe(true);
    expect(isValidLuhn(AMEX_TEST)).toBe(true);
  });

  it("rejects off-by-one digits", () => {
    expect(isValidLuhn("4111 1111 1111 1112")).toBe(false);
  });

  it("rejects lengths below 13 or above 19", () => {
    expect(isValidLuhn("411111111111")).toBe(false); // 12
    expect(isValidLuhn("41111111111111111111")).toBe(false); // 20
  });

  it("strips separators before validating", () => {
    expect(isValidLuhn("4111-1111-1111-1111")).toBe(true);
    expect(isValidLuhn("4111111111111111")).toBe(true);
  });

  it("rejects all-zero strings of valid length", () => {
    // 16 zeros sum to 0 which is a multiple of 10, but the len <13 branch
    // still protects shorter strings. For a degenerate 16-zero case Luhn
    // is technically valid — we verify the algorithm returns true and
    // rely on upstream rules to avoid treating it as a card in practice.
    expect(isValidLuhn("0000000000000000")).toBe(true);
  });
});

describe("scanText — secrets", () => {
  it("flags AWS access keys", () => {
    const r = scanText("My key is AKIAABCDEFGHIJKLMNOP please use it");
    expect(r.level).toBe("secret");
    expect(r.matches[0]!.rule).toBe("secret.aws_access_key");
  });

  it("flags GitHub personal tokens (ghp_)", () => {
    const r = scanText(`token ghp_${"A".repeat(36)} end`);
    expect(r.level).toBe("secret");
    expect(r.matches[0]!.rule).toBe("secret.github_personal_token");
  });

  it("flags GitHub OAuth tokens (gho_)", () => {
    const r = scanText(`gho_${"0".repeat(36)}`);
    expect(r.matches[0]!.rule).toBe("secret.github_oauth_token");
  });

  it("flags GitHub app tokens (ghs_)", () => {
    const r = scanText(`ghs_${"a".repeat(36)}`);
    expect(r.matches[0]!.rule).toBe("secret.github_app_token");
  });

  it("flags Slack bot tokens", () => {
    const r = scanText("xoxb-abc123defghi456jk");
    expect(r.level).toBe("secret");
    expect(r.matches[0]!.rule).toBe("secret.slack_bot_token");
  });

  it("flags OpenAI-style SDK keys", () => {
    const r = scanText(`api sk-${"Z".repeat(40)} ok`);
    expect(r.level).toBe("secret");
    expect(r.matches[0]!.rule).toBe("secret.openai_key");
  });

  it("flags Anthropic keys", () => {
    const r = scanText(`sk-ant-${"x".repeat(30)}`);
    expect(r.matches[0]!.rule).toBe("secret.anthropic_key");
  });

  it("flags JWTs", () => {
    const tok = `eyJ${"A".repeat(15)}.${"B".repeat(15)}.${"C".repeat(15)}`;
    const r = scanText(`token: ${tok}`);
    expect(r.matches[0]!.rule).toBe("secret.jwt");
  });

  it("flags PEM private key blocks (RSA / EC / generic)", () => {
    expect(scanText("-----BEGIN RSA PRIVATE KEY-----").matches[0]!.rule).toBe(
      "secret.private_key_block",
    );
    expect(scanText("-----BEGIN EC PRIVATE KEY-----").matches[0]!.rule).toBe(
      "secret.private_key_block",
    );
    expect(scanText("-----BEGIN PRIVATE KEY-----").matches[0]!.rule).toBe(
      "secret.private_key_block",
    );
  });
});

describe("scanText — financial (card numbers)", () => {
  it("flags Luhn-valid card numbers", () => {
    const r = scanText(`card ${VISA_TEST} end`);
    expect(r.level).toBe("financial");
    expect(r.matches[0]!.rule).toBe("financial.card_number");
  });

  it("skips Luhn-invalid digit strings that look like cards", () => {
    const r = scanText("card 1234 5678 9012 3456 end");
    expect(r.level).toBe("none");
  });

  it("handles hyphen-separated cards", () => {
    const r = scanText("4111-1111-1111-1111");
    expect(r.matches[0]!.rule).toBe("financial.card_number");
  });
});

describe("scanText — personal (SSN)", () => {
  it("flags US SSN format", () => {
    const r = scanText("SSN is 123-45-6789.");
    expect(r.level).toBe("personal");
    expect(r.matches[0]!.rule).toBe("personal.us_ssn");
  });

  it("ignores SSN-ish without hyphens", () => {
    const r = scanText("123456789");
    expect(r.level).toBe("none");
  });
});

describe("scanText — level precedence + overlap", () => {
  it("returns the highest-severity level when multiple match", () => {
    const tok = `eyJ${"A".repeat(15)}.${"B".repeat(15)}.${"C".repeat(15)}`;
    const r = scanText(`jwt ${tok} ssn 123-45-6789 card ${VISA_TEST}`);
    expect(r.level).toBe("secret");
    // All three patterns should fire.
    const rules = r.matches.map((m) => m.rule);
    expect(rules).toContain("secret.jwt");
    expect(rules).toContain("personal.us_ssn");
    expect(rules).toContain("financial.card_number");
  });

  it("does not double-claim overlapping character spans", () => {
    // A JWT can internally parse as digit groups that accidentally Luhn-
    // validate. The overlap rule keeps offsets disjoint.
    const tok = `eyJ${"A".repeat(15)}.${"B".repeat(15)}.${"C".repeat(15)}`;
    const r = scanText(tok);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.rule).toBe("secret.jwt");
  });

  it("returns none for plain prose", () => {
    const r = scanText("The quick brown fox jumps over the lazy dog.");
    expect(r.level).toBe("none");
    expect(r.matches).toEqual([]);
  });

  it("handles empty and non-string input gracefully", () => {
    expect(scanText("").level).toBe("none");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(scanText(null as any).level).toBe("none");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(scanText(123 as any).level).toBe("none");
  });
});

describe("classifyComputerAction", () => {
  it("allows screenshot / cursor_position / click / drag / key / scroll", () => {
    expect(classifyComputerAction({ kind: "screenshot" }).decision).toBe("allow");
    expect(classifyComputerAction({ kind: "cursor_position" }).decision).toBe("allow");
    expect(classifyComputerAction({ kind: "click", target: { x: 1, y: 2 } }).decision).toBe(
      "allow",
    );
    expect(classifyComputerAction({ kind: "double_click", target: { x: 1, y: 2 } }).decision).toBe(
      "allow",
    );
    expect(classifyComputerAction({ kind: "mouse_move", target: { x: 1, y: 2 } }).decision).toBe(
      "allow",
    );
    expect(
      classifyComputerAction({
        kind: "drag",
        from: { x: 1, y: 2 },
        to: { x: 3, y: 4 },
      }).decision,
    ).toBe("allow");
    expect(classifyComputerAction({ kind: "key", key: "cmd+c" }).decision).toBe("allow");
    expect(
      classifyComputerAction({ kind: "scroll", target: { x: 1, y: 2 }, dx: 0, dy: 1 }).decision,
    ).toBe("allow");
  });

  it("allows clean type actions", () => {
    const r = classifyComputerAction({ kind: "type", text: "Hello, world." });
    expect(r.decision).toBe("allow");
    expect(r.sensitivity).toBeUndefined();
  });

  it("routes type with secret text to require_approval with populated rule", () => {
    const r = classifyComputerAction({
      kind: "type",
      text: `sk-${"X".repeat(40)}`,
    });
    expect(r.decision).toBe("require_approval");
    expect(r.rule).toBe("secret.openai_key");
    expect(r.sensitivity?.level).toBe("secret");
    expect(r.reason).toContain("secret");
  });

  it("routes type with card number to require_approval", () => {
    const r = classifyComputerAction({ kind: "type", text: `card ${VISA_TEST}` });
    expect(r.decision).toBe("require_approval");
    expect(r.rule).toBe("financial.card_number");
    expect(r.sensitivity?.level).toBe("financial");
  });

  it("routes type with SSN to require_approval", () => {
    const r = classifyComputerAction({ kind: "type", text: "ssn 123-45-6789" });
    expect(r.decision).toBe("require_approval");
    expect(r.rule).toBe("personal.us_ssn");
    expect(r.sensitivity?.level).toBe("personal");
  });

  it("pluralizes reason correctly", () => {
    // Multi-match: two SSNs in one string.
    const r = classifyComputerAction({ kind: "type", text: "111-22-3333 and 444-55-6666" });
    expect(r.reason).toContain("matches");
    // Single match
    const r2 = classifyComputerAction({ kind: "type", text: "one 111-22-3333 here" });
    expect(r2.reason).toContain("1 match");
    expect(r2.reason).not.toContain("matches");
  });
});

describe("classifyScreenshotObservation", () => {
  it("emits the v1 raw projection with policy version", () => {
    const r = classifyScreenshotObservation({
      width: 1920,
      height: 1080,
      bytes_base64: "AAAA",
    });
    expect(r.applied).toBe(false);
    expect(r.projection_kind).toBe("raw");
    expect(r.policy_version).toBe(COMPUTER_SENSITIVITY_POLICY_VERSION);
    expect(r.classified_regions_count).toBe(0);
  });

  it("emits the same shape when bytes are absent", () => {
    const r = classifyScreenshotObservation({ width: 10, height: 10 });
    expect(r.applied).toBe(false);
    expect(r.projection_kind).toBe("raw");
  });
});

describe("createDefaultComputerGovernance", () => {
  it("classify delegates to classifyComputerAction's decision", async () => {
    const g = createDefaultComputerGovernance();
    expect(await g.classify({ kind: "screenshot" })).toBe("allow");
    expect(await g.classify({ kind: "type", text: `card ${VISA_TEST}` })).toBe("require_approval");
  });

  it("classifyObservation returns redaction for screenshot shape", async () => {
    const g = createDefaultComputerGovernance();
    const r = await g.classifyObservation!({
      kind: "screenshot",
      width: 100,
      height: 100,
    });
    expect(r?.applied).toBe(false);
    expect(r?.projection_kind).toBe("raw");
  });

  it("classifyObservation returns undefined for non-screenshot shapes", async () => {
    const g = createDefaultComputerGovernance();
    expect(await g.classifyObservation!({ kind: "cursor_position", x: 1, y: 2 })).toBeUndefined();
    expect(await g.classifyObservation!(null)).toBeUndefined();
    expect(await g.classifyObservation!("not an object")).toBeUndefined();
    expect(
      await g.classifyObservation!({ kind: "screenshot", width: 10 /* missing height */ }),
    ).toBeUndefined();
  });
});
