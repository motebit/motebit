import { describe, it, expect } from "vitest";
import { RedactionEngine } from "../redaction.js";
import { PolicyGate } from "../policy-gate.js";

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

/**
 * A retrieved SOURCE — a URL an owner is told to re-fetch and hash.
 *
 * The third kind of text at a non-sovereign boundary, and it needed its
 * own membrane because the other two are each wrong for it in opposite
 * directions: the keyword-keyed credential set erases ordinary
 * documentation paths, and every credential set lets an account number
 * in a query string through. The split is where the risk splits — a
 * path is structure written by someone else, a query is data.
 */
describe("RedactionEngine.redactRetrievedSource", () => {
  const engine = new RedactionEngine();

  it("leaves a path that merely READS like a credential alone", () => {
    // `API_KEY` matches any long word beginning `key`, `api`, `token`
    // or `secret`, so this came back as `…/[REDACTED:API_KEY]/v2` and
    // the digest beside it pointed at a source nobody could see.
    const url = "https://developer.example.com/apidocumentationandreference/v2";
    expect(engine.redactRetrievedSource(url)).toBe(url);
  });

  it("leaves a long object key and a numeric document id alone", () => {
    // The full set would call the first base64 and the second an SSN.
    const url = "https://example.gov/edgar/data/320193/000032019324000123-index.htm";
    expect(engine.redactRetrievedSource(url)).toBe(url);
  });

  it("masks PII in the query, which every credential set excludes", () => {
    const out = engine.redactRetrievedSource(
      "https://portal.example.com/statement?ssn=123-45-6789&card=4111111111111111",
    );
    expect(out).toContain("https://portal.example.com/statement");
    expect(out).not.toContain("123-45-6789");
    expect(out).not.toContain("4111111111111111");
  });

  it("masks a credential shape in the query", () => {
    const token = ["sk", "live", "NOTAREALKEYJUSTAFIXTURE"].join("_");
    const out = engine.redactRetrievedSource(`https://host/x?k=${token}`);
    expect(out).not.toContain("NOTAREALKEYJUSTAFIXTURE");
    expect(out).toContain("https://host/x");
  });

  it("masks a credential shape in the PATH too — shape survives position", () => {
    const token = ["sk", "live", "NOTAREALKEYJUSTAFIXTURE"].join("_");
    expect(engine.redactRetrievedSource(`https://host/${token}/doc`)).not.toContain(
      "NOTAREALKEYJUSTAFIXTURE",
    );
  });

  it("takes the FULL set when the ref is not a URL — unparseable is not a licence", () => {
    // The evidence producer falls back to the call id when a tool named
    // no source, so this shape does reach here.
    expect(engine.redactRetrievedSource("call-1 filed under 123-45-6789")).not.toContain(
      "123-45-6789",
    );
  });

  it("keeps a non-http scheme's host intact — `url.origin` would erase it", () => {
    // `origin` is the literal "null" for every non-special scheme, so
    // reassembling from URL parts dropped the bucket and the host from
    // the one string the owner is told to re-fetch.
    expect(engine.redactRetrievedSource("s3://reports/q3.csv")).toBe("s3://reports/q3.csv");
    expect(engine.redactRetrievedSource("file:///Users/d/report.txt")).toBe(
      "file:///Users/d/report.txt",
    );
  });

  it("keeps userinfo visible rather than swallowing it silently", () => {
    // Reassembly dropped `user:tok@` with no marker, so the displayed
    // ref differed from the recorded one and said nothing about it. A
    // credential-SHAPED password is still masked by the shape set; an
    // ordinary username is not a secret and stays readable.
    const out = engine.redactRetrievedSource("https://alice@example.gov/filing");
    expect(out).toContain("alice@example.gov");
  });

  it("keeps a URL with no query byte-identical", () => {
    const url = "https://example.gov/filing";
    expect(engine.redactRetrievedSource(url)).toBe(url);
  });
});

/**
 * The gate's three redaction doors, exercised where they live.
 *
 * Thin delegations, and thin is exactly why they went untested: the
 * runtime's own tests reach them through a real gate, so the wiring is
 * covered in a package that is not this one. A delegation wired to the
 * wrong engine method is a silent widening or narrowing of a membrane,
 * which is the class this whole arc kept finding.
 */
describe("PolicyGate — the three redaction doors", () => {
  const gate = new PolicyGate();

  it("`redact` is the full set", () => {
    expect(gate.redact("my ssn is 123-45-6789")).toContain("[REDACTED:SSN]");
  });

  it("`redactForCloudEgress` is the narrow credential set — it keeps the decision", () => {
    // A payment approval's destination and amount must survive it.
    const args = '{"to":"9yM2aMEJqGkkqEjAvBQpVvzWrLHhGzYnKpWqRsTuVwXy","amount_micro":250000000}';
    expect(gate.redactForCloudEgress(args).text).toBe(args);
  });

  it("`redactRetrievedSource` keeps a path and masks a query", () => {
    expect(gate.redactRetrievedSource("https://example.gov/filing")).toBe(
      "https://example.gov/filing",
    );
    expect(gate.redactRetrievedSource("https://host/x?ssn=123-45-6789")).not.toContain(
      "123-45-6789",
    );
  });
});
