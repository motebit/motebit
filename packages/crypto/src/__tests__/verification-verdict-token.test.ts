/**
 * VerificationVerdict — token/grant/revocation conformance (Phase A.2.2).
 *
 * The executable corpus for the token path of the VerificationVerdict arc
 * (docs/doctrine/verify-family-fail-closed.md), built against agency.computer's
 * three contributed fixtures. Each mints REAL signed grants/tokens/revocations
 * and asserts the EXACT verdict a second implementation must reproduce:
 *   1. revoked-grant tick that still self-mints  → every other axis a pass, revocation carries the lie
 *   3. clock-rollback vs ordering                → authority valid, temporalBasis clockless
 *   3-anti. same, wall-clock                     → authority not_yet_valid, temporalBasis local_clock
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  signStandingDelegation,
  signDelegation,
  signDelegationRevocation,
  deriveSovereignMotebitId,
  bytesToHex,
  verifyDelegationTokenVerdict,
  isFullyVerified,
} from "../index.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Mint a delegator (sovereign) + delegate keypair and a signed grant. */
async function mintParty() {
  const dkp = await generateKeypair(); // delegator (signs grants + ticks)
  const ekp = await generateKeypair(); // delegate
  const delegatorHex = bytesToHex(dkp.publicKey);
  const delegateHex = bytesToHex(ekp.publicKey);
  const delegatorId = await deriveSovereignMotebitId(delegatorHex);
  const parties = {
    delegator_id: delegatorId,
    delegator_public_key: delegatorHex,
    delegate_id: "mote-delegate",
    delegate_public_key: delegateHex,
  };
  const grant = await signStandingDelegation(
    {
      grant_id: "grant-1",
      ...parties,
      scope: "web.search,brief.compose",
      subject: "research:thesis=x",
      cadence_ms: DAY,
      issued_at: NOW - 1000,
      not_before: null,
      expires_at: NOW + 30 * DAY,
      max_token_ttl_ms: HOUR,
    },
    dkp.privateKey,
  );
  return { dkp, delegatorHex, parties, grant };
}

function tickFields(parties: Awaited<ReturnType<typeof mintParty>>["parties"]) {
  return {
    ...parties,
    scope: "web.search", // narrows within the grant ceiling
    grant_id: "grant-1",
  };
}

describe("verifyDelegationTokenVerdict — token-path conformance (agency fixtures)", () => {
  it("FIXTURE 1: revoked-grant tick that still self-mints → integrity/identity/authority pass, revocation carries the lie", async () => {
    const { dkp, parties, grant } = await mintParty();
    const token = await signDelegation(
      { ...tickFields(parties), issued_at: NOW, expires_at: NOW + HOUR }, // in-TTL, well-formed
      dkp.privateKey,
    );
    const revocation = await signDelegationRevocation(
      {
        grant_id: "grant-1",
        delegator_id: parties.delegator_id,
        delegator_public_key: parties.delegator_public_key,
        revoked_at: NOW - 500,
      },
      dkp.privateKey,
    );

    const v = await verifyDelegationTokenVerdict(token, grant, {
      revocations: [revocation],
      revocationFreshness: { basis: "asserted", asOf: { timestamp_ms: NOW } },
      now: NOW,
    });

    // Every axis a consumer might compose a pass over LOOKS like a pass —
    // except revocation, which is its own load-bearing axis.
    expect(v.integrity).toBe("verified");
    expect(v.identityBinding).toBe("sovereign");
    expect(v.authority).toBe("valid"); // the token genuinely was in-TTL and well-formed
    expect(v.revocation.status).toBe("revoked"); // the only lie is the dead grant
    expect(v.revocation.freshness?.basis).toBe("asserted");
    expect(v.temporalBasis).toBe("local_clock");
    expect(v.repair?.code).toBe("revocation.revoked");
    // The bare boolean would read TRUE. The verdict makes that impossible.
    expect(isFullyVerified(v)).toBe(false);
  });

  it("FIXTURE 3: clock-rollback under ordering → authority valid (window not consulted), temporalBasis clockless", async () => {
    const { dkp, parties, grant } = await mintParty();
    const slot = NOW + 10 * DAY; // the token's activation slot (issued_at = slot; signed early)
    const token = await signDelegation(
      { ...tickFields(parties), issued_at: slot, not_before: slot, expires_at: slot + HOUR },
      dkp.privateKey,
    );

    // Verifier clock rolled BACK before the slot — wall-clock would say "not yet".
    const v = await verifyDelegationTokenVerdict(token, grant, {
      now: NOW, // NOW < slot
      temporalMode: "ordering",
      revocations: [], // checked, none found → fresh
      revocationFreshness: { basis: "asserted", asOf: { timestamp_ms: NOW } },
    });

    expect(v.integrity).toBe("verified");
    expect(v.authority).toBe("valid"); // ordering decides; the rollback is irrelevant
    expect(v.temporalBasis).toBe("clockless");
    expect(v.revocation.status).toBe("fresh");
    expect(isFullyVerified(v)).toBe(true); // fully valid when judged by ordering
  });

  it("FIXTURE 3-anti: SAME token under wall-clock + rolled-back clock → authority not_yet_valid, temporalBasis local_clock", async () => {
    const { dkp, parties, grant } = await mintParty();
    const slot = NOW + 10 * DAY;
    const token = await signDelegation(
      { ...tickFields(parties), issued_at: slot, not_before: slot, expires_at: slot + HOUR },
      dkp.privateKey,
    );

    const v = await verifyDelegationTokenVerdict(token, grant, {
      now: NOW, // NOW < not_before(slot) — the rollback IS load-bearing here
      temporalMode: "wall_clock",
      revocations: [],
      revocationFreshness: { basis: "asserted", asOf: { timestamp_ms: NOW } },
    });

    expect(v.integrity).toBe("verified");
    expect(v.authority).toBe("not_yet_valid"); // wall-clock rollback flips it
    expect(v.temporalBasis).toBe("local_clock");
    expect(v.repair?.code).toBe("authority.not_yet_valid");
    expect(isFullyVerified(v)).toBe(false);
    // The pair proves: a consumer MUST branch on temporalBasis, never assume wall-clock.
  });
});

