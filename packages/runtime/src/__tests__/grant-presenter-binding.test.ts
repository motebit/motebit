/**
 * Finding 3 — `verifyGrantForTurn` binds the grant to its PRESENTER.
 *
 * A standing grant authorizes its `delegate` and nobody else. The verifier
 * checked signature, revocation, TTL and the tick-against-grant chain, but
 * never asked WHO was presenting the grant: a grant signed for delegate A,
 * presented by B, verified — so any path that let a caller ride a grant it
 * did not hold inherited the delegate's authority. The check lives in the
 * single verifier so every presentation path inherits it.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signDelegation,
  signStandingDelegation,
} from "@motebit/crypto";
import type { DelegationToken, StandingDelegation } from "@motebit/protocol";
import { verifyGrantForTurn } from "../grant-verifier.js";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };
const HOUR = 3_600_000;

async function grantTo(delegator: Kp, delegateId: string, delegate: Kp) {
  const now = Date.now();
  const grant: StandingDelegation = await signStandingDelegation(
    {
      grant_id: `grant-bind-${crypto.randomUUID()}`,
      delegator_id: "owner-x",
      delegator_public_key: bytesToHex(delegator.publicKey),
      delegate_id: delegateId,
      delegate_public_key: bytesToHex(delegate.publicKey),
      scope: "transfer_funds",
      subject: "market:self-funded",
      cadence_ms: 24 * HOUR,
      issued_at: now,
      not_before: null,
      expires_at: now + 7 * 24 * HOUR,
      max_token_ttl_ms: HOUR,
    },
    delegator.privateKey,
  );
  const token: DelegationToken = await signDelegation(
    {
      delegator_id: grant.delegator_id,
      delegator_public_key: grant.delegator_public_key,
      delegate_id: grant.delegate_id,
      delegate_public_key: grant.delegate_public_key,
      scope: grant.scope,
      issued_at: now,
      expires_at: now + HOUR,
      grant_id: grant.grant_id,
    },
    delegator.privateKey,
  );
  return { grant, token };
}

describe("verifyGrantForTurn — presenter binding (finding 3)", () => {
  it("a grant for delegate A presented by B confers nothing", async () => {
    const owner = await generateKeypair();
    const a = await generateKeypair();
    const b = await generateKeypair();
    const { grant, token } = await grantTo(owner, "agent-a", a);
    const v = await verifyGrantForTurn(token, grant, [], {
      presenter: { motebitId: "agent-b", publicKeyHex: bytesToHex(b.publicKey) },
      delegator: { motebitId: "owner-x", publicKeyHex: bytesToHex(owner.publicKey) },
    });
    expect(v).toBeNull();
  });

  it("B claiming A's id but holding a different key confers nothing", async () => {
    const owner = await generateKeypair();
    const a = await generateKeypair();
    const b = await generateKeypair();
    const { grant, token } = await grantTo(owner, "agent-a", a);
    const v = await verifyGrantForTurn(token, grant, [], {
      presenter: { motebitId: "agent-a", publicKeyHex: bytesToHex(b.publicKey) },
      delegator: { motebitId: "owner-x", publicKeyHex: bytesToHex(owner.publicKey) },
    });
    expect(v).toBeNull();
  });

  it("the grant's own delegate presenting it verifies", async () => {
    const owner = await generateKeypair();
    const a = await generateKeypair();
    const { grant, token } = await grantTo(owner, "agent-a", a);
    const v = await verifyGrantForTurn(token, grant, [], {
      presenter: { motebitId: "agent-a", publicKeyHex: bytesToHex(a.publicKey).toUpperCase() },
      delegator: { motebitId: "owner-x", publicKeyHex: bytesToHex(owner.publicKey) },
    });
    expect(v).not.toBeNull();
    expect(v?.grant_id).toBe(grant.grant_id);
  });
});

describe("verifyGrantForTurn — delegator binding", () => {
  it("a grant whose delegator is not the verifying runtime confers nothing", async () => {
    const owner = await generateKeypair();
    const a = await generateKeypair();
    const { grant, token } = await grantTo(owner, "agent-a", a);
    const presenter = { motebitId: "agent-a", publicKeyHex: bytesToHex(a.publicKey) };
    const self = await generateKeypair();
    // Another runtime's identity: the grant spends owner-x's money, not ours.
    expect(
      await verifyGrantForTurn(token, grant, [], {
        presenter,
        delegator: { motebitId: "self-y", publicKeyHex: bytesToHex(self.publicKey) },
      }),
    ).toBeNull();
    // Our id, but signed under a key that is not ours.
    expect(
      await verifyGrantForTurn(token, grant, [], {
        presenter,
        delegator: { motebitId: "owner-x", publicKeyHex: bytesToHex(self.publicKey) },
      }),
    ).toBeNull();
    // No key to check against: refused, never an id-only match.
    expect(
      await verifyGrantForTurn(token, grant, [], {
        presenter,
        delegator: { motebitId: "owner-x" },
      }),
    ).toBeNull();
  });

  it("the produced value is frozen, its ceiling a frozen copy", async () => {
    const owner = await generateKeypair();
    const a = await generateKeypair();
    const { grant, token } = await grantTo(owner, "agent-a", a);
    const v = await verifyGrantForTurn(token, grant, [], {
      presenter: { motebitId: "agent-a", publicKeyHex: bytesToHex(a.publicKey) },
      delegator: { motebitId: "owner-x", publicKeyHex: bytesToHex(owner.publicKey) },
    });
    expect(v).not.toBeNull();
    expect(Object.isFrozen(v)).toBe(true);
  });
});
