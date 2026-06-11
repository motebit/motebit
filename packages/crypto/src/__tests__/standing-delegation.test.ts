import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signDelegation,
  verifyDelegation,
  signStandingDelegation,
  verifyStandingDelegation,
  verifyTokenAgainstGrant,
  signDelegationRevocation,
  verifyDelegationRevocation,
  findGrantRevocation,
} from "../index.js";
import type { DelegationToken, StandingDelegation, DelegationRevocation } from "@motebit/protocol";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };

const HOUR = 3_600_000;

async function makeGrant(
  delegator: Kp,
  delegate: Kp,
  over: Partial<Omit<StandingDelegation, "signature" | "suite">> = {},
): Promise<StandingDelegation> {
  const now = Date.now();
  return signStandingDelegation(
    {
      grant_id: over.grant_id ?? "grant-1",
      delegator_id: over.delegator_id ?? "did:motebit:alice",
      delegator_public_key: over.delegator_public_key ?? bytesToHex(delegator.publicKey),
      delegate_id: over.delegate_id ?? "did:motebit:bob",
      delegate_public_key: over.delegate_public_key ?? bytesToHex(delegate.publicKey),
      scope: over.scope ?? "web_search,summarize",
      subject: over.subject ?? "research:thesis=acme",
      cadence_ms: over.cadence_ms ?? 24 * HOUR,
      issued_at: over.issued_at ?? now,
      not_before: over.not_before ?? null,
      expires_at: over.expires_at ?? now + 90 * 24 * HOUR,
      max_token_ttl_ms: over.max_token_ttl_ms ?? HOUR,
    },
    delegator.privateKey,
  );
}

// Mint a per-tick token under a grant (what a monitor does each tick).
async function mintTick(
  grant: StandingDelegation,
  delegator: Kp,
  delegate: Kp,
  over: Partial<Omit<DelegationToken, "signature" | "suite">> = {},
): Promise<DelegationToken> {
  const now = Date.now();
  return signDelegation(
    {
      delegator_id: grant.delegator_id,
      delegator_public_key: grant.delegator_public_key,
      delegate_id: grant.delegate_id,
      delegate_public_key: grant.delegate_public_key,
      scope: over.scope ?? "web_search",
      issued_at: over.issued_at ?? now,
      expires_at: over.expires_at ?? now + HOUR,
      ...(over.not_before !== undefined ? { not_before: over.not_before } : {}),
      grant_id: "grant_id" in over ? over.grant_id : grant.grant_id,
    },
    delegator.privateKey,
  );
}

describe("signStandingDelegation / verifyStandingDelegation", () => {
  it("round-trips a valid grant", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    expect(grant.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(await verifyStandingDelegation(grant)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    expect(await verifyStandingDelegation({ ...grant, scope: "*" })).toBe(false);
  });

  it("rejects a grant signed by the wrong key", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const mallory = await generateKeypair();
    // delegator_public_key claims alice, but mallory signs.
    const grant = await makeGrant(mallory, bob, {
      delegator_public_key: bytesToHex(alice.publicKey),
    });
    expect(await verifyStandingDelegation(grant)).toBe(false);
  });

  it("rejects an expired grant, accepts with checkExpiry:false", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const past = Date.now() - 10 * HOUR;
    const grant = await makeGrant(alice, bob, { issued_at: past, expires_at: past + HOUR });
    expect(await verifyStandingDelegation(grant)).toBe(false);
    expect(await verifyStandingDelegation(grant, { checkExpiry: false })).toBe(true);
  });

  it("rejects a not-yet-active grant", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const now = Date.now();
    const grant = await makeGrant(alice, bob, { not_before: now + HOUR });
    expect(await verifyStandingDelegation(grant, { now })).toBe(false);
    expect(await verifyStandingDelegation(grant, { now: now + 2 * HOUR })).toBe(true);
  });

  it("rejects a revoked grant via the injected isRevoked seam", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    expect(await verifyStandingDelegation(grant, { isRevoked: () => false })).toBe(true);
    expect(await verifyStandingDelegation(grant, { isRevoked: (id) => id === "grant-1" })).toBe(
      false,
    );
  });
});

