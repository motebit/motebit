/**
 * revoke-then-self-mint-offline — the permanent red-team fixture the
 * checkpoint's D1 sign-off demanded (docs/proposals/
 * standing-delegation-execution-checkpoint.md).
 *
 * The attack: the delegator REVOKES a standing grant, but the delegate —
 * holding pre-minted future-dated tick tokens (the v1.0 pre-minting model)
 * — keeps presenting apparently-fresh short-TTL tokens manufactured from
 * the stale standing authority.
 *
 * What this suite pins, honestly:
 *  1. ONLINE (revocation held): verifyGrantForTurn refuses EVERY tick —
 *     including pre-minted future-dated ones — the moment the revocation
 *     is in the presented set. This is the bound v1 relies on (D1:
 *     relay-coordinated money re-verifies with a fresh revocation set at
 *     the settlement checkpoint).
 *  2. OFFLINE (revocation NOT held): the same pre-minted tick still
 *     verifies — the information-theoretic hole verify-family-fail-closed
 *     names. This assertion is executable documentation: if a future
 *     change makes it fail, the freshness-staple arc has landed and this
 *     fixture must be rewritten, not deleted.
 *  3. The offline ceiling is `expires_at`: past grant expiry even a
 *     revocation-blind verifier refuses.
 *  4. Defense-in-depth: even the offline-verified grant moves NOTHING
 *     without a signed spend_ceiling (`ceiling_absent`), and a ceiling'd
 *     one is bounded by lifetime regardless of how many fresh tokens the
 *     delegate manufactures.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signDelegation,
  signStandingDelegation,
  signDelegationRevocation,
} from "@motebit/crypto";
import type { DelegationToken, StandingDelegation, DelegationRevocation } from "@motebit/protocol";
import { InMemoryGrantSpendStore } from "@motebit/policy";
import { verifyGrantForTurn } from "../grant-verifier.js";
import { createMoneyMeter } from "../money-meter.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const M = 1_000_000;
const T0 = 1_750_000_000_000;

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };

let delegator: Kp;
let delegate: Kp;
let grant: StandingDelegation;
let revocation: DelegationRevocation;
/** Pre-minted future-dated ticks, one per day — the v1.0 schedule. */
let preMintedTicks: DelegationToken[];

beforeAll(async () => {
  delegator = await generateKeypair();
  delegate = await generateKeypair();
  grant = await signStandingDelegation(
    {
      grant_id: "grant-money-1",
      delegator_id: "did:motebit:owner",
      delegator_public_key: bytesToHex(delegator.publicKey),
      delegate_id: "did:motebit:agent",
      delegate_public_key: bytesToHex(delegate.publicKey),
      scope: "pay_invoice",
      subject: "billing:vendor=acme",
      spend_ceiling: {
        schema: "motebit.spend-ceiling.v1",
        lifetime_limit_micro: 5 * M, // the checkpoint's $5 shape
      },
      cadence_ms: DAY,
      issued_at: T0,
      not_before: null,
      expires_at: T0 + 7 * DAY, // D4 convention: money grants live short
      max_token_ttl_ms: HOUR,
    },
    delegator.privateKey,
  );
  preMintedTicks = await Promise.all(
    Array.from({ length: 7 }, (_, day) =>
      signDelegation(
        {
          delegator_id: grant.delegator_id,
          delegator_public_key: grant.delegator_public_key,
          delegate_id: grant.delegate_id,
          delegate_public_key: grant.delegate_public_key,
          scope: "pay_invoice",
          issued_at: T0 + day * DAY,
          not_before: T0 + day * DAY,
          expires_at: T0 + day * DAY + HOUR,
          grant_id: grant.grant_id,
        },
        delegator.privateKey,
      ),
    ),
  );
  // Day 2: the owner revokes.
  revocation = await signDelegationRevocation(
    {
      grant_id: grant.grant_id,
      delegator_id: grant.delegator_id,
      delegator_public_key: grant.delegator_public_key,
      revoked_at: T0 + 2 * DAY,
    },
    delegator.privateKey,
  );
});

