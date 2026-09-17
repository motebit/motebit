/**
 * The membrane at a NON-SOVEREIGN boundary.
 *
 * `redactForRemoteDisclosure` masks text bound for the relay — approval
 * arguments, and the return view's result previews and error reasons.
 * It ran the cloud-egress SUBSET, which deliberately leaves SSNs, card
 * numbers and bare base64 alone. That carve-out is reasoned about a
 * user's own typed message to a model they chose: detail they often
 * mean the model to use. None of that reasoning survives the move to
 * this boundary, where the text is a goal's retrieved output and the
 * reader is a relay operator the sovereign did not choose, and where
 * fail-closed privacy says financial and medical never cross.
 */
import { describe, expect, it } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";

function makeRuntime(): MotebitRuntime {
  return new MotebitRuntime(
    { motebitId: "test-mote", tickRateHz: 0 },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
}

describe("redactForRemoteDisclosure", () => {
  it("masks a card number, which the cloud-egress subset lets through", () => {
    // A nightly goal summarising a bank portal puts this in
    // `response_full`, and the owner opening the run from their phone
    // sends it across the relay.
    const r = makeRuntime();
    const out = r.redactForRemoteDisclosure("charged to 4111 1111 1111 1111 last night");
    expect(out).not.toContain("4111 1111 1111 1111");
    expect(out).toContain("[REDACTED:CARD_NUMBER]");
  });

  it("masks an SSN", () => {
    const r = makeRuntime();
    const out = r.redactForRemoteDisclosure("filed under 123-45-6789");
    expect(out).not.toContain("123-45-6789");
  });

  it("still masks the credential class it always did", () => {
    // Assembled at runtime: a vendor-shaped literal in a source file
    // trips GitHub's push protection, which is a scanner doing its job
    // on a fixture that only exists to prove ours does too.
    const r = makeRuntime();
    const fixture = `bearer ${["sk", "live", "NOTAREALKEYJUSTAFIXTURE"].join("_")}`;
    const out = r.redactForRemoteDisclosure(fixture);
    expect(out).not.toContain("NOTAREALKEYJUSTAFIXTURE");
  });

  it("leaves ordinary prose alone", () => {
    const r = makeRuntime();
    const text = "Reviewed three filings and found nothing that needs you.";
    expect(r.redactForRemoteDisclosure(text)).toBe(text);
  });
});