describe("verifyTokenAgainstGrant", () => {
  it("accepts a well-formed per-tick token", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const tick = await mintTick(grant, alice, bob);
    expect(await verifyTokenAgainstGrant(tick, grant)).toEqual({ valid: true });
  });

  it("rejects a token whose grant_id does not match", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const tick = await mintTick(grant, alice, bob, { grant_id: "other" });
    const r = await verifyTokenAgainstGrant(tick, grant);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/grant_id/);
  });

  it("rejects a token that widens scope beyond the grant ceiling", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob, { scope: "web_search" });
    const tick = await mintTick(grant, alice, bob, { scope: "web_search,withdraw" });
    const r = await verifyTokenAgainstGrant(tick, grant);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/scope/);
  });

  it("rejects a token whose TTL exceeds the grant ceiling", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob, { max_token_ttl_ms: HOUR });
    const now = Date.now();
    const tick = await mintTick(grant, alice, bob, {
      issued_at: now,
      expires_at: now + 2 * HOUR, // exceeds 1h ceiling
    });
    const r = await verifyTokenAgainstGrant(tick, grant, { now });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/TTL/);
  });

  it("rejects a token whose parties do not match the grant", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const carol = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    // A token for a different delegate (carol), signed by alice.
    const now = Date.now();
    const tick = await signDelegation(
      {
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        delegate_id: "did:motebit:carol",
        delegate_public_key: bytesToHex(carol.publicKey),
        scope: "web_search",
        issued_at: now,
        expires_at: now + HOUR,
        grant_id: grant.grant_id,
      },
      alice.privateKey,
    );
    const r = await verifyTokenAgainstGrant(tick, grant, { now });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/parties/);
  });

  it("rejects every tick once the grant is revoked", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const tick = await mintTick(grant, alice, bob);
    expect((await verifyTokenAgainstGrant(tick, grant)).valid).toBe(true);
    const r = await verifyTokenAgainstGrant(tick, grant, { isRevoked: () => true });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/revoked/);
  });

  it("rejects an expired per-tick token even under a valid grant", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const now = Date.now();
    const tick = await mintTick(grant, alice, bob, {
      issued_at: now - 2 * HOUR,
      expires_at: now - HOUR,
    });
    const r = await verifyTokenAgainstGrant(tick, grant, { now });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/signature or expiry/);
  });
});

describe("verifyDelegation — not_before activation (standing-delegation v1.1)", () => {
  it("a pre-minted future-slot tick does not verify before its slot, verifies after", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const slot = Date.now() + 5 * HOUR; // a future cadence slot
    const tick = await mintTick(grant, alice, bob, {
      issued_at: slot,
      not_before: slot,
      expires_at: slot + HOUR,
    });
    // Before the slot: rejected on activation even though the signature is valid.
    expect(await verifyDelegation(tick, { now: slot - HOUR })).toBe(false);
    // At/after the slot (and before expiry): valid.
    expect(await verifyDelegation(tick, { now: slot })).toBe(true);
    expect(await verifyDelegation(tick, { now: slot + 30 * 60_000 })).toBe(true);
  });

  it("absent not_before is unconstrained (legacy tokens replay identically)", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const now = Date.now();
    const tick = await mintTick(grant, alice, bob, { issued_at: now, expires_at: now + HOUR });
    expect(tick.not_before).toBeUndefined();
    expect(await verifyDelegation(tick, { now })).toBe(true);
  });

  it("checkExpiry:false skips the activation check (historical chain verification)", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const slot = Date.now() + 5 * HOUR;
    const tick = await mintTick(grant, alice, bob, {
      issued_at: slot,
      not_before: slot,
      expires_at: slot + HOUR,
    });
    // now is before the slot, but historical verification ignores time.
    expect(await verifyDelegation(tick, { now: slot - HOUR, checkExpiry: false })).toBe(true);
  });
});

