/**
 * Grant verifier — the ONLY producer of `TurnContext.verifiedGrant`.
 * Pins the fail-closed contract: a full verification chain (grant
 * signature + activation/expiry + token-is-a-valid-tick + revocation
 * feed) yields the verifiedGrant value; ANY failure yields null and
 * therefore (via the policy gate's standing-authority invariant) live
 * human approval for R4.
 *
 * Doctrine: docs/doctrine/memory-never-confers-authority.md.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signDelegation,
  signStandingDelegation,
  signDelegationRevocation,
} from "@motebit/crypto";
import type { DelegationToken, StandingDelegation } from "@motebit/protocol";
import { verifyGrantForTurn } from "../grant-verifier.js";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };
const HOUR = 3_600_000;

async function makeGrant(delegator: Kp, delegate: Kp): Promise<StandingDelegation> {
  const now = Date.now();
  return signStandingDelegation(
    {
      grant_id: "grant-money-1",
      delegator_id: "did:motebit:alice",
      delegator_public_key: bytesToHex(delegator.publicKey),
      delegate_id: "did:motebit:bob",
      delegate_public_key: bytesToHex(delegate.publicKey),
      scope: "pay_invoice",
      subject: "billing:vendor=acme",
      cadence_ms: 24 * HOUR,
      issued_at: now,
      not_before: null,
      expires_at: now + 90 * 24 * HOUR,
      max_token_ttl_ms: HOUR,
    },
    delegator.privateKey,
  );
}

async function mintTick(grant: StandingDelegation, delegator: Kp): Promise<DelegationToken> {
  const now = Date.now();
  return signDelegation(
    {
      delegator_id: grant.delegator_id,
      delegator_public_key: grant.delegator_public_key,
      delegate_id: grant.delegate_id,
      delegate_public_key: grant.delegate_public_key,
      scope: "pay_invoice",
      issued_at: now,
      expires_at: now + HOUR,
      grant_id: grant.grant_id,
    },
    delegator.privateKey,
  );
}

describe("verifyGrantForTurn", () => {
  it("returns the verifiedGrant value for a valid grant + token + empty revocations", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const token = await mintTick(grant, alice);

    const result = await verifyGrantForTurn(token, grant, []);
    expect(result).not.toBeNull();
    expect(result!.grant_id).toBe("grant-money-1");
    expect(result!.verified_at).toBeGreaterThan(0);
  });

  it("returns null when the grant is revoked — revocation wins, fail-closed", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const token = await mintTick(grant, alice);
    const revocation = await signDelegationRevocation(
      {
        grant_id: grant.grant_id,
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        revoked_at: Date.now(),
      },
      alice.privateKey,
    );

    expect(await verifyGrantForTurn(token, grant, [revocation])).toBeNull();
  });

  it("ignores a revocation signed by a different key (binding foot-gun)", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const mallory = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const token = await mintTick(grant, alice);
    // Mallory tries to revoke Alice's grant with her own key.
    const forged = await signDelegationRevocation(
      {
        grant_id: grant.grant_id,
        delegator_id: "did:motebit:mallory",
        delegator_public_key: bytesToHex(mallory.publicKey),
        revoked_at: Date.now(),
      },
      mallory.privateKey,
    );

    expect(await verifyGrantForTurn(token, grant, [forged])).not.toBeNull();
  });

  it("returns null for a tampered grant", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const token = await mintTick(grant, alice);

    expect(await verifyGrantForTurn(token, { ...grant, scope: "*" }, [])).toBeNull();
  });

  it("returns null for an expired grant", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const token = await mintTick(grant, alice);

    expect(
      await verifyGrantForTurn(token, grant, [], { now: Date.now() + 91 * 24 * HOUR }),
    ).toBeNull();
  });

  it("returns null when the token does not belong to the grant", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const otherGrant = { ...(await makeGrant(alice, bob)), grant_id: "grant-other" };
    const tokenForOther = await signDelegation(
      {
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        delegate_id: grant.delegate_id,
        delegate_public_key: grant.delegate_public_key,
        scope: "pay_invoice",
        issued_at: Date.now(),
        expires_at: Date.now() + HOUR,
        grant_id: otherGrant.grant_id,
      },
      alice.privateKey,
    );

    expect(await verifyGrantForTurn(tokenForOther, grant, [])).toBeNull();
  });
});
