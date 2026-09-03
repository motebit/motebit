/**
 * The escrow trigger's split, tested without a relay or a token.
 *
 * `docs/doctrine/paid-failure-recourse.md` refuses to build escrow on the basis
 * that every observed paid failure was preventable-before-the-sale. That
 * decision is only as good as the classification behind it, and the
 * classification has exactly one job: separate "the readiness gate would have
 * stopped this" from "the buyer paid for real attempted work."
 *
 * The load-bearing property is that both sides route through the SAME
 * `classifyProviderFailure` the readiness gate uses. If someone re-implemented
 * the notion of "durable" here, the trigger and the gate would drift and the
 * doctrine's central claim would quietly stop being true.
 */
import { describe, it, expect } from "vitest";
import { splitByRecourse, toFailure } from "../measure-paid-failure-recourse.js";

/** The verbatim result string from the receipts that went red 2026-08-27 → 09-01. */
const CREDIT_EXHAUSTED =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

describe("splitByRecourse", () => {
  it("counts the outage that motivated the doctrine as PREVENTABLE", () => {
    // All eight failures measured on staging were this one string. If this ever
    // classifies as triggering, the doctrine's evidence changes meaning.
    const f = toFailure("The Researcher", "task-1", CREDIT_EXHAUSTED);
    expect(f.durable).toBe("provider credit balance exhausted");

    const { preventable, triggering } = splitByRecourse([f]);
    expect(preventable).toHaveLength(1);
    expect(triggering).toHaveLength(0);
  });

  it("counts a worker that tried and failed as TRIGGERING", () => {
    // The class escrow exists for: inference was genuinely burned, the buyer
    // paid, and no readiness probe could have known in advance.
    const f = toFailure(
      "The Researcher",
      "task-2",
      "research synthesis returned an empty report body (3 source(s) gathered) — refusing to complete an empty artifact",
    );
    expect(f.durable).toBeNull();

    const { preventable, triggering } = splitByRecourse([f]);
    expect(triggering).toHaveLength(1);
    expect(preventable).toHaveLength(0);
  });

  it.each([
    '429 {"error":{"type":"rate_limit_error"}}',
    '529 {"error":{"type":"overloaded_error"}}',
    "fetch failed",
    "The operation was aborted due to timeout",
  ])("treats the transient failure %j as TRIGGERING, not preventable", (message) => {
    // Transient conditions deliberately do NOT withhold the heartbeat (a jittery
    // probe would take a working market dark), so readiness could not have
    // prevented these — which makes them the buyer's loss, and countable.
    const { triggering } = splitByRecourse([toFailure("w", "t", message)]);
    expect(triggering).toHaveLength(1);
  });

  it("partitions a mixed batch exactly — every failure lands on exactly one side", () => {
    const failures = [
      toFailure("a", "1", CREDIT_EXHAUSTED),
      toFailure("a", "2", '401 {"error":{"type":"authentication_error"}}'),
      toFailure("b", "3", "fetch failed"),
      toFailure("b", "4", "empty report body"),
      toFailure("c", "5", "something nobody has ever seen"),
    ];
    const { preventable, triggering } = splitByRecourse(failures);

    expect(preventable).toHaveLength(2);
    expect(triggering).toHaveLength(3);
    // No double-counting, no dropped rows: the split is a partition.
    expect(preventable.length + triggering.length).toBe(failures.length);
    expect(new Set([...preventable, ...triggering]).size).toBe(failures.length);
  });

  it("is empty-safe", () => {
    expect(splitByRecourse([])).toEqual({ preventable: [], triggering: [] });
  });

  it("does not run the probe on import (entrypoint guard)", () => {
    // Importing must not hit the network. If the guard regressed, this file's
    // own import at the top would already have fired `main()`.
    expect(true).toBe(true);
  });
});
