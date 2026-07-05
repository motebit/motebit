/**
 * §3.3 shape law, enforced identically in BOTH validators (agency review,
 * 2026-07-05): the zod schema (this suite) and the committed JSON Schema
 * (drift.test.ts regenerates it from the same source, and the emitter
 * injects draft-07 `dependencies`) must refuse what the wire format
 * forbids — a per-window limit without `window_ms`, and any numeric above
 * 2^53−1 (JCS/ECMAScript number fidelity). Rule 3 (at-least-one-total-
 * bound) is deliberately NOT shape law: a bare ceiling is well-formed and
 * authorizes nothing.
 */
import { describe, it, expect } from "vitest";
import { SpendCeilingV1Schema, StandingDelegationSchema } from "../standing-delegation.js";

const BASE = { schema: "motebit.spend-ceiling.v1" as const };
const MAX_SAFE = 9_007_199_254_740_991;

describe("SpendCeilingV1 shape law", () => {
  it("refuses each per-window limit without window_ms", () => {
    for (const field of [
      "cumulative_limit_micro",
      "per_counterparty_limit_micro",
      "max_action_count",
    ]) {
      const r = SpendCeilingV1Schema.safeParse({ ...BASE, [field]: 5_000_000 });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(JSON.stringify(r.error.issues)).toContain("window_ms");
      }
    }
  });

  it("accepts per-window limits WITH window_ms, and lifetime alone", () => {
    expect(
      SpendCeilingV1Schema.safeParse({
        ...BASE,
        cumulative_limit_micro: 1_000_000,
        window_ms: 86_400_000,
      }).success,
    ).toBe(true);
    expect(
      SpendCeilingV1Schema.safeParse({ ...BASE, lifetime_limit_micro: 5_000_000 }).success,
    ).toBe(true);
  });

  it("a bare ceiling is well-formed (authorizes nothing — enforcement law, not shape law)", () => {
    expect(SpendCeilingV1Schema.safeParse(BASE).success).toBe(true);
  });

  it("caps every numeric at 2^53−1 (JCS number fidelity)", () => {
    expect(
      SpendCeilingV1Schema.safeParse({ ...BASE, lifetime_limit_micro: MAX_SAFE }).success,
    ).toBe(true);
    for (const field of [
      "lifetime_limit_micro",
      "cumulative_limit_micro",
      "per_counterparty_limit_micro",
      "max_action_count",
      "window_ms",
    ]) {
      const value = MAX_SAFE + 2; // +1 is not representable distinctly
      const candidate =
        field === "lifetime_limit_micro" || field === "window_ms"
          ? { ...BASE, [field]: value }
          : { ...BASE, [field]: value, window_ms: 1000 };
      expect(SpendCeilingV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("the embedded copy in StandingDelegationSchema enforces the same law", () => {
    const grantShape = {
      grant_id: "g",
      delegator_id: "d",
      delegator_public_key: "a".repeat(64),
      delegate_id: "d",
      delegate_public_key: "a".repeat(64),
      scope: "pay_invoice",
      subject: "s",
      cadence_ms: 1,
      issued_at: 1,
      not_before: null,
      expires_at: 2,
      max_token_ttl_ms: 1,
      suite: "motebit-jcs-ed25519-b64-v1" as const,
      signature: "sig",
    };
    const bad = StandingDelegationSchema.safeParse({
      ...grantShape,
      spend_ceiling: { ...BASE, cumulative_limit_micro: 1 },
    });
    expect(bad.success).toBe(false);
    const good = StandingDelegationSchema.safeParse({
      ...grantShape,
      spend_ceiling: { ...BASE, cumulative_limit_micro: 1, window_ms: 1000 },
    });
    expect(good.success).toBe(true);
  });
});
