/**
 * Grant pre-flight — the refusal that teaches, applied to the product.
 * Each check mirrors a REAL silent boundary from the first-metered-dollar
 * ceremony (2026-07-06/07); the suite pins that every blocker carries a
 * remedy (the repair-instruction contract) and that the pre-flight is
 * advisory (it never throws, never blocks).
 *
 * The relay-pin check reads no file and makes no request: it is given the
 * answer the session already has for its relay (`resolveRelayKey`), so these
 * tests pass that answer and seed nothing.
 */
import { describe, it, expect } from "vitest";
import { preflightGrant, renderPreflight } from "../grant-preflight.js";
import type { RelayKeyResolution, SessionRelayKey } from "../relay-pins.js";
import type { StoredGrant } from "../subcommands/grant.js";
import { SYNC_OPT_IN_HINT } from "../sync-opt-in.js";

const NOW = 1_783_400_000_000;
const HOUR = 3_600_000;
const RELAY = "https://relay.example";
const KEY = "11c266f2749a00aa".repeat(4);

function stored(overrides: Partial<StoredGrant> = {}): StoredGrant {
  return {
    grant: {
      grant_id: "019f0000-0000-7000-8000-000000000000",
      scope: "delegate_to_agent",
      expires_at: NOW + 7 * 24 * HOUR,
    },
    ticks: [{ issued_at: NOW - HOUR, not_before: NOW - HOUR, expires_at: NOW + HOUR }],
    ...overrides,
  } as never;
}

const ARMED_CONFIG = { governance: { approvalPreset: "autonomous" } } as never;

/** The session has a key for its relay. */
const PINNED: RelayKeyResolution = { status: "key", relayUrl: RELAY, key: KEY, origin: "recorded" };
/** The session has no key for its relay: none was ever pinned. */
const NOT_PINNED: RelayKeyResolution = { status: "no_key", relayUrl: RELAY, reason: "not_pinned" };
/** The session names no relay. */
const NO_RELAY: SessionRelayKey = { status: "no_relay" };

describe("preflightGrant", () => {
  it("all-green chain reports armed", async () => {
    const pf = await preflightGrant({
      stored: stored(),
      now: NOW,
      fullConfig: ARMED_CONFIG,
      hasRail: true,
      relayKey: PINNED,
      getBalanceMicro: async () => 1_578_590n,
    });
    expect(pf.armed).toBe(true);
    expect(pf.checks.every((c) => c.ok)).toBe(true);
    const [line] = renderPreflight(pf, (s) => s);
    expect(line).toContain("grant armed");
  });

  it("every blocker carries a remedy — the repair-instruction contract", async () => {
    const pf = await preflightGrant({
      stored: stored({ ticks: [] }), // no tick
      now: NOW,
      fullConfig: { governance: { approvalPreset: "balanced" } } as never, // denies R4
      hasRail: false, // no rail
      relayKey: NOT_PINNED, // no pin
      getBalanceMicro: async () => 0n, // unfunded
    });
    expect(pf.armed).toBe(false);
    const failing = pf.checks.filter((c) => !c.ok);
    expect(failing.length).toBeGreaterThanOrEqual(4);
    for (const c of failing) {
      expect(c.remedy, `check "${c.name}" must teach its remedy`).toBeTruthy();
    }
    const lines = renderPreflight(pf, (s) => s).join("\n");
    expect(lines).toContain("NOT armed");
    expect(lines).toContain("autonomous"); // the exact governance fix
    expect(lines).toContain("motebit register"); // the exact pin fix
  });

  it("balanced preset is named as the R4 blocker (the ceremony's silent boundary)", async () => {
    const pf = await preflightGrant({
      stored: stored(),
      now: NOW,
      fullConfig: { governance: { approvalPreset: "balanced" } } as never,
      hasRail: true,
      relayKey: PINNED,
    });
    const gov = pf.checks.find((c) => c.name === "governance")!;
    expect(gov.ok).toBe(false);
    expect(gov.remedy).toContain("hard ceiling");
  });

  it("undue tick names the unlock time — the schedule is the cadence", async () => {
    const pf = await preflightGrant({
      stored: stored({
        ticks: [{ issued_at: NOW, not_before: NOW + HOUR, expires_at: NOW + 2 * HOUR }],
      } as never),
      now: NOW,
      fullConfig: ARMED_CONFIG,
      hasRail: true,
      relayKey: PINNED,
    });
    const tick = pf.checks.find((c) => c.name === "tick")!;
    expect(tick.ok).toBe(false);
    expect(tick.remedy).toContain("next tick unlocks");
  });

  it("revoked grant is terminal and says so", async () => {
    const pf = await preflightGrant({
      stored: stored({ revocation: { revoked_at: NOW } } as never),
      now: NOW,
      fullConfig: ARMED_CONFIG,
      hasRail: true,
      relayKey: PINNED,
    });
    const g = pf.checks.find((c) => c.name === "grant")!;
    expect(g.ok).toBe(false);
    expect(g.detail).toContain("REVOKED");
    expect(g.remedy).toContain("terminal");
  });

  it("RPC failure on the balance check soft-passes — advisory, never blocking", async () => {
    const pf = await preflightGrant({
      stored: stored(),
      now: NOW,
      fullConfig: ARMED_CONFIG,
      hasRail: true,
      relayKey: PINNED,
      getBalanceMicro: async () => {
        throw new Error("rpc down");
      },
    });
    expect(pf.armed).toBe(true);
    expect(pf.checks.find((c) => c.name === "wallet")!.detail).toContain("meter still bounds");
  });
});

