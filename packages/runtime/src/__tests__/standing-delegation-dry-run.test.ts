/**
 * Hard-zero dry-run — Increment 2, first slice of the autonomous standing-delegation
 * execution arc.
 *
 * GOAL (per the principal-review audit): the R4 autonomous-money path is wired
 * end-to-end in the codebase but NEVER REACHED in production (`verifyGrantForTurn`
 * has no live caller). The audit's de-risking move is to exercise that path and
 * watch it fail closed — BEFORE any live caller, any grant store, or any real money
 * is in play. This test does exactly that: it drives the genuine chain
 *
 *     signed StandingDelegation + DelegationToken   (real @motebit/crypto)
 *       → verifyGrantForTurn                         (the sole verifiedGrant producer)
 *       → PolicyGate R4 step-8b invariant            (verifiedGrant unlocks auto-exec)
 *       → GrantBlastRadiusEnforcer                   (the zero-ceiling backstop)
 *
 * and asserts it fails closed at every layer. It changes ZERO production code:
 * `verifyGrantForTurn` still has no production caller, so production behavior is
 * byte-identical — this is the dry run, not the wiring.
 *
 * The "structurally-enforced zero ceiling": no grant carries a spend ceiling yet, so
 * the blast-radius enforcer denies ALL autonomous spend (`ceiling_absent`). Even on
 * the turn where the gate auto-clears R4, the enforcer — composed as an AND guard —
 * denies the money. Net: the path is reachable, and zero money can move.
 *
 * Doctrine: docs/doctrine/memory-never-confers-authority.md (the R4 invariant),
 * docs/doctrine/verify-family-fail-closed.md (the blast-radius floor).
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signDelegation,
  signStandingDelegation,
  signDelegationRevocation,
} from "@motebit/crypto";
import {
  PolicyGate,
  evaluateBlastRadius,
  freshGrantSpendState,
  type MoneyAction,
} from "@motebit/policy";
import {
  RiskLevel,
  SideEffect,
  AgentTrustLevel,
  type ToolDefinition,
  type TurnContext,
  type DelegationToken,
  type StandingDelegation,
} from "@motebit/protocol";
import { verifyGrantForTurn } from "../grant-verifier.js";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };
const HOUR = 3_600_000;
const NOW = Date.now();

/** A real signed standing grant authorizing the `pay_invoice` capability. */
async function makeGrant(delegator: Kp, delegate: Kp): Promise<StandingDelegation> {
  return signStandingDelegation(
    {
      grant_id: "grant-dry-run-1",
      delegator_id: "did:motebit:alice",
      delegator_public_key: bytesToHex(delegator.publicKey),
      delegate_id: "did:motebit:bob",
      delegate_public_key: bytesToHex(delegate.publicKey),
      scope: "pay_invoice",
      subject: "billing:vendor=acme",
      cadence_ms: 24 * HOUR,
      issued_at: NOW,
      not_before: null,
      expires_at: NOW + 90 * 24 * HOUR,
      max_token_ttl_ms: HOUR,
    },
    delegator.privateKey,
  );
}

/** A real delegator-signed per-tick token under the grant. */
async function mintTick(grant: StandingDelegation, delegator: Kp): Promise<DelegationToken> {
  return signDelegation(
    {
      delegator_id: grant.delegator_id,
      delegator_public_key: grant.delegator_public_key,
      delegate_id: grant.delegate_id,
      delegate_public_key: grant.delegate_public_key,
      scope: "pay_invoice",
      issued_at: NOW,
      expires_at: NOW + HOUR,
      grant_id: grant.grant_id,
    },
    delegator.privateKey,
  );
}

const moneyTool: ToolDefinition = {
  name: "pay_invoice",
  description: "Pay an invoice onchain",
  inputSchema: { type: "object" },
  riskHint: { risk: RiskLevel.R4_MONEY, sideEffect: SideEffect.IRREVERSIBLE },
};