describe("signDelegationRevocation / verifyDelegationRevocation", () => {
  it("round-trips a revocation signed by the delegator", async () => {
    const alice = await generateKeypair();
    const rev = await signDelegationRevocation(
      {
        grant_id: "grant-1",
        delegator_id: "did:motebit:alice",
        delegator_public_key: bytesToHex(alice.publicKey),
        revoked_at: Date.now(),
      },
      alice.privateKey,
    );
    expect(await verifyDelegationRevocation(rev)).toBe(true);
  });

  it("rejects a revocation signed by a non-delegator key", async () => {
    const alice = await generateKeypair();
    const mallory = await generateKeypair();
    // Claims alice's key but mallory signs — the offline-verifiable refusal.
    const rev = await signDelegationRevocation(
      {
        grant_id: "grant-1",
        delegator_id: "did:motebit:alice",
        delegator_public_key: bytesToHex(alice.publicKey),
        revoked_at: Date.now(),
      },
      mallory.privateKey,
    );
    expect(await verifyDelegationRevocation(rev)).toBe(false);
  });

  it("a valid revocation only binds the grant when its key matches the grant's delegator", async () => {
    // The note in verifyDelegationRevocation: a well-formed revocation is only
    // authoritative over a grant whose delegator_public_key it carries.
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const rev = await signDelegationRevocation(
      {
        grant_id: grant.grant_id,
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        revoked_at: Date.now(),
      },
      alice.privateKey,
    );
    expect(await verifyDelegationRevocation(rev)).toBe(true);
    // The binding check the consumer performs:
    const bindsGrant =
      rev.grant_id === grant.grant_id && rev.delegator_public_key === grant.delegator_public_key;
    expect(bindsGrant).toBe(true);
  });
});

describe("findGrantRevocation — the consumer-side check done right", () => {
  it("finds an authoritative revocation and builds a working isRevoked seam", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const rev = await signDelegationRevocation(
      {
        grant_id: grant.grant_id,
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        revoked_at: Date.now(),
      },
      alice.privateKey,
    );

    expect(await findGrantRevocation(grant, [rev])).toEqual(rev);

    // Compose it into the verify seam: precompute revoked set, pass a sync lookup.
    const revoked = (await findGrantRevocation(grant, [rev])) !== null;
    const revokedSet = new Set(revoked ? [grant.grant_id] : []);
    expect(await verifyStandingDelegation(grant, { isRevoked: (id) => revokedSet.has(id) })).toBe(
      false,
    );
  });

  it("ignores a revocation with the right grant_id but the WRONG key (the foot-gun)", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const mallory = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    // Mallory signs a revocation naming HER key but targeting alice's grant_id.
    const spoof = await signDelegationRevocation(
      {
        grant_id: grant.grant_id,
        delegator_id: "did:motebit:mallory",
        delegator_public_key: bytesToHex(mallory.publicKey),
        revoked_at: Date.now(),
      },
      mallory.privateKey,
    );
    // It verifies as a well-formed signature...
    expect(await verifyDelegationRevocation(spoof)).toBe(true);
    // ...but is NOT authoritative over alice's grant (key does not match).
    expect(await findGrantRevocation(grant, [spoof])).toBeNull();
  });

  it("ignores a revocation for a different grant, and an empty set", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const otherRev = await signDelegationRevocation(
      {
        grant_id: "some-other-grant",
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        revoked_at: Date.now(),
      },
      alice.privateKey,
    );
    expect(await findGrantRevocation(grant, [otherRev])).toBeNull();
    expect(await findGrantRevocation(grant, [])).toBeNull();
  });

  it("ignores a tampered (bad-signature) revocation that otherwise binds", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const rev = await signDelegationRevocation(
      {
        grant_id: grant.grant_id,
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        revoked_at: Date.now(),
      },
      alice.privateKey,
    );
    const tampered: DelegationRevocation = { ...rev, revoked_at: rev.revoked_at + 1 };
    expect(await findGrantRevocation(grant, [tampered])).toBeNull();
  });
});
