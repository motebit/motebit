/**
 * #875 review R2 — the field-exhaustive classification and guardian
 * provenance, ported for identity-authority Inc 2
 * (docs/design/identity-authority-writers.md §7).
 *
 * Ported from `fix/875-key-pop-v2` @ 373221619. Part 1 — every table that
 * carries an identity column (derived from the live schema, never a hand
 * list) is classified PARKED or INERT, and a new table fails until it is
 * classified — is ported as-is: it is the census D5 refers to ("auto-parking a
 * sovereign squat clears every authority-bearing field attributable to the
 * squatter"). The PARKED verdicts name what Inc 3's `parkSovereignSquat` will
 * clear; nothing parks in this tree.
 *
 * Not ported: the reviewer's sequences and part 2 (planted by X, then V's
 * signed bootstrap parks, then every X door refused). Each asserts a door
 * REFUSING a request this tree admits (unsigned bootstrap, a keyless guardian
 * write by a planted row, an unproven recovery); Inc 2 refuses nothing new, so
 * they return with Inc 3. Ported instead: guardian provenance (v60) as data —
 * the rows `recordGuardianEvidence` writes and the standing rule
 * `guardianRowStands` applies.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bytesToHex, generateKeypair } from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import {
  guardianEvidenceRows,
  guardianRowStands,
  recordGuardianEvidence,
} from "../identity-keys.js";
import { createTestRelay } from "./test-helpers.js";

let relay: SyncRelay;
beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

const db = () => relay.moteDb.db;

describe("guardian provenance (v60) — a guardian stands only when set under a standing key, or by the operator", () => {
  it("records one row per guardian ever set, keyed (identity, guardian)", async () => {
    const id = crypto.randomUUID();
    const k = bytesToHex((await generateKeypair()).publicKey);
    const g1 = bytesToHex((await generateKeypair()).publicKey);
    const g2 = bytesToHex((await generateKeypair()).publicKey);
    recordGuardianEvidence(db(), {
      motebitId: id,
      guardianPublicKey: g1,
      setUnderKey: k,
      evidence: "key_proof",
      now: 1,
    });
    recordGuardianEvidence(db(), {
      motebitId: id,
      guardianPublicKey: g2,
      setUnderKey: null,
      evidence: "operator",
      now: 2,
    });
    // Re-setting g1 updates its row, never adds one.
    recordGuardianEvidence(db(), {
      motebitId: id,
      guardianPublicKey: g1,
      setUnderKey: k,
      evidence: "holder",
      now: 3,
    });
    const rows = guardianEvidenceRows(db(), id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.guardian_public_key === g1)?.evidence).toBe("holder");
  });

  it("stands: operator always; otherwise only under a key in the standing set", async () => {
    const k = bytesToHex((await generateKeypair()).publicKey);
    const other = bytesToHex((await generateKeypair()).publicKey);
    const standing = new Set([k]);
    expect(
      guardianRowStands(
        { guardian_public_key: "g", set_under_key: null, evidence: "operator" },
        standing,
      ),
    ).toBe(true);
    expect(
      guardianRowStands(
        { guardian_public_key: "g", set_under_key: k.toUpperCase(), evidence: "bearer" },
        standing,
      ),
    ).toBe(true);
    expect(
      guardianRowStands(
        { guardian_public_key: "g", set_under_key: other, evidence: "bearer" },
        standing,
      ),
    ).toBe(false);
    expect(
      guardianRowStands(
        { guardian_public_key: "g", set_under_key: null, evidence: "bearer" },
        standing,
      ),
    ).toBe(false);
  });

  it("refuses a guardian that is not a 32-byte key", () => {
    expect(() =>
      recordGuardianEvidence(db(), {
        motebitId: crypto.randomUUID(),
        guardianPublicKey: "zz",
        setUnderKey: null,
        evidence: "operator",
        now: 1,
      }),
    ).toThrow(/64-hex/);
  });
});

// ── 1. The schema, classified ──

/** The gate's identity-column rule (`check-identity-authority-writers`), applied to the live schema. */
const IDENTITY_COLUMN =
  /^(motebit_id|\w+_motebit_id|agent_id|worker_id|submitted_by|submitter_id|delegator_id|filed_by|respondent|approver_id|owner_id|revoked_by)$/;

type Verdict = "parked" | "inert";
/**
 * Every table with an identity column. PARKED: `parkSovereignSquat` clears
 * what a squatter planted (and the guarded columns are written only under the
 * proven key). INERT: the reason it confers no authority over the identity —
 * what V is served, who may rotate or recover it, where it is paid.
 */
const CLASSIFIED: Record<string, [Verdict, string]> = {
  agent_registry: [
    "parked",
    "key, guardian, endpoint, capabilities, metadata, settlement address/modes, sweep threshold — cleared and delisted; guardian/settlement written only under the proven key",
  ],
  devices: ["parked", "each non-standing keyed row verified tokens AS the identity — removed"],
  identity_keys: ["parked", "a non-standing holder (E-main/E-op transplant of a squat) — removed"],
  relay_registry_key_evidence: ["parked", "provenance of the squatted registry key — dropped"],
  relay_guardian_evidence: [
    "parked",
    "guardian provenance recorded under a key that does not stand — dropped",
  ],
  relay_service_listings: [
    "parked",
    "the squatter's listing (capabilities, pricing, pay_to_address) — removed",
  ],
  relay_push_tokens: ["parked", "push tokens of the parked device rows — removed"],
  pairing_sessions: [
    "parked",
    "every pairing of an identity with no standing key is the squatter's (approve writes device rows) — removed",
  ],
  relay_key_successions: [
    "parked",
    "links that do not stand (a squat chain, an unproven recovery) — removed; they set departure",
  ],
  relay_delegation_revocations: [
    "parked",
    "revocations signed in V's name by a key that does not stand fence V's tasks — removed",
  ],
  relay_bond_commitments: [
    "parked",
    "a bond under a key that does not stand is an eligibility signal for V on X's word — removed",
  ],
};