describe("verifyDelegationTokenVerdict — supporting axis coverage", () => {
  it("clean in-window tick with a consulted-empty revocation set → every axis passes", async () => {
    const { dkp, parties, grant } = await mintParty();
    const token = await signDelegation(
      { ...tickFields(parties), issued_at: NOW, expires_at: NOW + HOUR },
      dkp.privateKey,
    );
    const v = await verifyDelegationTokenVerdict(token, grant, {
      now: NOW,
      revocations: [],
      revocationFreshness: { basis: "ledger", asOf: { anchor: { chain: "solana", slot: 42 } } },
    });
    expect(v.authority).toBe("valid");
    expect(v.revocation).toEqual({
      status: "fresh",
      freshness: { basis: "ledger", asOf: { anchor: { chain: "solana", slot: 42 } } },
    });
    expect(v.repair).toBeUndefined();
    expect(isFullyVerified(v)).toBe(true);
  });

  it("no revocation set supplied → revocation unchecked + repair (never a silent fresh)", async () => {
    const { dkp, parties, grant } = await mintParty();
    const token = await signDelegation(
      { ...tickFields(parties), issued_at: NOW, expires_at: NOW + HOUR },
      dkp.privateKey,
    );
    const v = await verifyDelegationTokenVerdict(token, grant, { now: NOW });
    expect(v.revocation.status).toBe("unchecked");
    expect(v.repair?.code).toBe("revocation.unchecked");
    expect(isFullyVerified(v)).toBe(false);
  });

  it("expired token → authority expired", async () => {
    const { dkp, parties, grant } = await mintParty();
    const token = await signDelegation(
      { ...tickFields(parties), issued_at: NOW - 2 * HOUR, expires_at: NOW - HOUR },
      dkp.privateKey,
    );
    const v = await verifyDelegationTokenVerdict(token, grant, { now: NOW, revocations: [] });
    expect(v.authority).toBe("expired");
    expect(v.repair?.code).toBe("authority.expired");
  });

  it("token that widens scope beyond the grant → authority insufficient", async () => {
    const { dkp, parties, grant } = await mintParty();
    const token = await signDelegation(
      { ...tickFields(parties), scope: "payments.send", issued_at: NOW, expires_at: NOW + HOUR },
      dkp.privateKey,
    );
    const v = await verifyDelegationTokenVerdict(token, grant, { now: NOW, revocations: [] });
    expect(v.authority).toBe("insufficient");
    expect(v.repair?.code).toBe("authority.insufficient");
  });

  it("delegator id that does not commit to the key → identityBinding unverified", async () => {
    const { dkp, parties, grant } = await mintParty();
    const token = await signDelegation(
      {
        ...tickFields(parties),
        delegator_id: "mote-not-sovereign",
        issued_at: NOW,
        expires_at: NOW + HOUR,
      },
      dkp.privateKey,
    );
    // grant_id still matches; the token's delegator_id no longer matches the grant's,
    // so authority is insufficient AND the binding is unverified — repair prioritises identity.
    const v = await verifyDelegationTokenVerdict(token, grant, { now: NOW, revocations: [] });
    expect(v.identityBinding).toBe("unverified");
    expect(v.repair?.axis).toBe("identityBinding");
  });

  it("tampered token → integrity invalid", async () => {
    const { dkp, parties, grant } = await mintParty();
    const token = await signDelegation(
      { ...tickFields(parties), issued_at: NOW, expires_at: NOW + HOUR },
      dkp.privateKey,
    );
    const tampered = { ...token, scope: "payments.send" };
    const v = await verifyDelegationTokenVerdict(tampered, grant, { now: NOW, revocations: [] });
    expect(v.integrity).toBe("invalid");
    expect(v.repair?.axis).toBe("integrity");
  });
});
