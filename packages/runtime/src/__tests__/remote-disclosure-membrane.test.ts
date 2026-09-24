/**
 * Two membranes at the same boundary, and why they are not one.
 *
 * Text bound for the relay splits by what the person does with it. An
 * approval's arguments are READ TO DECIDE: mask the destination or the
 * amount and there is nothing left to consent to. The return view's
 * result previews are READ AS A REPORT: whole goal output, retrieved
 * from somewhere else, where losing a field costs legibility and
 * keeping one can cost a card number.
 *
 * Running the full set on both — the first attempt at this — rendered
 * a payment approval as a pair of redaction markers and asked someone
 * to approve it. A base58 Solana address is forty-four characters and
 * matches the bare-base64 pattern; $250 in micro-units is `250000000`
 * and matches the SSN pattern.
 */
import { describe, expect, it } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";

function makeRuntime(): MotebitRuntime {
  return new MotebitRuntime(
    { motebitId: "test-mote", tickRateHz: 0 },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
}

describe("redactForRemoteDisclosure — read to DECIDE", () => {
  it("leaves a payment's destination and amount intact", () => {
    // What the deciding person needs, and the reason this seam is
    // narrow. The address is base58 and 44 characters; the amount is a
    // bare nine-digit number.
    const r = makeRuntime();
    const args = '{"to":"9yM2aMEJqGkkqEjAvBQpVvzWrLHhGzYnKpWqRsTuVwXy","amount_micro":250000000}';
    const out = r.redactForRemoteDisclosure(args);
    expect(out).toContain("9yM2aMEJqGkkqEjAvBQpVvzWrLHhGzYnKpWqRsTuVwXy");
    expect(out).toContain("250000000");
  });

  it("still masks a credential that happened to be an argument", () => {
    const r = makeRuntime();
    const fixture = `bearer ${["sk", "live", "NOTAREALKEYJUSTAFIXTURE"].join("_")}`;
    expect(r.redactForRemoteDisclosure(fixture)).not.toContain("NOTAREALKEYJUSTAFIXTURE");
  });
});

describe("redactSourceForRemoteDisclosure — a URL to RE-FETCH", () => {
  it("leaves an ordinary documentation path legible", () => {
    // The credential-class set is keyword-keyed: `API_KEY` matches any
    // long word beginning `key`, `api`, `token` or `secret`, so this
    // path came back as `…/[REDACTED:API_KEY]/v2` and the owner was
    // handed a digest beside a source they cannot see — the exact case
    // the affordance exists to avoid.
    const r = makeRuntime();
    const url = "https://developer.example.com/apidocumentationandreference/v2";
    expect(r.redactSourceForRemoteDisclosure(url)).toBe(url);
  });

  it("leaves a long object key and a numeric document id alone", () => {
    const r = makeRuntime();
    const url = "https://example.gov/edgar/data/320193/000032019324000123-index.htm";
    expect(r.redactSourceForRemoteDisclosure(url)).toBe(url);
  });

  it("masks PII in the QUERY, which the credential sets let through", () => {
    // A statement URL crossed the relay with a social-security number
    // and a card number in the clear: both sets exclude them, for a
    // boundary this is not.
    const r = makeRuntime();
    const out = r.redactSourceForRemoteDisclosure(
      "https://portal.example.com/statement?ssn=123-45-6789&card=4111111111111111",
    );
    expect(out).toContain("https://portal.example.com/statement");
    expect(out).not.toContain("123-45-6789");
    expect(out).not.toContain("4111111111111111");
  });

  it("masks a credential shape wherever it sits", () => {
    const r = makeRuntime();
    const token = ["sk", "live", "NOTAREALKEYJUSTAFIXTURE"].join("_");
    expect(r.redactSourceForRemoteDisclosure(`https://host/x?k=${token}`)).not.toContain(
      "NOTAREALKEYJUSTAFIXTURE",
    );
  });

  it("a ref that is not a URL takes the full set — unparseable is not a licence", () => {
    const r = makeRuntime();
    expect(r.redactSourceForRemoteDisclosure("call-1 filed under 123-45-6789")).not.toContain(
      "123-45-6789",
    );
  });
});

describe("redactReportForRemoteDisclosure — read as a REPORT", () => {
  it("masks a card number, which the decision seam lets through", () => {
    // A nightly goal summarising a bank portal puts this in
    // `response_full`, and the owner opening the run from their phone
    // sends it across the relay.
    const r = makeRuntime();
    const out = r.redactReportForRemoteDisclosure("charged to 4111 1111 1111 1111 last night");
    expect(out).not.toContain("4111 1111 1111 1111");
    expect(out).toContain("[REDACTED:CARD_NUMBER]");
  });

  it("masks an SSN", () => {
    const r = makeRuntime();
    const out = r.redactReportForRemoteDisclosure("filed under 123-45-6789");
    expect(out).not.toContain("123-45-6789");
  });

  it("still masks the credential class the decision seam does", () => {
    // Assembled at runtime: a vendor-shaped literal in a source file
    // trips GitHub's push protection, which is a scanner doing its job
    // on a fixture that only exists to prove ours does too.
    const r = makeRuntime();
    const fixture = `bearer ${["sk", "live", "NOTAREALKEYJUSTAFIXTURE"].join("_")}`;
    expect(r.redactReportForRemoteDisclosure(fixture)).not.toContain("NOTAREALKEYJUSTAFIXTURE");
  });

  it("leaves ordinary prose alone", () => {
    const r = makeRuntime();
    const text = "Reviewed three filings and found nothing that needs you.";
    expect(r.redactReportForRemoteDisclosure(text)).toBe(text);
  });
});
