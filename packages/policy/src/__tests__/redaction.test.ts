import { describe, it, expect } from "vitest";
import { RedactionEngine } from "../redaction.js";

describe("RedactionEngine.redactForCloudEgress — credential-class only", () => {
  const engine = new RedactionEngine();
  const out = (s: string) => engine.redactForCloudEgress(s).text;

  it("redacts the high-precision credential-class secrets", () => {
    const cases: [string, string][] = [
      ["my key is sk-abc123def456ghi789jklmno here", "API_KEY"],
      ["creds AKIAIOSFODNN7EXAMPLE rotated", "AWS_KEY"],
      [
        "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N4",
        "JWT",
      ],
      ["db at postgres://user:pass@host:5432/mydb please", "CONNECTION_STRING"],
      ["password = hunter2longenoughvalue", "PASSWORD"],
    ];
    for (const [input, label] of cases) {
      expect(out(input)).toContain(`[REDACTED:${label}]`);
    }
  });

  it("does NOT redact SSN, card numbers, or bare base64 (financial/PII/legit-use stay user-controlled)", () => {
    expect(out("my ssn is 123-45-6789")).toContain("123-45-6789");
    expect(out("charge card 4111 1111 1111 1111 please")).toContain("4111");
    // A long base64 blob the user legitimately wants the cloud model to decode.
    const b64 = "QmFzZTY0IGVuY29kZWQgY29udGVudCB0aGF0IGlzIGVudGlyZWx5IGxlZ2l0aW1hdGUu";
    expect(out(`decode this for me: ${b64}`)).toContain(b64);
  });

  it("leaves clean prose untouched", () => {
    const clean = "Help me write a calm poem about the ocean at dawn.";
    expect(out(clean)).toBe(clean);
  });

  it("the FULL redact() still masks everything incl. SSN + cards (storage/memory/tool-result path unchanged)", () => {
    expect(engine.redact("my ssn is 123-45-6789").text).toContain("[REDACTED:SSN]");
    expect(engine.redact("card 4111111111111111").text).toContain("[REDACTED:CARD_NUMBER]");
  });
});
