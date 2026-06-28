/**
 * Adversarial suite for the grant blast-radius enforcer — the proof that the vault
 * holds. Each test is a named attack from the threat analysis in
 * `docs/doctrine/verify-family-fail-closed.md` §"Offline revocation freshness" and
 * the principal audit of the implementation plan.
 *
 * Scope (honest): these exercise the TRUSTED-RUNTIME guarantees only — the
 * cumulative/window/lifetime/action/nonce ceilings against an honest-but-fallible
 * runtime (bugs, runaway loops, injection short of key-compromise) and the
 * decomposition race. They do NOT and cannot prove the offline guarantee (a
 * key/store-compromised delegate controls its own accumulator); that floor is
 * grant-expiry + counterparty + onchain caps, and the revoke-then-deny COMPOSITION
 * (verifier ∧ enforcer) is an Increment-2 test in the runtime, where the crypto
 * verifier and this enforcer meet. The nonce tests here prove the dedupe MECHANISM;
 * replay-of-a-signed-token binds when the nonce is the token's signed sequence (Inc 2).
 */
import { describe, it, expect } from "vitest";
import {
  evaluateBlastRadius,
  freshGrantSpendState,
  canonicalizeCounterparty,
  InMemoryGrantSpendStore,
  type GrantSpendCeiling,
  type GrantSpendState,
  type MoneyAction,
} from "../grant-blast-radius";

const M = 1_000_000; // 1 USD in micro-units
const GID = "grant-1";
const PAYEE = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpZHY5e7pump"; // base58-ish
const T0 = 1_000_000_000;

const act = (usd: number, counterparty = PAYEE): MoneyAction => ({
  amount_micro: usd * M,
  counterparty,
});

/** Drive a sequence of actions through the pure evaluator, threading state. */
function runSeq(
  ceiling: GrantSpendCeiling,
  actions: Array<{ a: MoneyAction; nonce: number; now?: number }>,
  start?: GrantSpendState,
) {
  let state = start ?? freshGrantSpendState(GID, T0);
  const decisions = actions.map(({ a, nonce, now }) => {
    const ev = evaluateBlastRadius(ceiling, state, a, nonce, now ?? T0);
    if (ev.decision.allowed && ev.nextState) state = ev.nextState;
    return ev.decision;
  });
  return { decisions, state };
}

describe("grant blast-radius — fail-closed defaults", () => {
  it("absent total bound ⇒ deny (a money grant authorizes nothing without a cap)", () => {
    expect(evaluateBlastRadius({}, freshGrantSpendState(GID, T0), act(1), 0, T0).decision).toEqual({
      allowed: false,
      denial: "ceiling_absent",
    });
    // per-counterparty / action-count alone do NOT bound total value → still denied.
    const noTotal: GrantSpendCeiling = { per_counterparty_limit_micro: 10 * M, window_ms: 1000 };
    expect(
      evaluateBlastRadius(noTotal, freshGrantSpendState(GID, T0), act(1), 0, T0).decision.denial,
    ).toBe("ceiling_absent");
  });

  it("a present limit of 0 is deny-all on that dimension, not allow-all", () => {
    const zero: GrantSpendCeiling = { cumulative_limit_micro: 0, window_ms: 1000 };
    expect(
      evaluateBlastRadius(zero, freshGrantSpendState(GID, T0), act(1), 0, T0).decision.denial,
    ).toBe("cumulative_exceeded");
    const zeroLife: GrantSpendCeiling = { lifetime_limit_micro: 0 };
    expect(
      evaluateBlastRadius(zeroLife, freshGrantSpendState(GID, T0), act(1), 0, T0).decision.denial,
    ).toBe("lifetime_exceeded");
  });

  it("a per-window limit with window_ms ≤ 0 is rejected (no roll math)", () => {
    for (const window_ms of [0, -1]) {
      const c: GrantSpendCeiling = { cumulative_limit_micro: 100 * M, window_ms };
      expect(
        evaluateBlastRadius(c, freshGrantSpendState(GID, T0), act(1), 0, T0).decision.denial,
      ).toBe("invalid_window");
    }
  });
});

describe("grant blast-radius — amount validation (the refund/overflow bypass)", () => {
  const c: GrantSpendCeiling = { cumulative_limit_micro: 100 * M, window_ms: 1000 };
  it("negative, zero, NaN, Infinity, and non-integer amounts are denied", () => {
    for (const bad of [-1 * M, 0, NaN, Infinity, -Infinity, 1.5]) {
      const a: MoneyAction = { amount_micro: bad, counterparty: PAYEE };
      expect(evaluateBlastRadius(c, freshGrantSpendState(GID, T0), a, 0, T0).decision.denial).toBe(
        "invalid_amount",
      );
    }
  });
  it("a sum that would exceed MAX_SAFE_INTEGER is denied (overflow)", () => {
    const huge: GrantSpendCeiling = { lifetime_limit_micro: Number.MAX_SAFE_INTEGER };
    const state: GrantSpendState = {
      ...freshGrantSpendState(GID, T0),
      lifetime_spent_micro: Number.MAX_SAFE_INTEGER - 10,
    };
    const a: MoneyAction = { amount_micro: 100, counterparty: PAYEE };
    expect(evaluateBlastRadius(huge, state, a, 0, T0).decision.denial).toBe("invalid_amount");
  });
});