describe("preflightGrant — the relay-pin check is the session's one answer", () => {
  const run = (relayKey: SessionRelayKey, fullConfig: unknown = ARMED_CONFIG) =>
    preflightGrant({
      stored: stored(),
      now: NOW,
      fullConfig: fullConfig as never,
      hasRail: true,
      relayKey,
      relaySource: "the saved config (`sync_url`)",
    });

  it("test 13: given a key, the check passes and shows it", async () => {
    const pf = await run(PINNED);
    const pin = pf.checks.find((c) => c.name === "relay-pin")!;
    expect(pin.ok).toBe(true);
    expect(pin.detail).toBe(`relay key pinned (${KEY.slice(0, 12)}…)`);
    expect(pf.armed).toBe(true);
  });

  it("test 13: given a no-key result, the check fails naming the relay and that result's remedy", async () => {
    const pf = await run(NOT_PINNED);
    const pin = pf.checks.find((c) => c.name === "relay-pin")!;
    expect(pin.ok).toBe(false);
    expect(pin.detail).toContain(RELAY);
    expect(pin.remedy).toBe(
      `No relay key is pinned. Run \`motebit register --sync-url ${RELAY}\`.`,
    );
    expect(pf.armed).toBe(false);

    const mismatch = await run({
      status: "no_key",
      relayUrl: RELAY,
      reason: "no_key",
      check: "endpoint_mismatch",
      signedPinKey: "https://real.example",
    });
    const pin2 = mismatch.checks.find((c) => c.name === "relay-pin")!;
    expect(pin2.ok).toBe(false);
    expect(pin2.remedy).toContain("This relay signs `https://real.example`");
    expect(pin2.remedy).toContain("the saved config (`sync_url`)");
  });

  it("the legacy relay_public_key in config.json is never a fallback: no key for this relay fails even when it is set", async () => {
    const pf = await run(NOT_PINNED, {
      governance: { approvalPreset: "autonomous" },
      relay_public_key: KEY,
    });
    expect(pf.checks.find((c) => c.name === "relay-pin")!.ok).toBe(false);
    expect(pf.armed).toBe(false);
  });

  it("test 11a: with no relay named, the check fails and says relay sync is off", async () => {
    const pf = await run(NO_RELAY, {
      governance: { approvalPreset: "autonomous" },
      relay_public_key: KEY, // main reported this as "pinned"
    });
    const pin = pf.checks.find((c) => c.name === "relay-pin")!;
    expect(pin.ok).toBe(false);
    expect(pin.detail).toContain("relay sync is off");
    expect(pin.remedy).toBe(SYNC_OPT_IN_HINT);
    expect(pf.armed).toBe(false);
    expect(renderPreflight(pf, (s) => s).join("\n")).toContain("relay sync is off");
  });
});
