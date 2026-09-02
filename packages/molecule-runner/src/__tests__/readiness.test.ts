/**
 * Provider readiness — the safety property under test is asymmetric.
 *
 * A false NEGATIVE (failing to notice a dead provider) costs what #593 cost:
 * an agent that keeps advertising `awake`, keeps taking paid delegations, and
 * sells signed refusals whose payment does not come back (#610).
 *
 * A false POSITIVE (withholding heartbeats on a healthy agent) is worse — it
 * takes a working agent off the market for a transient blip. So the majority of
 * these tests pin the TRANSIENT side: rate limits, overload, 5xx, timeouts and
 * anything unrecognized must keep the agent advertising.
 */
import { describe, it, expect, vi } from "vitest";
import { createProviderReadiness, classifyProviderFailure } from "../readiness.js";

/** The verbatim result string from the receipt that went red on 2026-09-01. */
const CREDIT_EXHAUSTED =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011Ced9FNK1x3E1GK6TW41km"}';

describe("classifyProviderFailure", () => {
  it("recognizes the exact error that caused the six-night outage", () => {
    expect(classifyProviderFailure(CREDIT_EXHAUSTED)).toBe("provider credit balance exhausted");
  });

  it.each([
    ['401 {"type":"error","error":{"type":"authentication_error"}}', "provider key rejected"],
    ["invalid x-api-key", "provider key rejected"],
    ['403 {"error":{"type":"permission_error"}}', "provider access revoked"],
    ["insufficient_quota", "provider quota exhausted"],
    ["402 Payment Required", "provider billing problem"],
  ])("treats %s as durable", (message, reason) => {
    expect(classifyProviderFailure(message)).toBe(reason);
  });

  it.each([
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}',
    '529 {"type":"error","error":{"type":"overloaded_error"}}',
    "500 Internal Server Error",
    "fetch failed",
    "The operation was aborted due to timeout",
    "socket hang up",
    "ECONNRESET",
    "empty report body — refusing to sign a completed receipt over an empty artifact",
    "something nobody has ever seen before",
  ])("treats %s as transient", (message) => {
    expect(classifyProviderFailure(message)).toBeNull();
  });

  it("keeps a rate limit transient even when its body says 'quota exceeded'", () => {
    // The dangerous overlap: a 429 body can carry durable-sounding words. Rate
    // limiting means "try later", never "stop advertising", so it must win.
    expect(
      classifyProviderFailure(
        '429 {"error":{"type":"rate_limit_error","message":"quota exceeded for this minute"}}',
      ),
    ).toBeNull();
  });
});

describe("createProviderReadiness", () => {
  const neverProbe = () => Promise.reject(new Error("probe must not be called"));

  it("is ready before anything has happened", async () => {
    const r = createProviderReadiness({ probe: neverProbe });
    expect(await r.check()).toEqual({ ready: true });
  });

  it("does not probe at all while healthy — the healthy path is free", async () => {
    const probe = vi.fn(() => Promise.resolve(true));
    const r = createProviderReadiness({ probe });
    r.recordFailure("429 rate_limit_error");
    r.recordSuccess();
    await r.check();
    await r.check();
    expect(probe).not.toHaveBeenCalled();
  });

  it("goes dark on a durable failure, naming the reason", async () => {
    const r = createProviderReadiness({ probe: () => Promise.resolve(false) });
    r.recordFailure(CREDIT_EXHAUSTED);
    expect(await r.check()).toEqual({
      ready: false,
      reason: "provider credit balance exhausted",
    });
  });

  it("stays advertising through transient failures, however many", async () => {
    const r = createProviderReadiness({ probe: neverProbe });
    for (let i = 0; i < 50; i++) {
      r.recordFailure("529 overloaded_error");
      r.recordFailure("fetch failed");
    }
    expect(await r.check()).toEqual({ ready: true });
  });

  it("recovers when the probe says the provider answers again", async () => {
    let healthy = false;
    let clock = 0;
    const r = createProviderReadiness({
      probe: () => Promise.resolve(healthy),
      now: () => clock,
      recheckAfterMs: 1000,
    });

    r.recordFailure(CREDIT_EXHAUSTED);
    expect((await r.check()).ready).toBe(false);

    healthy = true;
    clock += 1000;
    expect(await r.check()).toEqual({ ready: true });
  });

  it("recovers on a successful task without any probe", async () => {
    // Real work completing is stronger evidence than a synthetic round-trip.
    const r = createProviderReadiness({ probe: neverProbe });
    r.recordFailure(CREDIT_EXHAUSTED);
    expect((await r.check()).ready).toBe(false);
    r.recordSuccess();
    expect(await r.check()).toEqual({ ready: true });
  });

  it("rate-limits the recovery probe", async () => {
    let clock = 0;
    const probe = vi.fn(() => Promise.resolve(false));
    const r = createProviderReadiness({ probe, now: () => clock, recheckAfterMs: 60_000 });

    r.recordFailure(CREDIT_EXHAUSTED);
    await r.check();
    expect(probe).toHaveBeenCalledTimes(1);

    clock += 59_000;
    await r.check();
    expect(probe).toHaveBeenCalledTimes(1); // too soon

    clock += 2_000;
    await r.check();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("stays dark, not stuck-ready, when the recovery probe throws", async () => {
    const r = createProviderReadiness({
      probe: () => Promise.reject(new Error("network down")),
    });
    r.recordFailure(CREDIT_EXHAUSTED);
    expect((await r.check()).ready).toBe(false);
  });

  it("cannot latch dark forever — recovery is always reachable", async () => {
    // The failure mode the active probe exists to prevent: once dark, no tasks
    // arrive, so passive evidence alone would never return.
    let clock = 0;
    let healthy = false;
    const r = createProviderReadiness({
      probe: () => Promise.resolve(healthy),
      now: () => clock,
      recheckAfterMs: 1000,
    });
    r.recordFailure(CREDIT_EXHAUSTED);

    for (let i = 0; i < 10; i++) {
      clock += 1000;
      expect((await r.check()).ready).toBe(false);
    }

    healthy = true;
    clock += 1000;
    expect((await r.check()).ready).toBe(true);
  });
});
