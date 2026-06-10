/**
 * The delegation family is consumable through `@motebit/verifier` — the package
 * an external consumer (e.g. agency) already pins. This proves the increment-3
 * integration: a standing monitor's authorization root, every per-tick token
 * (against its grant), and a revocation are all verifiable through the verifier
 * surface, without adding `@motebit/crypto` as a second dependency.
 *
 * Signing stays on `@motebit/crypto` (the consumer signs with its own key);
 * verification flows through `@motebit/verifier` (the import under test).
 */
import { describe, it, expect } from "vitest";
import { generateKeypair, bytesToHex, signDelegation } from "@motebit/crypto";
import { signStandingDelegation, signDelegationRevocation } from "@motebit/crypto";

// The import under test: the delegation-family verifiers, re-exported from the verifier package.
import {
  verifyDelegation,
  verifyStandingDelegation,
  verifyTokenAgainstGrant,
  verifyDelegationRevocation,
} from "../index.js";

const HOUR = 3_600_000;

describe("@motebit/verifier — delegation family re-exports", () => {
  it("verifies a StandingDelegation grant, a per-tick token against it, and standalone token", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const now = Date.now();

    const grant = await signStandingDelegation(
      {
        grant_id: "grant-1",
        delegator_id: "did:motebit:alice",
        delegator_public_key: bytesToHex(alice.publicKey),
        delegate_id: "did:motebit:bob",
        delegate_public_key: bytesToHex(bob.publicKey),
        scope: "web_search,summarize",
        subject: "research:thesis=acme",
        cadence_ms: 24 * HOUR,
        issued_at: now,
        not_before: null,
        expires_at: now + 90 * 24 * HOUR,
        max_token_ttl_ms: HOUR,
      },
      alice.privateKey,
    );

    // Grant verifies through the verifier surface.
    expect(await verifyStandingDelegation(grant)).toBe(true);

    // A per-tick token, minted by the delegate under the grant.
    const tick = await signDelegation(
      {
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        delegate_id: grant.delegate_id,
        delegate_public_key: grant.delegate_public_key,
        scope: "web_search",
        issued_at: now,
        expires_at: now + HOUR,
        grant_id: grant.grant_id,
      },
      alice.privateKey,
    );

    // Both the standalone token check and the against-grant check pass.
    expect(await verifyDelegation(tick)).toBe(true);
    expect(await verifyTokenAgainstGrant(tick, grant)).toEqual({ valid: true });

    // The injected revocation seam flows through too.
    expect((await verifyTokenAgainstGrant(tick, grant, { isRevoked: () => true })).valid).toBe(
      false,
    );
  });

  it("verifies a DelegationRevocation signature through the verifier surface", async () => {
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
    // A tampered grant_id breaks the signature.
    expect(await verifyDelegationRevocation({ ...rev, grant_id: "other" })).toBe(false);
  });
});
