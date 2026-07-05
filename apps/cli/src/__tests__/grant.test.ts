/**
 * `motebit grant` — the Inc 4 mint proven against the Inc 3b execution
 * machinery, end to end with real cryptography: what this CLI mints is
 * exactly what `verifyGrantForTurn` accepts, the meter enforces, and a
 * revocation kills. This is the composition Daniel's first real grant
 * will ride — same code path, test keys.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signDelegationRevocation,
  verifyStandingDelegation,
  verifyTokenAgainstGrant,
} from "@motebit/encryption";
import { verifyGrantForTurn, createMoneyMeter } from "@motebit/runtime";
import { InMemoryGrantSpendStore } from "@motebit/policy";
import { mintGrantWithSchedule, selectDueTick, type StoredGrant } from "../subcommands/grant.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const M = 1_000_000;
const T0 = 1_760_000_000_000;

let kp: { publicKey: Uint8Array; privateKey: Uint8Array };
let minted: Awaited<ReturnType<typeof mintGrantWithSchedule>>;

beforeAll(async () => {
  kp = await generateKeypair();
  minted = await mintGrantWithSchedule({
    motebitId: "did:motebit:founder",
    publicKeyHex: bytesToHex(kp.publicKey),
    privateKey: kp.privateKey,
    scope: "pay_invoice",
    subject: "billing:vendor=acme",
    ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 5 * M },
    cadenceMs: DAY,
    days: 7,
    now: T0,
  });
});

describe("mintGrantWithSchedule", () => {
  it("mints the checkpoint shape: $5 lifetime / 7d / 7 daily 1h ticks, all verifying", async () => {
    expect(minted.grant.spend_ceiling?.lifetime_limit_micro).toBe(5 * M);
    expect(minted.grant.expires_at).toBe(T0 + 7 * DAY);
    expect(minted.ticks).toHaveLength(7);
    expect(await verifyStandingDelegation(minted.grant, { now: T0 + 1 })).toBe(true);
    for (const [slot, tick] of minted.ticks.entries()) {
      const inSlot = T0 + slot * DAY + 1;
      const r = await verifyTokenAgainstGrant(tick, minted.grant, { now: inSlot });
      expect(r.valid).toBe(true);
    }
  });

  it("slot 0 is active immediately; later slots are not_before-gated (pre-minting is honest)", async () => {
    expect(minted.ticks[0]!.not_before).toBeUndefined();
    expect(minted.ticks[3]!.not_before).toBe(T0 + 3 * DAY);
    // A day-3 tick presented on day 0 must NOT verify — the signed
    // schedule IS the cadence bound.
    const early = await verifyTokenAgainstGrant(minted.ticks[3]!, minted.grant, { now: T0 + 1 });
    expect(early.valid).toBe(false);
  });

  it("selectDueTick picks exactly the live slot, and none between slots", () => {
    const stored: StoredGrant = { grant: minted.grant, ticks: minted.ticks };
    expect(selectDueTick(stored, T0 + 2 * DAY + 30 * 60_000)?.issued_at).toBe(T0 + 2 * DAY);
    // 2h into day 2 — the 1h tick has expired, next slot not due: grantless.
    expect(selectDueTick(stored, T0 + 2 * DAY + 2 * HOUR)).toBeNull();
  });
});

describe("the minted grant drives the Inc 3b execution machinery end-to-end", () => {
  it("verifyGrantForTurn accepts a due tick and carries ceiling + nonce to the meter", async () => {
    const tick = minted.ticks[1]!;
    const v = await verifyGrantForTurn(tick, minted.grant, [], { now: T0 + 1 * DAY + 1 });
    expect(v).not.toBeNull();
    expect(v!.spend_ceiling?.lifetime_limit_micro).toBe(5 * M);
    expect(v!.token_issued_at).toBe(tick.issued_at);
  });

  it("the meter enforces the signed $5 lifetime across the whole schedule", async () => {
    const meter = createMoneyMeter(new InMemoryGrantSpendStore(), { now: () => T0 + 1 });
    let moved = 0;
    for (const [slot, tick] of minted.ticks.entries()) {
      const v = await verifyGrantForTurn(tick, minted.grant, [], { now: T0 + slot * DAY + 1 });
      expect(v).not.toBeNull();
      const verdict = await meter(v!, "pay_invoice", {
        amount_micro: 1 * M,
        counterparty: "vendor-acme",
      });
      if (verdict.allowed) moved += 1 * M;
      else expect(verdict.denial).toBe("lifetime_exceeded");
    }
    expect(moved).toBe(5 * M); // 5 of 7 daily $1 actions; the signed bound holds
  });

  it("a revocation kills every remaining tick at the verifier", async () => {
    const revocation = await signDelegationRevocation(
      {
        grant_id: minted.grant.grant_id,
        delegator_id: minted.grant.delegator_id,
        delegator_public_key: minted.grant.delegator_public_key,
        revoked_at: T0 + 2 * DAY,
      },
      kp.privateKey,
    );
    for (const [slot, tick] of minted.ticks.entries()) {
      const v = await verifyGrantForTurn(tick, minted.grant, [revocation], {
        now: T0 + slot * DAY + 1,
      });
      expect(v).toBeNull();
    }
  });
});