describe("grant blast-radius — the decomposition attack", () => {
  it("N individually-small spends are denied at the one that crosses the cumulative cap", () => {
    // Per-turn value ($10) always passes a per-turn check; the cumulative window ($100) blocks the 11th.
    const c: GrantSpendCeiling = { cumulative_limit_micro: 100 * M, window_ms: 60_000 };
    const actions = Array.from({ length: 12 }, (_, i) => ({ a: act(10), nonce: i }));
    const { decisions } = runSeq(c, actions);
    const allowed = decisions.filter((d) => d.allowed).length;
    expect(allowed).toBe(10); // $10 × 10 = $100 exactly
    expect(decisions[10]!.denial).toBe("cumulative_exceeded"); // the 11th ($110) crosses
    expect(decisions[11]!.denial).toBe("cumulative_exceeded");
  });

  it("the grant-lifetime cap bounds total spend across MANY windows (the real total bound)", () => {
    // $50/window but $120 lifetime: window rolls let cumulative reset, lifetime does not.
    const c: GrantSpendCeiling = {
      cumulative_limit_micro: 50 * M,
      lifetime_limit_micro: 120 * M,
      window_ms: 1000,
    };
    // Three windows, $50 each = $150 attempted; lifetime caps at $120.
    const actions = [
      { a: act(50), nonce: 0, now: T0 },
      { a: act(50), nonce: 1, now: T0 + 1000 }, // window 2
      { a: act(50), nonce: 2, now: T0 + 2000 }, // window 3 — would be $150 lifetime
    ];
    const { decisions, state } = runSeq(c, actions);
    expect(decisions[0]!.allowed).toBe(true);
    expect(decisions[1]!.allowed).toBe(true);
    expect(decisions[2]!.denial).toBe("lifetime_exceeded"); // $100 + $50 > $120
    expect(state.lifetime_spent_micro).toBe(100 * M);
  });
});

describe("grant blast-radius — window roll & boundary gaming", () => {
  it("the cumulative window resets after window_ms; lifetime persists", () => {
    const c: GrantSpendCeiling = { cumulative_limit_micro: 100 * M, window_ms: 1000 };
    const { decisions, state } = runSeq(c, [
      { a: act(100), nonce: 0, now: T0 },
      { a: act(100), nonce: 1, now: T0 + 1000 }, // new window → allowed again
    ]);
    expect(decisions.every((d) => d.allowed)).toBe(true);
    expect(state.window_spent_micro).toBe(100 * M); // reset then refilled
  });

  it("documents the 2×-at-boundary property — and the lifetime cap is the real bound", () => {
    // Full window at end of W1 + full window at start of W2 = 2× the window cap in seconds.
    // This is intrinsic to tumbling windows; the LIFETIME cap is what actually bounds it.
    const noLife: GrantSpendCeiling = { cumulative_limit_micro: 100 * M, window_ms: 1000 };
    const boundary = runSeq(noLife, [
      { a: act(100), nonce: 0, now: T0 + 999 }, // end of window 1
      { a: act(100), nonce: 1, now: T0 + 1000 }, // start of window 2
    ]);
    expect(boundary.decisions.every((d) => d.allowed)).toBe(true); // 2× passes without a lifetime cap

    const withLife: GrantSpendCeiling = { ...noLife, lifetime_limit_micro: 150 * M };
    const bounded = runSeq(withLife, [
      { a: act(100), nonce: 0, now: T0 + 999 },
      { a: act(100), nonce: 1, now: T0 + 1000 },
    ]);
    expect(bounded.decisions[1]!.denial).toBe("lifetime_exceeded"); // lifetime catches the boundary game
  });

  it("a rolled-back clock never resets the window (no headroom widening)", () => {
    const c: GrantSpendCeiling = { cumulative_limit_micro: 100 * M, window_ms: 1000 };
    const { decisions } = runSeq(c, [
      { a: act(100), nonce: 0, now: T0 + 500 },
      { a: act(50), nonce: 1, now: T0 - 10_000 }, // clock jumps backward — must NOT reset
    ]);
    expect(decisions[0]!.allowed).toBe(true);
    expect(decisions[1]!.denial).toBe("cumulative_exceeded"); // window not reset → $150 > $100
  });
});