describe("1 — every table keyed by an identity is classified", () => {
  it("the live schema's identity tables are exactly the classified ones", () => {
    const tables = (
      db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    const keyed = tables
      .filter((t) =>
        (db().prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).some((c) =>
          IDENTITY_COLUMN.test(c.name),
        ),
      )
      .sort();
    const unclassified = keyed.filter((t) => !(t in CLASSIFIED) && !(t in INERT));
    const stale = [...Object.keys(CLASSIFIED), ...Object.keys(INERT)].filter(
      (t) => !keyed.includes(t),
    );
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });
});

/** INERT tables, each with why it confers no authority over the identity's key, recovery or pay-to. */
const SYNCED =
  "the identity's own synced interior data — written only through a BoundIdentity (rule 26); no key, guardian, departure or pay-to is read from it";
const LOCAL =
  "a surface-local runtime table the relay's schema shares (persistence package); no relay route reads it as authority";
const MONEY =
  "money or settlement history the identity holds or owes — moved only by its own ledger rules (rule 29); park never moves money, and nothing here names a key or pay-to the relay serves";
const AUDIT =
  "an append-only record of what happened (receipts, events, audit) — read as history, never as the identity's key, guardian, departure or pay-to";
const INERT: Record<string, string> = {
  agent_trust: LOCAL,
  approval_queue: LOCAL,
  audit_log: LOCAL,
  budget_allocations: LOCAL,
  conversation_messages: LOCAL,
  conversations: LOCAL,
  goal_outcomes: LOCAL,
  goal_runs: LOCAL,
  goals: LOCAL,
  gradient_snapshots: LOCAL,
  halt_state: LOCAL,
  issued_credentials: LOCAL,
  latency_stats: LOCAL,
  memory_nodes: LOCAL,
  paid_intent_ledger: LOCAL,
  plan_steps: LOCAL,
  plans: LOCAL,
  runtime_liveness: LOCAL,
  service_listings: LOCAL,
  settlements: LOCAL,
  state_snapshots: LOCAL,
  events: SYNCED,
  sync_conversation_messages: SYNCED,
  sync_conversations: SYNCED,
  sync_plan_steps: SYNCED,
  sync_plans: SYNCED,
  relay_event_seq: SYNCED,
  relay_event_seq_counter: SYNCED,
  relay_approval_metadata: SYNCED,
  relay_approval_votes: SYNCED,
  identities:
    "existence only (owner_id is the id itself for a self-registered identity); no key, guardian or pay-to column",
  relay_accounts: MONEY,
  relay_transactions: MONEY,
  relay_withdrawals: MONEY,
  relay_pending_withdrawals: MONEY,
  relay_allocations: MONEY,
  relay_settlements: MONEY,
  relay_federation_settlements: MONEY,
  relay_settlement_payee_corrections: MONEY,
  relay_x402_settlements: MONEY,
  relay_refund_log: MONEY,
  relay_deposit_log: MONEY,
  relay_p2p_proof_claims: MONEY,
  relay_subscriptions: MONEY,
  relay_agent_wallets:
    "a deposit address whose inbound transfers CREDIT the identity's account — money in, never a destination the identity is paid at or a key",
  relay_receipts: AUDIT,
  relay_auth_events: AUDIT,
  relay_revocation_events: AUDIT,
  relay_execution_ledgers: AUDIT,
  relay_task_queue: AUDIT,
  relay_idempotency_keys: AUDIT,
  relay_delegation_edges: AUDIT,
  relay_latency_stats: AUDIT,
  relay_collaborative_step_results: AUDIT,
  relay_proposals: AUDIT,
  relay_proposal_participants: AUDIT,
  relay_disputes: AUDIT,
  relay_dispute_evidence: AUDIT,
  relay_witness_omission_disputes: AUDIT,
  relay_key_proofs_accepted:
    "replay record of an accepted proof (11-minute retention) — an accepted proof is answered idempotently and authorizes nothing new",
  relay_identity: "the relay's OWN identity row",
  relay_credentials:
    "credentials ABOUT the identity, each verified under its issuer; bound to the subject by evidence only (bindCredentialSubject) — never a key, guardian or pay-to",
  relay_revoked_credentials:
    "a revocation of a credential by its issuer or subject — ends a credential, confers no authority over the identity's key (a squatter's pre-#875 revocations are a stated denial residual)",
  relay_skill_registry:
    "the submitter is the did:key of the envelope's own signer, never a motebit_id a request names",
  relay_host_roster_entries:
    "entries held verbatim; the roster law verifies each against the sovereign's key history client-side (`verifyHostRoster`) — the relay never reduces it",
  relay_host_liveness:
    "observed liveness only; no quantified claim is computed over it (machine-roster doctrine)",
  relay_motebit_intake:
    "a signed announcement counted for health metrics; no route reads its key as the identity's",
  relay_token_blacklist:
    "an identity's revocation of its OWN token ids (keyed by identity + jti); revokes, never grants",
  relay_identity_revocations:
    "a revocation record ENDS the identity's tokens; lifted only by migration arrival or the operator (rule 22) — a squatter's pre-#875 `/revoke` is a denial residual, never a takeover",
  relay_agent_revocations:
    "the operator's signed revocation feed — the operator's act, not a request's",
  relay_migrations:
    "a departure token ends the identity here (revocation, a denial residual like /revoke), never moves its key; arrival is verified by the sovereign binding",
  relay_accepted_migrations: "written only after a migration's sovereign binding verified (E-mig)",
};