describe("revoke-then-self-mint-offline", () => {
  it("sanity: before revocation, a due tick verifies and carries nonce + ceiling", async () => {
    const day1 = preMintedTicks[1]!;
    const v = await verifyGrantForTurn(day1, grant, [], { now: T0 + 1 * DAY + 1 });
    expect(v).not.toBeNull();
    expect(v!.token_issued_at).toBe(day1.issued_at);
    expect(v!.spend_ceiling?.lifetime_limit_micro).toBe(5 * M);
  });

  it("ONLINE: with the revocation held, EVERY tick refuses — including pre-minted future ones", async () => {
    for (const day of [3, 4, 5, 6]) {
      const tick = preMintedTicks[day]!;
      const v = await verifyGrantForTurn(tick, grant, [revocation], {
        now: T0 + day * DAY + 1,
      });
      expect(v).toBeNull();
    }
  });

  it("a foreign-key revocation does NOT refuse (binding-safe — a stranger cannot revoke)", async () => {
    const mallory = await generateKeypair();
    const forged = await signDelegationRevocation(
      {
        grant_id: grant.grant_id,
        delegator_id: "did:motebit:mallory",
        delegator_public_key: bytesToHex(mallory.publicKey),
        revoked_at: T0 + 2 * DAY,
      },
      mallory.privateKey,
    );
    const tick = preMintedTicks[3]!;
    const v = await verifyGrantForTurn(tick, grant, [forged], { now: T0 + 3 * DAY + 1 });
    expect(v).not.toBeNull();
  });

  it("OFFLINE HOLE (executable documentation): a revocation-blind verifier still accepts a post-revocation tick", async () => {
    // If this assertion ever FAILS, the freshness-staple arc has shipped:
    // rewrite this fixture around the staple, do not delete it.
    const tick = preMintedTicks[3]!;
    const v = await verifyGrantForTurn(tick, grant, [], { now: T0 + 3 * DAY + 1 });
    expect(v).not.toBeNull();
  });

  it("the offline ceiling is expires_at: past grant expiry, even revocation-blind verification refuses", async () => {
    // A tick the delegate manufactures for a slot after grant expiry —
    // the grant itself fails intrinsic verification at that time.
    const late = await signDelegation(
      {
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        delegate_id: grant.delegate_id,
        delegate_public_key: grant.delegate_public_key,
        scope: "pay_invoice",
        issued_at: T0 + 8 * DAY,
        expires_at: T0 + 8 * DAY + HOUR,
        grant_id: grant.grant_id,
      },
      delegator.privateKey,
    );
    const v = await verifyGrantForTurn(late, grant, [], { now: T0 + 8 * DAY + 1 });
    expect(v).toBeNull();
  });

  it("defense-in-depth: offline worst-case spend is bounded by the SIGNED lifetime ceiling", async () => {
    // The revocation-blind window (days 2→7): the delegate presents one
    // verified tick per day and tries to drain. The signed $5 lifetime +
    // the one-action-per-tick nonce bound cap total exposure at $5 no
    // matter how many apparently-fresh tokens it manufactures.
    const meter = createMoneyMeter(new InMemoryGrantSpendStore(), {
      now: () => T0 + 3 * DAY,
    });
    let moved = 0;
    for (const tick of preMintedTicks) {
      const v = await verifyGrantForTurn(tick, grant, [], {
        now: tick.not_before ?? tick.issued_at,
      });
      if (v == null) continue;
      // Try to drain $2 per tick.
      const verdict = await meter(v, "pay_invoice", {
        amount_micro: 2 * M,
        counterparty: "attacker-sink",
      });
      if (verdict.allowed) moved += 2 * M;
      // A second action under the SAME tick must always replay-deny.
      const replay = await meter(v, "pay_invoice", {
        amount_micro: 2 * M,
        counterparty: "attacker-sink",
      });
      expect(replay.allowed).toBe(false);
    }
    expect(moved).toBeLessThanOrEqual(5 * M); // ≤ the delegator's signed bound
    expect(moved).toBe(4 * M); // 2 ticks × $2 allowed, third exceeds lifetime
  });
});
