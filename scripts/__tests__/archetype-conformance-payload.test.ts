/**
 * `purchasedPayload` — the probe reads the receipt's VERDICT before its BODY.
 *
 * Regression cover for a six-night staging conformance outage
 * (2026-08-27 → 2026-09-01). The Researcher's Anthropic key ran out of
 * credits; the service did the correct thing and signed an honest `failed`
 * receipt whose `result` was the provider's plain-English sentence. The probe
 * then ran `JSON.parse` on that sentence in three separate places, so six
 * consecutive reds reported only:
 *
 *   ✗ research: atoms paid P2P — Unexpected non-whitespace character after JSON at position 4
 *   ✗ research: routing transcripts verify — Unexpected non-whitespace character after JSON at position 4
 *   ✗ research: result payload — Unexpected non-whitespace character after JSON at position 4
 *
 * Three failures, one cause, and the cause — "Your credit balance is too low"
 * — appeared nowhere. (Position 4 because `400 {"type":…` parses `400` as a
 * complete JSON number and then trips on the `{`. A truthful error message
 * masquerading as a syntax error.)
 *
 * docs/doctrine/gate-repair-instructions.md: a failing gate must emit a repair
 * instruction, not just a symptom — a red has to be self-serviceable from its
 * text alone. These tests hold that property at the probe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { purchasedPayload } from "../archetype-conformance.js";

/** The exact `result` string signed into the receipts that went red, taken
 *  verbatim from the staging relay's stored receipt for task
 *  9cc13cd2-4f78-456a-af0e-80a1a68dff80 (2026-09-01T17:50:30Z). */
const CREDIT_EXHAUSTED_RESULT =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011Ced9FNK1x3E1GK6TW41km"}';

let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("purchasedPayload", () => {
  it("reports a failed receipt as ONE failure carrying the worker's own words", () => {
    const out = purchasedPayload("research", {
      status: "failed",
      result: CREDIT_EXHAUSTED_RESULT,
    });

    expect(out).toBeNull();

    // One line, not three: one root cause reports once.
    expect(logged).toHaveLength(1);
    const line = logged[0]!;

    // The operator-actionable sentence must survive into the probe's output —
    // this is the whole point. Without it the red is not self-serviceable.
    expect(line).toContain("credit balance is too low");

    // ...and the syntax error that replaced it for six nights must not appear.
    expect(line).not.toContain("Unexpected non-whitespace character");
    expect(line).toMatch(/✗/);
  });

  it("returns the parsed payload for a completed receipt", () => {
    const out = purchasedPayload("research", {
      status: "completed",
      result: JSON.stringify({ report: "Findings…", search_count: 2 }),
    });

    expect(out).toEqual({ report: "Findings…", search_count: 2 });
    // A healthy payload is silent — the probe's own checks do the reporting.
    expect(logged).toHaveLength(0);
  });

  it("treats ok:false as a refusal even when status is absent", () => {
    const out = purchasedPayload("clerk", { ok: false, result: "grant expired" });

    expect(out).toBeNull();
    expect(logged[0]).toContain("grant expired");
  });

  it("names an empty result rather than reporting an empty error", () => {
    const out = purchasedPayload("auditor", { status: "failed", result: "" });

    expect(out).toBeNull();
    expect(logged[0]).toContain("(empty result)");
  });

  it("still fails legibly when a COMPLETED receipt carries a non-JSON body", () => {
    // The other half of the hole: a receipt that claims success but whose body
    // does not parse is a producer bug, and the raw bytes are the repair lead.
    const out = purchasedPayload("research", { status: "completed", result: "not json at all" });

    expect(out).toBeNull();
    const line = logged[0]!;
    expect(line).toContain("not JSON");
    expect(line).toContain("not json at all");
    expect(line).toContain("status=completed");
  });

  it("rejects a JSON body that is not an object", () => {
    const out = purchasedPayload("research", { status: "completed", result: "42" });

    expect(out).toBeNull();
    expect(logged[0]).toContain("not a JSON object");
  });

  it("does not run the probe on import (entrypoint guard)", () => {
    // Importing this module must be inert — no network, no process.exit. If the
    // guard regresses, the import at the top of this file would have already
    // fired `main()` and printed the banner.
    expect(logged.join("\n")).not.toContain("archetype-conformance — relay=");
  });
});