describe("grant blast-radius — nonce dedupe mechanism", () => {
  it("a nonce ≤ the high-water mark is denied (monotonic)", () => {
    const c: GrantSpendCeiling = { lifetime_limit_micro: 100 * M };
    const { decisions } = runSeq(c, [
      { a: act(1), nonce: 5 },
      { a: act(1), nonce: 5 }, // replay of same nonce
      { a: act(1), nonce: 3 }, // older nonce
      { a: act(1), nonce: 6 }, // strictly newer → ok
    ]);
    expect(decisions[0]!.allowed).toBe(true);
    expect(decisions[1]!.denial).toBe("replay");
    expect(decisions[2]!.denial).toBe("replay");
    expect(decisions[3]!.allowed).toBe(true);
  });
});

describe("grant blast-radius — per-counterparty cap & address canonicalization", () => {
  it("EVM hex encoding variants of one payee collapse to a single bucket", () => {
    const a = "0xAbCdEf0000000000000000000000000000000001";
    const variants = [a.toLowerCase(), a.toUpperCase().replace("0X", "0x"), a, `  ${a}  `];
    const canon = variants.map(canonicalizeCounterparty);
    expect(new Set(canon).size).toBe(1); // all one canonical key

    // Spend $60 to the payee in two encodings against a $100 per-counterparty cap → the 2nd ($120) denied.
    const c: GrantSpendCeiling = {
      cumulative_limit_micro: 1000 * M,
      per_counterparty_limit_micro: 100 * M,
      window_ms: 60_000,
    };
    const { decisions } = runSeq(c, [
      { a: act(60, variants[0]!), nonce: 0 },
      { a: act(60, variants[2]!), nonce: 1 }, // same payee, different encoding
    ]);
    expect(decisions[0]!.allowed).toBe(true);
    expect(decisions[1]!.denial).toBe("per_counterparty_exceeded"); // canonicalized → one bucket
  });

  it("base58 (case-sensitive) addresses are NOT lowercased; distinct payees stay distinct", () => {
    const c: GrantSpendCeiling = {
      cumulative_limit_micro: 1000 * M,
      per_counterparty_limit_micro: 100 * M,
      window_ms: 60_000,
    };
    const { decisions } = runSeq(c, [
      { a: act(60, "AbcPayee111"), nonce: 0 },
      { a: act(60, "abcPayee111"), nonce: 1 }, // different base58 case = different address
    ]);
    expect(decisions.every((d) => d.allowed)).toBe(true); // two distinct buckets, each under $100
  });

  it("an unparseable destination is denied", () => {
    const c: GrantSpendCeiling = { lifetime_limit_micro: 100 * M };
    const a: MoneyAction = { amount_micro: 1 * M, counterparty: "   " };
    expect(evaluateBlastRadius(c, freshGrantSpendState(GID, T0), a, 0, T0).decision.denial).toBe(
      "invalid_counterparty",
    );
  });

  it("action-count cap bounds the number of moves per window", () => {
    const c: GrantSpendCeiling = {
      cumulative_limit_micro: 1000 * M,
      max_action_count: 2,
      window_ms: 60_000,
    };
    const { decisions } = runSeq(c, [
      { a: act(1), nonce: 0 },
      { a: act(1), nonce: 1 },
      { a: act(1), nonce: 2 }, // 3rd action in the window
    ]);
    expect(decisions[2]!.denial).toBe("action_count_exceeded");
  });
});

describe("grant blast-radius — atomic store (the decomposition RACE)", () => {
  it("two concurrent tryConsume that each pass the read cannot both commit", async () => {
    const store = new InMemoryGrantSpendStore();
    const c: GrantSpendCeiling = { cumulative_limit_micro: 100 * M, window_ms: 60_000 };
    // Each is $60; either alone fits ($60 ≤ $100), but together ($120) must not both pass.
    const [d1, d2] = await Promise.all([
      store.tryConsume({ grant_id: GID, ceiling: c, action: act(60), nonce: 0, now: T0 }),
      store.tryConsume({ grant_id: GID, ceiling: c, action: act(60), nonce: 1, now: T0 }),
    ]);
    const allowed = [d1, d2].filter((d) => d.allowed).length;
    expect(allowed).toBe(1); // exactly one commits; the other sees the committed spend
    expect(store.peek(GID)!.window_spent_micro).toBe(60 * M);
  });

  it("the store rejects a replayed nonce across calls", async () => {
    const store = new InMemoryGrantSpendStore();
    const c: GrantSpendCeiling = { lifetime_limit_micro: 100 * M };
    const first = await store.tryConsume({
      grant_id: GID,
      ceiling: c,
      action: act(1),
      nonce: 7,
      now: T0,
    });
    const replay = await store.tryConsume({
      grant_id: GID,
      ceiling: c,
      action: act(1),
      nonce: 7,
      now: T0,
    });
    expect(first.allowed).toBe(true);
    expect(replay.denial).toBe("replay");
  });
});