function ctx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: "turn-dry-run",
    toolCallCount: 0,
    turnStartMs: NOW,
    costAccumulated: 0,
    ...overrides,
  };
}

/** A three-band gate that allows R4 but gates it behind approval (the production posture). */
function bandedGate(): PolicyGate {
  return new PolicyGate({
    requireApprovalAbove: RiskLevel.R1_DRAFT,
    denyAbove: RiskLevel.R4_MONEY,
  });
}

describe("standing-delegation hard-zero dry-run — the never-reached R4 path, fail-closed end-to-end", () => {
  it("fail-closed default: production reality — no verifiedGrant ⇒ R4 money requires human approval", () => {
    // This is what every production turn sees today: verifiedGrant is always null,
    // so even a Trusted caller cannot auto-execute money (step 8b re-raises).
    const decision = bandedGate().validate(
      moneyTool,
      {},
      ctx({ callerTrustLevel: AgentTrustLevel.Trusted, callerMotebitId: "trusted-mote" }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
  });

  it("the path IS reachable: a REAL crypto grant verified by verifyGrantForTurn unlocks R4 auto-exec", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const token = await mintTick(grant, alice);

    // The sole production producer, driven for real — not a stubbed {grant_id, verified_at}.
    const verifiedGrant = await verifyGrantForTurn(token, grant, []);
    expect(verifiedGrant).not.toBeNull();

    const decision = bandedGate().validate(
      moneyTool,
      {},
      ctx({ callerTrustLevel: AgentTrustLevel.Trusted, verifiedGrant: verifiedGrant! }),
    );
    // step 8b does not re-raise: the verified grant clears R4 auto-execution.
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("revocation bites end-to-end: a revoked grant ⇒ verifyGrantForTurn null ⇒ approval required again", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const token = await mintTick(grant, alice);
    const revocation = await signDelegationRevocation(
      {
        grant_id: grant.grant_id,
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        revoked_at: NOW,
      },
      alice.privateKey,
    );

    const verifiedGrant = await verifyGrantForTurn(token, grant, [revocation]);
    expect(verifiedGrant).toBeNull(); // fail-closed: revocation wins

    const decision = bandedGate().validate(
      moneyTool,
      {},
      ctx({ callerTrustLevel: AgentTrustLevel.Trusted, verifiedGrant: verifiedGrant ?? undefined }),
    );
    expect(decision.requiresApproval).toBe(true);
  });

  it("the zero-ceiling backstop: even when the gate auto-clears, the enforcer denies the money", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const token = await mintTick(grant, alice);
    const verifiedGrant = await verifyGrantForTurn(token, grant, []);

    // Layer 1 — the gate authorizes auto-execution (a verified grant is present).
    const gateDecision = bandedGate().validate(
      moneyTool,
      {},
      ctx({ callerTrustLevel: AgentTrustLevel.Trusted, verifiedGrant: verifiedGrant! }),
    );
    expect(gateDecision.requiresApproval).toBe(false); // gate says: go

    // Layer 2 — the blast-radius enforcer is the AND guard. No grant carries a ceiling
    // yet, so it denies ALL autonomous spend. This is the structurally-enforced zero ceiling.
    const action: MoneyAction = { amount_micro: 1_000_000, counterparty: grant.subject };
    const enforced = evaluateBlastRadius(
      {}, // no ceiling exists for this grant
      freshGrantSpendState(grant.grant_id, NOW),
      action,
      0,
      NOW,
    );
    expect(enforced.decision.allowed).toBe(false);
    expect(enforced.decision.denial).toBe("ceiling_absent");

    // Composition (the dispatch's eventual AND): gate-allow ∧ enforcer-allow ⇒ no money.
    const wouldMove = gateDecision.requiresApproval === false && enforced.decision.allowed;
    expect(wouldMove).toBe(false); // zero money — the dry run holds
  });
});
