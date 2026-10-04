#!/usr/bin/env tsx
/**
 * `check-identity-authority-writers` — every door that writes a row filed
 * under an identity, or that decides who an identity is, must name the
 * principal that authorizes it.
 *
 * Why this exists. The weaknesses closed since 2026-09 have one shape:
 * **authority asserted over a target the request never proves a relationship
 * to.**
 *
 *   - #701 — a key succession could be recorded under another identity: the
 *     route never compared the caller to the identity in the path.
 *   - #713 — a federation peer could re-key or de-list any identity: the
 *     handler read the sender's signature as entitlement to speak about
 *     whatever `motebit_id` the event named.
 *   - #719 — any agent could revoke any credential: the route compared the
 *     caller to a path segment the caller chooses, never to the credential.
 *   - #846 — sync pushes filed each entry under the entry's own `motebit_id`;
 *     the subscription routes authenticated nothing; `migrate/cancel`,
 *     `migrate/depart`, the migration exports and `approvals` read a token's
 *     `mid` and never compared it to the path; `disputes/:id/resolve` took
 *     an operator's verdict from anyone.
 *   - #850 — `credentials/submit` filed a credential under the PATH id, never
 *     its own subject, so X filed V's credential under X and revoked it as
 *     its "subject"; a delegation revocation was verified against the key
 *     embedded in it, never a key the relay holds for its delegator.
 *
 * None was a logic error inside a function. Each was a door cut beside the
 * doors that already had the rule, without the rule.
 *
 * What this gate asserts, in four parts — and only these:
 *
 *   1. SQL writers are a CLOSED set. Every INSERT, INSERT OR REPLACE /
 *      REPLACE, UPDATE [OR …] and DELETE against a table that carries an
 *      identity is registered — file, verb, table, count — with the principal
 *      that may cause it. The table set is DERIVED, not listed: every `CREATE
 *      TABLE` in the scanned roots with a column naming an identity
 *      (`motebit_id`, `*_motebit_id`, `agent_id`, `worker_id`,
 *      `submitted_by`, `submitter_id`, `delegator_id`, `filed_by`,
 *      `respondent`, `approver_id`, `owner_id`, `revoked_by`) joins it, plus
 *      the authority tables below. A new per-identity table widens the gate
 *      by existing. The total found must equal the total registered.
 *   2. No write re-files a row. A SET list — an UPDATE's, or an upsert's
 *      `ON CONFLICT … DO UPDATE SET` — may not assign an identity column in
 *      any spelling SQLite accepts (bare, "quoted", `backticked`, [bracketed],
 *      table-qualified, or inside a row-value target `(a, b) = (…)`); an
 *      unreadable SET item in such a statement is refused. An upsert whose
 *      conflict key is not an identity column (an id the request chooses) must
 *      carry the owner conjunct `<table>.<id col> = excluded.<id col>` at the
 *      top level of its DO UPDATE WHERE, ANDed, with no depth-0 OR anywhere in
 *      the conjunction (#860 review: `<owner> OR <anything>` passed v3).
 *   3. `BoundIdentity` is structurally intact (K1–K4 below): a class with an
 *      ES private field and a module-private minting path in
 *      `identity-binding.ts`; mints only in registered producers, and binding
 *      calls (`bindCaller`, `bindBySignature`, `bindSyncEntries`,
 *      `bindSocketEntries`, `bindCredentialSubject`,
 *      `bindByDelegationRevocation`) only at registered doors; every function with a
 *      `BoundIdentity` parameter is a registered writer that reads it ONLY as
 *      `unwrapBound(owner)`. The gate does NOT claim a forged BoundIdentity is
 *      caught here — the type cannot be made unforgeable (#860: six forgeries
 *      in ordinary TypeScript). A forgery is refused at RUNTIME: `unwrapBound`
 *      performs the private-brand check and throws, proven against every
 *      writer by `services/relay/src/__tests__/identity-binding-forgery.test.ts`.
 *   4. Event-store appends are a CLOSED set: `EventStore.append` takes the
 *      entry's own `motebit_id`, so the relay may call it only through
 *      `appendBoundEvent` or at a registered relay-authored site.
 *
 * Every number the gate prints is one it asserts on (a registered total, a
 * must-read list, or a sum it checks).
 *
 * That is deliberately not a proof that a site is correct — a gate cannot
 * read an authorization. It forces the question to be answered in writing at
 * the moment the door is cut, which is the step every one of these skipped.
 *
 * Scope, stated because a green gate's claim is only as wide as what it
 * scanned (`docs/doctrine/gate-repair-instructions.md`): it reads
 * `services/relay/src` and `packages/persistence/src`, skipping `__tests__`
 * and `dist`, syntactically (no type checker). It cannot see a statement
 * assembled at runtime (a table name in a variable, a SET item interpolated
 * with `${…}` — counted and printed), a statement split by `+`
 * concatenation, or a write issued from another package.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { failWithRepair } from "./lib/gate-report.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["services/relay/src", "packages/persistence/src"];

/** Tables whose rows decide who an identity is, or whether it may act. */
const AUTHORITY_TABLES = [
  "agent_registry",
  "devices",
  "relay_key_successions",
  "relay_revoked_credentials",
  "identity_keys",
  "relay_identity_revocations",
] as const;

/** A column naming an identity, at the start of a column definition. */
const IDENTITY_COLUMN =
  /^\s*(motebit_id|\w+_motebit_id|agent_id|worker_id|submitted_by|submitter_id|delegator_id|filed_by|respondent|approver_id|owner_id|revoked_by)\b/m;

/**
 * Tables the derivation finds that are NOT filed under an identity, each with
 * its reason. Keep this short; every entry is a hole in the aperture.
 */
const NOT_PER_IDENTITY: Readonly<Record<string, string>> = {
  relay_identity: "the relay's OWN identity row (its `owner_id` names the operator, not a motebit)",
};

/** Tables the gate must always cover — a derivation that loses one is itself a failure. */
const MUST_COVER = [
  "relay_subscriptions",
  "relay_approval_metadata",
  "relay_migrations",
  "events",
  "sync_conversations",
  "sync_conversation_messages",
  "sync_plans",
  "sync_plan_steps",
] as const;

type Verb = "INSERT" | "REPLACE" | "UPDATE" | "DELETE";

interface Writer {
  /** Repo-relative file. */
  file: string;
  verb: Verb;
  table: string;
  /** How many such writes this file is expected to contain. */
  count: number;
  /**
   * WHO may cause this write, and what in the request proves they are that.
   * Not decoration — this sentence is the artifact the gate exists to force.
   */
  principal: string;
}

const R = "services/relay/src/";
const P = "packages/persistence/src/index.ts";

/** The relay acting on its own schedule — no request reaches these. */
const LOOP = "the relay itself — reached from no request";
/** A schema migration body: runs once at boot, over rows already held. */
const MIGRATION =
  "the relay itself — a schema migration body, run once at boot over rows already held; no request reaches it";
/**
 * A local storage adapter. On a surface it writes its own identity's
 * database; the relay reaches it only through the doors named per entry.
 */
const ADAPTER =
  "the storage adapter proves nothing itself. On a surface it writes the device's OWN identity's database. The relay does not call this writer from any route";

/**
 * The closed set. Keyed by file rather than line so ordinary edits do not
 * churn it, and counted so a SECOND door cut in a file that already has one
 * still fails — which is exactly how #713 and #719 were added.
 */
const WRITERS: readonly Writer[] = [
  // ── identity authority ────────────────────────────────────────────────
  {
    file: R + "identity-revocation.ts",
    verb: "INSERT",
    table: "relay_identity_revocations",
    count: 1,
    principal:
      "`recordIdentityRevocation`, called only by /api/v1/agents/:id/revoke after the route proved the caller IS the path identity (its own bearer, caller === path id) or the operator via the master token acting for it (#787). The record takes effect at once (`isAgentRevoked`) and is never terminal. This function proves nothing itself",
  },
  {
    file: R + "identity-revocation.ts",
    verb: "DELETE",
    table: "relay_identity_revocations",
    count: 1,
    principal:
      "`liftRevocation`, reached by exactly two doors: a verified migration arrival (after its sovereign binding verifies) and the operator's restore-listing (master token)",
  },
  {
    file: R + "identity-keys.ts",
    verb: "INSERT",
    table: "identity_keys",
    count: 2,
    principal:
      "two statements: `recordIdentityKey`, and the one-time v42 backfill (E-main, main's registry key only). The holder is written only on EVIDENCE (#703 §5f, §5i): E-sov (id is the sovereign commitment to the key AND the request proved possession), E-link (`applySuccession`, from the held key), E-mig (accept-migration after the sovereign binding), E-op (operator registration of a bare service identity). This function proves nothing itself",
  },
  {
    file: R + "identity-keys.ts",
    verb: "UPDATE",
    table: "identity_keys",
    count: 1,
    principal:
      "`recordIdentityGuardian`, called only by /agents/register after it verified the guardian's attestation over {action, guardian_public_key, motebit_id}; updates an existing holder row only",
  },
  {
    file: R + "tasks.ts",
    verb: "UPDATE",
    table: "agent_registry",
    count: 1,
    principal:
      "the identity itself — a receipt may reconcile the registry key ONLY to a key already registered as one of that identity's devices (main's heal, #703 build 4)",
  },
  {
    file: R + "agents.ts",
    verb: "INSERT",
    table: "agent_registry",
    count: 1,
    principal:
      "the identity itself — /agents/register files under `callerMotebitId` (the verified token's mid) or, for the master token, the body id; behind refusePublicDeviceRegistration (#693)",
  },
  {
    file: R + "agents.ts",
    verb: "UPDATE",
    table: "agent_registry",
    count: 4,
    principal:
      "four statements. Heartbeat: files under `callerMotebitId` (a device token) or the operator's body id. sweep-config: `callerMotebitId !== :motebitId` → 403. revoke-listing / restore-listing (two strings, one site): operator only (`if (callerMotebitId) 403`), recorded as a signed append-only relay_agent_revocations entry",
  },
  {
    file: R + "agent-revocation.ts",
    verb: "INSERT",
    table: "relay_agent_revocations",
    count: 1,
    principal:
      "the operator — revoke-listing / restore-listing refuse any device token (operator-only); the record is signed by the relay",
  },
  {
    file: R + "key-rotation.ts",
    verb: "UPDATE",
    table: "agent_registry",
    count: 1,
    principal:
      "the identity itself — /revoke refuses (recorded) another identity's token; its own token or the operator's master token marks the row",
  },
  {
    file: R + "registry-delist.ts",
    verb: "UPDATE",
    table: "agent_registry",
    count: 2,
    principal:
      "`delistRegistration` (called by /agents/deregister under `callerMotebitId` only) and `delistExpired` (the relay's lease sweep, no request)",
  },
  {
    file: R + "migrations.ts",
    verb: "UPDATE",
    table: "agent_registry",
    count: 1,
    principal: MIGRATION + " (v43: stamp `delisted_at` on rows already revoked)",
  },
  {
    file: R + "credentials.ts",
    verb: "REPLACE",
    table: "relay_revoked_credentials",
    count: 1,
    principal:
      "the credential's subject or its issuer, resolved from the credential row itself, or the operator; never the identity named in the path (#719). The row's subject is the identity the credential's OWN `credentialSubject.id` names — submit binds it (`bindCredentialSubject`, #850)",
  },
  {
    file: R + "succession-apply.ts",
    verb: "INSERT",
    table: "relay_key_successions",
    count: 1,
    principal:
      "the identity itself, or its designated guardian for a recovery — the ONE writer both doors (/rotate-key, the succession path of /agents/register) call after verifying the record's signatures and that it departs from a key this relay holds (#701, #702)",
  },
  {
    file: R + "succession-apply.ts",
    verb: "UPDATE",
    table: "devices",
    count: 1,
    principal:
      "the identity itself — the same verified succession moves every device row holding the key it retires, and only those, in the same transaction (#702)",
  },
  {
    file: R + "succession-apply.ts",
    verb: "UPDATE",
    table: "agent_registry",
    count: 2,
    principal:
      "the identity itself (or its guardian for a recovery) — the registry key moves only FROM the key the verified link retires, or into an empty master-token slot; and, in the same transaction, a `settlement_address` moves only when it is the RETIRED key's derived Solana address, to the new key's (a custom address is never touched; an open obligation already admitted to the retired address — a withdrawal destination, a P2P task's admitted pay-to — is never rewritten, only reported in `open_obligations`)",
  },
  {
    file: R + "succession-apply.ts",
    verb: "UPDATE",
    table: "pairing_sessions",
    count: 1,
    principal:
      "the identity itself — the same verified succession retires pending pairing sessions that would carry the retired key",
  },
  {
    file: R + "succession-apply.ts",
    verb: "UPDATE",
    table: "relay_service_listings",
    count: 1,
    principal:
      "the identity itself (or its guardian for a recovery) — the same verified succession moves a listing `pay_to_address` only when it is the RETIRED key's derived Solana address, to the new key's, in the same transaction; a custom address is never touched (only a derived-bound destination moves with the key)",
  },
  {
    file: R + "migration.ts",
    verb: "INSERT",
    table: "agent_registry",
    count: 1,
    principal:
      "the identity itself — accept-migration verifies the source relay's signed token and attestation, the sovereign key binding and the credential bundle signature before the row lands",
  },
  {
    file: R + "migration.ts",
    verb: "UPDATE",
    table: "agent_registry",
    count: 1,
    principal:
      "the identity itself — migrate/depart binds the caller to the path identity (`bindCaller`: its own token, or the operator's master token; another identity's token 403, recorded — #846). Before #846 any identity's admin:query token could depart B",
  },
  {
    file: R + "migration.ts",
    verb: "REPLACE",
    table: "agent_trust",
    count: 1,
    principal:
      "the arriving identity — accept-migration seeds its trust from the departure attestation after the signature checks above (the attestation's own motebit_id is not compared to the arrival: noted in the #846 v2 report)",
  },
  {
    file: P,
    verb: "REPLACE",
    table: "devices",
    count: 1,
    principal:
      "the identity itself — the relay reaches this through IdentityManager: bootstrap/register-self (refusePublicDeviceRegistration + signature), /device/register (master token), pairing approve (the approving device's own identity)",
  },
  // ── identity-owned rows: sync (#846) ─────────────────────────────────
  {
    file: R + "data-sync.ts",
    verb: "INSERT",
    table: "sync_conversations",
    count: 1,
    principal:
      "the path identity — `upsertSyncConversation(db, owner: BoundIdentity, …)`; the owner is minted by `bindSyncEntries` (HTTP) / `bindSocketEntries` (WS) only when every entry names the identity the token was verified for (#846). The upsert never rewrites a row another identity owns",
  },
  {
    file: R + "data-sync.ts",
    verb: "INSERT",
    table: "sync_conversation_messages",
    count: 1,
    principal:
      "the path identity — `upsertSyncMessage(db, owner: BoundIdentity, …)` after the entry binding; INSERT OR IGNORE never overwrites a held id",
  },
  {
    file: R + "data-sync.ts",
    verb: "INSERT",
    table: "sync_plans",
    count: 1,
    principal:
      "the path identity — `upsertSyncPlan(db, owner: BoundIdentity, …)` after the entry binding; never rewrites a row another identity owns",
  },
  {
    file: R + "data-sync.ts",
    verb: "REPLACE",
    table: "sync_plan_steps",
    count: 1,
    principal:
      "the path identity — `upsertSyncPlanStep(db, owner: BoundIdentity, …)` after the entry binding; a step_id another identity holds is never replaced (the owner is read first)",
  },
  {
    file: R + "migrations.ts",
    verb: "UPDATE",
    table: "sync_conversations",
    count: 1,
    principal: MIGRATION + " (plaintext free-text floor)",
  },
  {
    file: R + "migrations.ts",
    verb: "UPDATE",
    table: "sync_conversation_messages",
    count: 1,
    principal: MIGRATION + " (plaintext free-text floor)",
  },
  {
    file: R + "migrations.ts",
    verb: "UPDATE",
    table: "sync_plans",
    count: 1,
    principal: MIGRATION + " (plaintext free-text floor)",
  },
  {
    file: R + "migrations.ts",
    verb: "UPDATE",
    table: "sync_plan_steps",
    count: 1,
    principal: MIGRATION + " (plaintext free-text floor)",
  },
  {
    file: R + "migrations.ts",
    verb: "UPDATE",
    table: "events",
    count: 3,
    principal: MIGRATION + " (sensitive-content redaction of stored payloads)",
  },
  {
    file: R + "migrations.ts",
    verb: "INSERT",
    table: "relay_token_blacklist_v44",
    count: 1,
    principal: MIGRATION + " (v44 re-keys the blacklist to (motebit_id, jti))",
  },
  {
    file: R + "migrations.ts",
    verb: "DELETE",
    table: "relay_settlements",
    count: 1,
    principal: MIGRATION + " (de-duplication of settlement rows)",
  },
  {
    file: R + "migrations.ts",
    verb: "INSERT",
    table: "relay_settlement_payee_corrections",
    count: 1,
    principal:
      MIGRATION +
      " (v48, #959: records the true payee BESIDE a P2P row that named its payer — derived from the signer of the archived worker-signed receipt whose result_hash is the record's receipt_hash, exactly one such signer; the signed record is never rewritten)",
  },
  {
    file: R + "migrations.ts",
    verb: "UPDATE",
    table: "relay_settlements",
    count: 2,
    principal:
      MIGRATION +
      " (v48, #959: backfills `p2p_worker_leg = 'remote'` on a pre-#959 federated-ORIGIN row where durable data determines it, and returns a corrected P2P row the verifier failed on its worker leg — checked against the payer's wallet — to 'pending'; scope / verification columns only, never the payee)",
  },
  {
    file: R + "migrations.ts",
    verb: "INSERT",
    table: "relay_event_seq",
    count: 1,
    principal:
      MIGRATION +
      " (v46 backfills the ingest sequence (#868): one seq row per held event, filed under that event's OWN motebit_id, copied — never chosen)",
  },
  {
    file: R + "migrations.ts",
    verb: "REPLACE",
    table: "relay_event_seq",
    count: 1,
    principal:
      "the `relay_event_seq_stamp` TRIGGER (v46, #868) — fires only inside an INSERT into `events` and copies NEW.motebit_id, so its principal is exactly the principal of the event write it stamps (EVENT_APPENDS: `appendBoundEvent`, owner minted by the entry binding; tasks.ts's relay-authored event). It cannot file a seq under any identity but the event's own",
  },
  {
    file: R + "migrations.ts",
    verb: "REPLACE",
    table: "relay_event_seq_counter",
    count: 1,
    principal:
      MIGRATION +
      " (v46 sets each identity's per-identity seq counter to the last number the backfill gave that identity's OWN events)",
  },
  {
    file: R + "migrations.ts",
    verb: "INSERT",
    table: "relay_event_seq_counter",
    count: 1,
    principal:
      "the `relay_event_seq_stamp` TRIGGER (v46, #868) — increments the counter of NEW.motebit_id only, inside the INSERT into `events` it stamps; keyed on the identity column, so its principal is exactly the event write's (EVENT_APPENDS). Never decremented",
  },
  {
    file: R + "migrations.ts",
    verb: "DELETE",
    table: "relay_event_seq",
    count: 1,
    principal:
      "the `relay_event_seq_unstamp` TRIGGER (v46, #868) — fires only inside a DELETE from `events` and removes exactly that event's seq row; its principal is the event deletion's (compaction / horizon truncation, relay loop only)",
  },
  {
    file: P,
    verb: "INSERT",
    table: "events",
    count: 2,
    principal:
      "`append` / `appendWithClock`, which file an entry under its own motebit_id and prove nothing themselves. Relay callers are the closed EVENT_APPENDS set below: `appendBoundEvent` (sync doors, owner minted by the entry binding, #846) and tasks.ts's relay-authored TrustLevelChanged. INSERT OR IGNORE never overwrites a held event_id",
  },
  {
    file: P,
    verb: "UPDATE",
    table: "events",
    count: 2,
    principal:
      "tombstone / memory-content redaction, each scoped `WHERE … motebit_id = ?`. Relay callers: deletion propagation (scoped to the path identity, never the event's own motebit_id) and the admin memory DELETE (master token)",
  },
  {
    file: P,
    verb: "DELETE",
    table: "events",
    count: 2,
    principal:
      "compaction / horizon truncation for one motebit_id, reached by the relay's horizon loop only (" +
      LOOP +
      ")",
  },
  // ── money ────────────────────────────────────────────────────────────
  {
    file: R + "account-store-sqlite.ts",
    verb: "INSERT",
    table: "relay_accounts",
    count: 1,
    principal:
      "`getOrCreateAccount` — an empty zero-balance row; callers: first-person account routes (`requireFirstPerson`), settlement, verified funding (Stripe/deposit detector), and session-status (Stripe-verified). The unauthenticated subscription status read no longer creates rows (#846)",
  },
  {
    file: R + "account-store-sqlite.ts",
    verb: "UPDATE",
    table: "relay_accounts",
    count: 4,
    principal:
      "credit / debit. Credits: verified funding (Stripe webhook signature, deposit detector onchain read, Stripe session read server-side) and settlement of a verified receipt. Debits: task submission under `callerMotebitId` (dualAuth task:submit), withdraw under `requireFirstPerson`, migration waiver (signed by the identity)",
  },
  {
    file: R + "account-store-sqlite.ts",
    verb: "INSERT",
    table: "relay_transactions",
    count: 4,
    principal: "the ledger row of each credit/debit above, same principals",
  },
  {
    file: R + "account-store-sqlite.ts",
    verb: "INSERT",
    table: "relay_withdrawals",
    count: 1,
    principal: "/withdraw under `requireFirstPerson` (caller === path id, or the operator)",
  },
  {
    file: R + "account-store-sqlite.ts",
    verb: "UPDATE",
    table: "relay_withdrawals",
    count: 7,
    principal:
      "withdrawal lifecycle: the one-time migration mark `pre_claim_review = 1` on every row that was `pending` when `claimed_at` was added (createWithdrawalTables, no request, runs once; #921 round 3); (no blind status setter: `updateWithdrawalStatus` was deleted, #921) the operator's admin routes (master token) — /complete and /fail act FROM `pending` only and refuse a `processing` withdrawal 409; /reconcile acts FROM `processing` only, never while this process is handling the payout (claim until its outcome is written), and only once the payout provably landed or can never land: a Path 0 Solana payout is decided by the CHAIN for exactly the transactions recorded before broadcast (withdrawal-chain-payouts.ts: landed ⇒ only paid under that signature; every one failed or past its last valid block height ⇒ only not_paid; else refused — never a wall-clock horizon, #949), a legacy Solana claim by the chain's height past this process's first read, and a declared-horizon payout (legacy x402, batch sent-mode rails) by `reconcileOpensAt` (declared validity + margin, floored at RECONCILE_MIN_AGE_MS); always on an explicit operator attestation (#921) — the relay's rail loops (" +
      LOOP +
      "), and /withdraw's Path 0 auto-settle (Path 1 retired, #948: a 0x destination is refused before any debit) under `requireFirstPerson` on the withdrawal that same request created: the payout is sent only after `claimWithdrawalForPayout` (the CAS `pending → processing`, stamping claimed_at, in one transaction with the chain-record mark; a lost claim sends nothing, #921); then completed FROM `processing` only on a confirmed send; failed-and-refunded (`failWithdrawalAndRefund`, one transaction, status CAS on the named from-state so at most once) only on a send that landed and failed on-chain AND whose earlier broadcasts the adapter proved dead; otherwise left `processing` with an unresolved-payout note (`noteWithdrawalPayoutUnresolved`, failure_reason only, no status or balance change) (#920); the outcome comes from the chain adapter, never from the request body",
  },
  {
    file: R + "account-store-sqlite.ts",
    verb: "INSERT",
    table: "relay_pending_withdrawals",
    count: 1,
    principal:
      "`enqueuePendingWithdrawal` — /withdraw under `requireFirstPerson`, or the relay's sweep loop for an identity's own configured threshold",
  },
  {
    file: R + "account-store-sqlite.ts",
    verb: "UPDATE",
    table: "relay_pending_withdrawals",
    count: 1,
    principal:
      LOOP +
      ": `refundPendingWithdrawal` — the batch-withdrawal refund of a payout that provably never left: the `refund_owed → refunded` CAS committed with its ledger credit, at most once",
  },
  {
    file: R + "batch-withdrawals.ts",
    verb: "UPDATE",
    table: "relay_pending_withdrawals",
    count: 6,
    principal:
      LOOP +
      ": the batch-withdrawal fire path — the claim (`pending → firing` CAS), and each outcome FROM `firing` only: `fired` (with its withdrawal row, one transaction), `unknown` (the payout may have left: a `processing` withdrawal row in the same transaction, never a refund), `refund_owed` (proven not sent: `PayoutNotSentError` or a manual rail; refunded by the account store's `refundPendingWithdrawal`)",
  },
  {
    file: R + "batch-withdrawals.ts",
    verb: "INSERT",
    table: "relay_withdrawals",
    count: 1,
    principal:
      LOOP +
      ": the batch-withdrawal fire path, for a queue row it claimed (`pending → firing` CAS) before calling the rail; a fired payout the rail has not confirmed is recorded `processing` (claimed_at = fire time, payout_valid_until = the rail's declared validity or a 24h floor), never `pending`, so only the operator's reconcile settles it — except a rail that declares itself manual (`payoutMode: manual`, Stripe), whose fire sends nothing and is recorded `pending` for the ordinary admin complete/fail (#921); a failure whose outcome is unknown (any throw but `PayoutNotSentError` on a non-manual rail, a per-item batch failure, a send the process died in) is recorded the same `processing` way with an unresolved-payout note, never refunded",
  },
  {
    file: R + "deposit-detector.ts",
    verb: "INSERT",
    table: "relay_deposit_log",
    count: 1,
    principal: LOOP + ": an onchain transfer the detector READ into the identity's own wallet",
  },
  {
    file: R + "subscriptions.ts",
    verb: "INSERT",
    table: "relay_subscriptions",
    count: 2,
    principal:
      "Stripe: the webhook (signature-verified) and session-status (the session read server-side from Stripe, paid). KNOWN GAP (#846 v2): the session's motebit_id comes from the unauthenticated checkout",
  },
  {
    file: R + "subscriptions.ts",
    verb: "UPDATE",
    table: "relay_subscriptions",
    count: 5,
    principal:
      "Stripe-rooted writers (webhook signature; session-status' server-side session read) and `setSubscriptionStatus(db, owner: BoundIdentity, …)`, the only writer the owner routes (cancel, resubscribe) use — `bindCaller` proves the caller is the identity or the operator (#846; the routes had no authentication at all)",
  },
  {
    file: R + "allocation-escrow.ts",
    verb: "INSERT",
    table: "relay_allocations",
    count: 1,
    principal:
      "task submission (`openAllocation`, called by the submission path only) — the budget is locked from `submittedBy = callerMotebitId` (dualAuth task:submit) or the operator's body value, in the admission transaction with its hold (#901: no unfunded row commits)",
  },
  {
    file: R + "allocation-escrow.ts",
    verb: "UPDATE",
    table: "relay_allocations",
    count: 1,
    principal:
      MIGRATION +
      " (v55: `review_reason`, the operator-visible flag on an allocation a legacy row could not be attributed to cleanly — a marker, never an identity column)",
  },
  {
    file: R + "allocation-escrow.ts",
    verb: "INSERT",
    table: "relay_settlements",
    count: 2,
    principal:
      "the escrow chokepoint's `settlement_fee` (a relay-custody settlement of a verified receipt, payee = the receipt signer in the signed body, refused above what the allocation holds) and `recordP2pSettlementAudit` (a verified P2P payment proof; payee = the admitted `target_agent` the proof paid, `p2pPayeeOf`, never the path agent — #959). Known residual: the relay-mode row's column is still the path agent while its signed body names the credited receipt signer",
  },
  {
    file: R + "allocation-escrow.ts",
    verb: "INSERT",
    table: "relay_federation_settlements",
    count: 2,
    principal:
      "(1) the escrow chokepoint's `federated_forward` — this relay's own settlement forward of a task a federation peer returned a signed result for, from the allocation's held escrow; (2) `recordInboundFederatedSettlement` — a federation peer's signed settlement forward for a task this relay executed (no local escrow)",
  },
  {
    file: R + "allocation-escrow.ts",
    verb: "UPDATE",
    table: "relay_federation_settlements",
    count: 4,
    principal:
      LOOP +
      ": a forward's lifecycle — `delivered` on the peer's acknowledgement (settlement retry loop), `failed` on retry exhaustion (in the refund's transaction) — and the v55 migration's stamp/status backfill; never the identity columns",
  },
  {
    file: R + "allocation-escrow.ts",
    verb: "UPDATE",
    table: "relay_transactions",
    count: 3,
    principal:
      MIGRATION +
      " (v55: stamps existing settlement credits and dispute rows with the allocation they moved — `allocation_id` / `allocation_kind` only, never the account)",
  },
  {
    file: R + "tasks.ts",
    verb: "UPDATE",
    table: "relay_allocations",
    count: 2,
    principal:
      "settlement of a receipt whose token was verified for the path worker and whose signature verified",
  },
  {
    file: R + "tasks.ts",
    verb: "INSERT",
    table: "relay_credentials",
    count: 1,
    principal:
      "the relay issuing its own reputation credential from a verified receipt (issuer = the relay)",
  },
  {
    file: R + "tasks.ts",
    verb: "INSERT",
    table: "relay_delegation_edges",
    count: 1,
    principal: "a verified receipt between two identities (relay bookkeeping)",
  },
  {
    file: R + "tasks.ts",
    verb: "INSERT",
    table: "relay_latency_stats",
    count: 1,
    principal: "a verified receipt's timing (relay bookkeeping)",
  },
  {
    file: R + "index.ts",
    verb: "UPDATE",
    table: "relay_allocations",
    count: 4,
    principal:
      LOOP +
      ": stale-allocation release and settlement retry — each retires the allocation (`released`) or marks it for the operator, `review_reason` = `'unroutable_refund'` (no single hold payer to refund) or `'undetermined'` (its task is granted and unanswered — one task, one body; never refunded as stale) (a status/marker, never an identity column)",
  },
  {
    file: R + "index.ts",
    verb: "INSERT",
    table: "relay_refund_log",
    count: 1,
    principal: LOOP + ": settlement retry refunds the delegator of a lapsed allocation",
  },
  {
    file: R + "index.ts",
    verb: "UPDATE",
    table: "relay_proposals",
    count: 1,
    principal: LOOP + ": proposal expiry",
  },
  {
    file: R + "index.ts",
    verb: "DELETE",
    table: "relay_service_listings",
    count: 1,
    principal: LOOP + ": stale-listing sweep",
  },
  {
    file: R + "p2p-verifier.ts",
    verb: "UPDATE",
    table: "relay_settlements",
    count: 3,
    principal:
      LOOP +
      ": the p2p verifier's state transitions (verified / unverifiable / failed) from an onchain READ; the SET lists touch only verification columns, never the payee (#959)",
  },
  {
    file: R + "anchoring.ts",
    verb: "UPDATE",
    table: "relay_settlements",
    count: 1,
    principal: LOOP + ": settlement anchoring",
  },
  {
    file: R + "anchoring.ts",
    verb: "UPDATE",
    table: "relay_federation_settlements",
    count: 1,
    principal: LOOP + ": federation settlement anchoring",
  },
  {
    file: R + "federation-callbacks.ts",
    verb: "INSERT",
    table: "relay_credentials",
    count: 1,
    principal:
      "a federation peer's signed result carrying the worker's credential (signature verified)",
  },
  {
    file: R + "receipts-store.ts",
    verb: "INSERT",
    table: "relay_receipts",
    count: 1,
    principal: "a receipt chain whose signatures verified (append-only; relay rule 12)",
  },
  // ── identity lifecycle, keys, tokens ─────────────────────────────────
  {
    file: R + "key-rotation.ts",
    verb: "INSERT",
    table: "relay_token_blacklist",
    count: 1,
    principal:
      "the identity itself — /revoke-tokens refuses another identity's token (caller === path id, or the operator); rows keyed (motebit_id, jti)",
  },
  {
    file: R + "schema.ts",
    verb: "DELETE",
    table: "relay_token_blacklist",
    count: 1,
    principal: LOOP + ": expired-entry sweep",
  },
  {
    file: R + "key-rotation.ts",
    verb: "INSERT",
    table: "relay_approval_metadata",
    count: 1,
    principal:
      "the identity itself — `insertApproval(db, owner: BoundIdentity, …)`; POST /approvals binds the caller to the path identity (`bindCaller`, #846 — A's token filed approvals, with A's own quorum, under B)",
  },
  {
    file: R + "key-rotation.ts",
    verb: "UPDATE",
    table: "relay_approval_metadata",
    count: 2,
    principal:
      "a quorum vote — the approval must belong to the path identity, the approver must be in its quorum, and the vote is signed by the approver's key",
  },
  {
    file: R + "key-rotation.ts",
    verb: "INSERT",
    table: "relay_approval_votes",
    count: 1,
    principal: "the approver — the vote verified under the approver's own key",
  },
  {
    file: R + "migration.ts",
    verb: "INSERT",
    table: "relay_migrations",
    count: 1,
    principal:
      "the identity itself — /migrate verifies the identity's signed MigrationRequest under its key (`bindBySignature`)",
  },
  {
    file: R + "migration.ts",
    verb: "UPDATE",
    table: "relay_migrations",
    count: 4,
    principal:
      "`updateMigrationState(db, owner: BoundIdentity, …)` and `commitDeparture(db, owner: BoundIdentity, …)` (depart's waiver record + `departed` transition, one transaction with the waiver debit), each scoped WHERE motebit_id = unwrapBound(owner): /migrate (signature), attestation, export, cancel, depart (each `bindCaller` — #846: any identity's token cancelled, exported or departed B)",
  },
  {
    file: R + "migration.ts",
    verb: "INSERT",
    table: "relay_accepted_migrations",
    count: 1,
    principal: "accept-migration's replay record, after its signature checks",
  },
  {
    file: R + "pairing.ts",
    verb: "INSERT",
    table: "pairing_sessions",
    count: 1,
    principal: "/pairing/initiate — filed under the device:auth token's own mid",
  },
  {
    file: R + "pairing.ts",
    verb: "UPDATE",
    table: "pairing_sessions",
    count: 3,
    principal:
      "claim (knowledge of the pairing code, pending only), approve/deny (`session.motebit_id !== device.motebitId` → 403)",
  },
  {
    file: R + "agents.ts",
    verb: "REPLACE",
    table: "relay_push_tokens",
    count: 1,
    principal: "the caller — written under `callerMotebitId` (PK (motebit_id, device_id))",
  },
  {
    file: R + "agents.ts",
    verb: "DELETE",
    table: "relay_push_tokens",
    count: 1,
    principal: "the caller — deleted under `callerMotebitId`",
  },
  {
    file: R + "push-adapter.ts",
    verb: "DELETE",
    table: "relay_push_tokens",
    count: 1,
    principal: LOOP + ": a push provider reported the token dead",
  },
  {
    file: R + "agents.ts",
    verb: "REPLACE",
    table: "relay_execution_ledgers",
    count: 1,
    principal: "the operator — /agent/:id/ledger is master-token only",
  },
  {
    file: R + "agents.ts",
    verb: "INSERT",
    table: "relay_service_listings",
    count: 1,
    principal: "/agents/register's listing, under the registering identity",
  },
  {
    file: R + "listings.ts",
    verb: "INSERT",
    table: "relay_service_listings",
    count: 1,
    principal: "POST /listing — `callerMotebitId !== :motebitId` → 403",
  },
  {
    file: R + "listings.ts",
    verb: "DELETE",
    table: "relay_service_listings",
    count: 1,
    principal: "POST /listing's replace of its own listing, after the same check",
  },
  {
    file: R + "bond-store.ts",
    verb: "INSERT",
    table: "relay_bond_commitments",
    count: 1,
    principal:
      "the identity itself — POST /bond: body motebit_id must equal the path, and `recordBondCommitment` verifies the bond's signature under the identity's registered key. The upsert on the author-chosen `bond_id` updates only a row the same identity owns (#846 v3: it assigned `motebit_id`, re-filing another identity's bond); a held bond_id is refused",
  },
  {
    file: R + "bond-store.ts",
    verb: "UPDATE",
    table: "relay_bond_commitments",
    count: 1,
    principal: LOOP + ": the bond verifier's onchain backing read",
  },
  {
    file: R + "credentials.ts",
    verb: "INSERT",
    table: "relay_credentials",
    count: 1,
    principal:
      "credentials/submit, through `insertSubmittedCredential(db, owner: BoundIdentity, …)`: the VC's issuer signature verifies (the route is public — any party may carry it), and the row is filed only under the identity the credential's own `credentialSubject.id` names — `bindCredentialSubject` (#850): `did:motebit:<id>` must be the path id exactly; a `did:key` must be PROVEN the path identity's key — the path id is its sovereign commitment, or it is the #703 holder key; registry and device-row keys never bind or veto (#850 review). Before #850 it was filed under the PATH id, so X filed V's credential under X and could revoke it as its subject",
  },
  {
    file: R + "credential-anchoring.ts",
    verb: "UPDATE",
    table: "relay_credentials",
    count: 1,
    principal: LOOP + ": credential anchoring",
  },
  {
    file: R + "federation.ts",
    verb: "INSERT",
    table: "relay_revocation_events",
    count: 1,
    principal:
      "the relay's own signed revocation event, emitted by a door that already authorized the revocation (#713)",
  },
  {
    file: R + "delegation-revocations.ts",
    verb: "INSERT",
    table: "relay_delegation_revocations",
    count: 1,
    principal:
      "the delegator it names, through `insertDelegationRevocation(db, owner: BoundIdentity, …)`: `bindByDelegationRevocation` (#850) verifies the signature AND that its key is one this relay holds for `delegator_id` (`keysHeldBy` — a rotated-out key no longer speaks), looked up by the binder, never taken from the artifact alone. Anyone may carry the delegator's signed revocation. The relay holds no grants, so a row never proves the revoker is the GRANT's delegator; the acceptance fence (tasks.ts) therefore reads only through `isGrantRevokedBy(db, grant_id, submitter)` — a revocation fences a task only when its delegator is the task's authenticated submitter (#850)",
  },
  {
    file: R + "skill-registry.ts",
    verb: "REPLACE",
    table: "relay_skill_registry",
    count: 1,
    principal:
      "the submitter — the envelope's signature; the submitter id is the did:key of the signing key",
  },
  {
    file: R + "intake-routes.ts",
    verb: "INSERT",
    table: "relay_motebit_intake",
    count: 1,
    principal: "the announcing identity — signature plus sovereign binding (id commits to the key)",
  },
  {
    file: R + "host-roster-store.ts",
    verb: "INSERT",
    table: "relay_host_roster_entries",
    count: 1,
    principal:
      "the roster route: caller PRESENT and EQUAL to the path id (device:auth); each entry verified under the key it names (rule 24)",
  },
  {
    file: R + "host-roster-store.ts",
    verb: "INSERT",
    table: "relay_host_liveness",
    count: 1,
    principal: "a socket whose token verified for the identity and device (rule 24)",
  },
  {
    file: R + "host-roster-store.ts",
    verb: "DELETE",
    table: "relay_host_liveness",
    count: 1,
    principal: LOOP + ": 90-day liveness TTL",
  },
  {
    file: R + "idempotency.ts",
    verb: "INSERT",
    table: "relay_idempotency_keys",
    count: 1,
    principal: "the authenticated caller of a money route, keyed (key, motebit_id)",
  },
  {
    file: R + "idempotency.ts",
    verb: "UPDATE",
    table: "relay_idempotency_keys",
    count: 3,
    principal:
      "the same caller's completion, the binding of its claim to the task it admits, and the recording of that admitted request's outcome (#888) — all scoped by the claim's (key, motebit_id)",
  },
  {
    file: R + "idempotency.ts",
    verb: "INSERT",
    table: "relay_p2p_proof_claims",
    count: 1,
    principal:
      "`bindP2pProofToTask` (#918), called only inside an admission transaction that enqueues the task it names: the task-submit door, after the proof's payer was read from the chain and matched to the submitter's key (p2p-payer.ts), whose `submitted_by` is `submissionTerms`' submitter (the dualAuth-verified caller, else the operator's master-token-asserted body field), and the federation forward door after the origin peer's signature verified (its `submitted_by` is the payload's, else `relay:<origin>`). The row is keyed by the proof's tx hash, `INSERT OR IGNORE`, never overwritten or deleted: it grants nothing to the identity it names, which is read only to decide whether a refusal may disclose the task id to a caller whose VERIFIED token is that identity (or the operator)",
  },
  {
    file: R + "x402-settlements.ts",
    verb: "INSERT",
    table: "relay_x402_settlements",
    count: 1,
    principal:
      "`recordX402Intent` (#907 round 2), called only by the task-submit door's x402 `settle()`, after the facilitator VERIFIED the request's EIP-3009 authorization and the gate tied it to this request's quote and the relay treasury. The row is keyed by the authorization's own (payer, nonce), `INSERT OR IGNORE`, never overwritten: its `delegator_id` is `submissionTerms`' submitter (the dualAuth-verified caller, else the operator's master-token-asserted body field, else the path agent) — the same principal the handler debits — and it grants that identity nothing but the credit of the payment it carries",
  },
  {
    file: R + "x402-settlements.ts",
    verb: "UPDATE",
    table: "relay_x402_settlements",
    count: 14,
    principal:
      "the record's own resolution (#907 rounds 2–3), status and reconciler bookkeeping only, never its identity columns: `markX402Failed` on a definite facilitator refusal, or a chain read proving the authorization CANCELLED (an AuthorizationCanceled log), expired unexecuted (two agreeing complete scans, by the confirmed head's own timestamp), or executed with a non-matching paired Transfer (also written on a re-check, reason only); `creditX402Settlement` → credited in the transaction that credits the recorded `delegator_id` — by the settling request (from pending only), or by the reconciler / the operator's resolve door only on PROOF OF EXECUTION (an AuthorizationUsed log and the Transfer the token emitted right after it, to the treasury for the exact amount), consuming that Transfer log (`tx_hash`, `credit_log_index`, unique); and the reconciler's bookkeeping (`scan_from_block`, `scan_end_block`, `scanned_to_block`, `pass_cursor`, `last_checked_at`, `expiry_observed_at`, `recheck_count`, `mismatch_rechecks`, `next_recheck_at`, and the chain-time stamps `expiry_observed_head_ts` / `resolved_head_ts` / `next_recheck_head_ts` — round 10: a request-path failure is stamped with the confirmed head the reconciler first sees it under; round 8 split the spend into the mismatch budget and the expiry/refusal budget, each a compare-and-set on the observed generation; round 11: a re-check records a mismatch in `last_observation` / `mismatch_observed_head_ts` and never rewrites `failure_reason`, and the operator's resolve writes nothing unless it credits; rounds 12–13: the execution-evidence FLAG `used_state` (with `used_observed_tx` / `used_observed_head_ts` for display), written only from an AuthorizationUsed log a head-capped scan returned for this record's own (payer, nonce) — `mismatched` from its paired Transfer failing the checks — and the chain-time visit cadence `visit_backoffs` / `next_visit_head_ts`, set on evidence and on read errors, reset by a good read)",
  },
  {
    file: R + "migrations.ts",
    verb: "INSERT",
    table: "relay_p2p_proof_claims",
    count: 2,
    principal:
      MIGRATION +
      " (v47 backfills proof claims (#918) from tasks already queued and proofs already settled, copying each row's own submitter — never chosen)",
  },
  {
    file: R + "idempotency.ts",
    verb: "DELETE",
    table: "relay_idempotency_keys",
    count: 2,
    principal: "the same caller's release (scoped by motebit_id), and the TTL sweep",
  },
  {
    file: R + "task-queue.ts",
    verb: "INSERT",
    table: "relay_task_queue",
    count: 1,
    principal:
      "the durable mirror of an in-memory task entry the task routes already authorized — inserted once, unanswered (#890 r9: a live row is written by the version-checked UPDATE, never replaced)",
  },
  {
    file: R + "task-queue.ts",
    verb: "UPDATE",
    table: "relay_task_queue",
    count: 1,
    principal: "the same mirror",
  },
  {
    file: R + "task-queue.ts",
    verb: "DELETE",
    table: "relay_task_queue",
    count: 4,
    principal: "the same mirror, and its expiry / cap sweeps",
  },
  {
    file: R + "auth-events.ts",
    verb: "INSERT",
    table: "relay_auth_events",
    count: 1,
    principal: "the relay's own auth record (rule 6)",
  },
  {
    file: R + "auth-events.ts",
    verb: "DELETE",
    table: "relay_auth_events",
    count: 1,
    principal: LOOP + ": 30-day retention sweep",
  },
  // ── disputes and proposals ───────────────────────────────────────────
  {
    file: R + "disputes.ts",
    verb: "INSERT",
    table: "relay_disputes",
    count: 1,
    principal:
      "the filer — a DisputeRequest signed by `filed_by`'s registered key, and `filed_by` must be the allocation's worker or delegator (read from the settlement row / allocation_hold payer, never the body) with the other party as respondent (§4.4); guarded to one non-expired dispute per task",
  },
  {
    file: R + "disputes.ts",
    verb: "UPDATE",
    table: "relay_allocations",
    count: 2,
    principal:
      "(1) the same filing (flips a `locked`/`settled` allocation to `disputed`, guarded on the status it read); (2) the fund action that resolves the dispute — reached only from the operator's verdict finalized (lazy window expiry or round-2 appeal), closing `disputed` → `settled`/`released` once, behind the write-once `relay_dispute_fund_actions` claim",
  },
  {
    file: R + "disputes.ts",
    verb: "UPDATE",
    table: "relay_disputes",
    count: 7,
    principal:
      "state transitions: `/resolve` — the OPERATOR's act, master token only (#846 v2: it took any caller's verdict); appeal (a party's signature; guarded on the `resolved` state it read); lazy finalize and opened-expiry (time-driven). The filing's own `evidence` state is now set by its guarded INSERT. `fund_refusal` (`recordFundRefusal`): written only by the fund action of a verdict already being finalized (same reach as lazy finalize / round-2 appeal) — a marker on that dispute, never an identity column. The seventh: a refused round-2 verdict's retry (`tryFinalizePersistedRound2`) — the same transition the round-2 appeal makes, reached only from a dispute READ of an `appealed` dispute whose signed round-2 resolution the appeal persisted",
  },
  {
    file: R + "dispute-fund-ledger.ts",
    verb: "UPDATE",
    table: "relay_disputes",
    count: 1,
    principal:
      MIGRATION +
      " (v50: flag `fund_refusal = 'task_mismatch'` on disputes whose task is not their allocation's — a marker column, never an identity column)",
  },
  {
    file: R + "disputes.ts",
    verb: "INSERT",
    table: "relay_dispute_evidence",
    count: 1,
    principal: "a party — `submitted_by` must be filer or respondent, and the evidence is signed",
  },
  {
    file: R + "dispute-orchestration.ts",
    verb: "UPDATE",
    table: "relay_disputes",
    count: 1,
    principal:
      "federation resolution finalize — reached from `/resolve` (operator) and the orchestration worker (" +
      LOOP +
      ")",
  },
  {
    file: R + "horizon.ts",
    verb: "INSERT",
    table: "relay_witness_omission_disputes",
    count: 1,
    principal: "a federation peer's signed horizon dispute",
  },
  {
    file: R + "horizon.ts",
    verb: "DELETE",
    table: "relay_disputes",
    count: 1,
    principal: LOOP + ": retention horizon",
  },
  {
    file: R + "horizon.ts",
    verb: "DELETE",
    table: "relay_execution_ledgers",
    count: 1,
    principal: LOOP + ": retention horizon",
  },
  {
    file: R + "horizon.ts",
    verb: "DELETE",
    table: "relay_revocation_events",
    count: 1,
    principal: LOOP + ": retention horizon",
  },
  {
    file: R + "horizon.ts",
    verb: "DELETE",
    table: "relay_settlements",
    count: 1,
    principal: LOOP + ": retention horizon",
  },
  {
    file: R + "proposals.ts",
    verb: "INSERT",
    table: "relay_proposals",
    count: 1,
    principal: "the initiator — `callerMotebitId` (proposal token) or the operator's body value",
  },
  {
    file: R + "proposals.ts",
    verb: "INSERT",
    table: "relay_proposal_participants",
    count: 1,
    principal: "the initiator's invitation list — invitations, not acts of the invited",
  },
  {
    file: R + "proposals.ts",
    verb: "UPDATE",
    table: "relay_proposals",
    count: 2,
    principal: "respond (a participant, recorded refusal) and withdraw (the initiator only)",
  },
  {
    file: R + "proposals.ts",
    verb: "UPDATE",
    table: "relay_proposal_participants",
    count: 1,
    principal: "respond — the caller's own participant row",
  },
  {
    file: R + "proposals.ts",
    verb: "INSERT",
    table: "relay_collaborative_step_results",
    count: 1,
    principal:
      "a participant — its own row; the upsert updates only the reporter's own row, and a step another participant reported changes nothing and is refused 409, recorded (#846 v2: `INSERT OR REPLACE` let any participant re-file another's result)",
  },
  // ── persistence: surface-side stores (the relay never writes these from a route)
  ...(
    [
      ["REPLACE", "agent_trust", 1],
      ["UPDATE", "agent_trust", 1],
      ["REPLACE", "approval_queue", 1],
      ["UPDATE", "approval_queue", 4],
      ["INSERT", "audit_log", 1],
      ["INSERT", "budget_allocations", 1],
      ["UPDATE", "budget_allocations", 1],
      ["INSERT", "conversation_messages", 2],
      ["DELETE", "conversation_messages", 2],
      ["INSERT", "conversations", 2],
      ["UPDATE", "conversations", 3],
      ["DELETE", "conversations", 1],
      ["REPLACE", "goal_outcomes", 1],
      ["INSERT", "goal_runs", 1],
      ["UPDATE", "goal_runs", 3],
      ["REPLACE", "goals", 1],
      ["UPDATE", "goals", 6],
      ["DELETE", "goals", 1],
      ["REPLACE", "gradient_snapshots", 1],
      ["REPLACE", "halt_state", 1],
      ["UPDATE", "halt_state", 1],
      ["REPLACE", "identities", 1],
      ["REPLACE", "issued_credentials", 1],
      ["INSERT", "latency_stats", 1],
      ["REPLACE", "memory_nodes", 1],
      ["UPDATE", "memory_nodes", 3],
      ["DELETE", "memory_nodes", 1],
      ["INSERT", "paid_intent_ledger", 1],
      ["UPDATE", "paid_intent_ledger", 1],
      ["REPLACE", "plans", 1],
      ["INSERT", "runtime_liveness", 1],
      ["UPDATE", "runtime_liveness", 1],
      ["REPLACE", "service_listings", 1],
      ["DELETE", "service_listings", 1],
      ["REPLACE", "state_snapshots", 1],
    ] as const
  ).map(([verb, table, count]): Writer => ({
    file: P,
    verb,
    table,
    count,
    principal:
      table === "identities"
        ? "the identity itself — IdentityManager on a surface; on the relay, bootstrap/register-self (refusePublicDeviceRegistration + signature) and /identity (master token)"
        : table === "agent_trust"
          ? "the identity's own first-person trust ledger. " +
            ADAPTER +
            " except tasks.ts's verified-receipt update (the p2p verifier writes no trust edge since #959)"
          : table === "memory_nodes"
            ? "the identity's own memory. " +
              ADAPTER +
              "; the admin memory DELETE (master token) tombstones through `tombstoneNodeOwned`"
            : ADAPTER,
  })),
];

/**
 * UPDATEs that assign an identity column and are NOT a re-filing, each with
 * the reason. Every other such UPDATE fails outright.
 */
const REFILE_ALLOWED: ReadonlyArray<{ file: string; table: string; reason: string }> = [
  {
    file: R + "task-queue.ts",
    table: "relay_task_queue",
    reason:
      "the durable mirror re-writes `worker_id = task.motebit_id` and `submitter_id = submitted_by`, the task's own fixed target and submitter (the values its INSERT wrote — the pre-#890-r9 INSERT OR REPLACE re-wrote the same two), never another identity",
  },
];

/** Every call of a binding mint, per file. A new mint site is a new door. */
interface Mint {
  file: string;
  mint:
    | "bindCaller"
    | "bindBySignature"
    | "bindSyncEntries"
    | "bindSocketEntries"
    | "bindCredentialSubject"
    | "bindByDelegationRevocation";
  count: number;
  door: string;
}
const MINTS: readonly Mint[] = [
  {
    file: R + "sync-routes.ts",
    mint: "bindSyncEntries",
    count: 2,
    door: "POST /sync/:id/push, and GET /sync/:id/pull?after_seq= (#868: the seq read binds over no entries — the same presenter check, so it reads only the identity the token was verified for, or the path identity under the operator's master token)",
  },
  {
    file: R + "data-sync.ts",
    mint: "bindSyncEntries",
    count: 4,
    door: "POST /sync/:id/{conversations,messages,plans,plan-steps}",
  },
  {
    file: R + "websocket.ts",
    mint: "bindSocketEntries",
    count: 1,
    door: "WS push / push_conversations / push_messages (one `bindFrame` helper)",
  },
  {
    file: R + "subscriptions.ts",
    mint: "bindCaller",
    count: 2,
    door: "POST /api/v1/subscriptions/:id/{cancel,resubscribe}",
  },
  {
    file: R + "migration.ts",
    mint: "bindCaller",
    count: 1,
    door: "`bindMigrationCaller`: attestation, export, cancel, depart",
  },
  {
    file: R + "migration.ts",
    mint: "bindBySignature",
    count: 1,
    door: "POST /migrate — the binder itself verifies the signed MigrationRequest under the identity's key",
  },
  {
    file: R + "key-rotation.ts",
    mint: "bindCaller",
    count: 1,
    door: "POST /api/v1/agents/:id/approvals",
  },
  {
    file: R + "credentials.ts",
    mint: "bindCredentialSubject",
    count: 1,
    door: "POST /api/v1/agents/:id/credentials/submit — the path identity is the one the credential's own subject names (#850)",
  },
  {
    file: R + "delegation-revocations.ts",
    mint: "bindByDelegationRevocation",
    count: 1,
    door: "POST /api/v1/delegations/revocations — the binder verifies the revocation under a key the relay holds for its delegator (#850)",
  },
];

const BINDING_FILE = R + "identity-binding.ts";

/**
 * The registered identity-row writers: every function in the relay with a
 * parameter annotated `BoundIdentity`, and the name of that parameter. The
 * set is closed in both directions — a registered writer that loses the
 * parameter, and a function that gains one unregistered, both fail.
 */
const WRITER_HELPERS: ReadonlyArray<{ file: string; fn: string; param: string }> = [
  { file: R + "data-sync.ts", fn: "upsertSyncConversation", param: "owner" },
  { file: R + "data-sync.ts", fn: "upsertSyncMessage", param: "owner" },
  { file: R + "data-sync.ts", fn: "upsertSyncPlan", param: "owner" },
  { file: R + "data-sync.ts", fn: "upsertSyncPlanStep", param: "owner" },
  { file: BINDING_FILE, fn: "appendBoundEvent", param: "owner" },
  // A READER, registered because it takes the capability: the seq pull
  // returns only the bound identity's events (#868).
  { file: R + "event-seq.ts", fn: "readEventsAfterSeq", param: "owner" },
  { file: R + "subscriptions.ts", fn: "setSubscriptionStatus", param: "owner" },
  { file: R + "migration.ts", fn: "updateMigrationState", param: "owner" },
  { file: R + "migration.ts", fn: "commitDeparture", param: "owner" },
  { file: R + "key-rotation.ts", fn: "insertApproval", param: "owner" },
  { file: R + "credentials.ts", fn: "insertSubmittedCredential", param: "owner" },
  { file: R + "delegation-revocations.ts", fn: "insertDelegationRevocation", param: "owner" },
];

/**
 * The private minting path inside identity-binding.ts: the key the
 * constructor demands and the two closures its static block assigns. None
 * may be exported, and no other scanned file may name one.
 */
const PRIVATE_MINT_NAMES = ["MINT_KEY", "mintBound", "readBound"] as const;

/**
 * Every call of the module-private `mint(` inside identity-binding.ts, per
 * producer. A mint outside a registered producer is a new way to obtain the
 * capability.
 */
const PRODUCER_MINTS: Readonly<Record<string, number>> = {
  bindCaller: 2,
  bindBySignature: 1,
  bindSocketEntries: 1,
  bindSyncEntries: 1,
  bindCredentialSubject: 1,
  bindByDelegationRevocation: 1,
};

/**
 * Upserts that must be seen and read by the upsert rule — the owned upserts
 * keyed by a client-chosen id. A parser that stops seeing one fails here
 * instead of passing by reading nothing.
 */
const MUST_READ_UPSERTS: ReadonlyArray<{ file: string; table: string }> = [
  { file: R + "data-sync.ts", table: "sync_conversations" },
  { file: R + "data-sync.ts", table: "sync_plans" },
  { file: R + "bond-store.ts", table: "relay_bond_commitments" },
  { file: R + "proposals.ts", table: "relay_collaborative_step_results" },
];

/** Every call of `.append(` / `.appendWithClock(` in the relay. */
const EVENT_APPENDS: ReadonlyArray<{ file: string; count: number; why: string }> = [
  {
    file: BINDING_FILE,
    count: 1,
    why: "`appendBoundEvent` — the sync doors' only path, owner = BoundIdentity",
  },
  {
    file: R + "tasks.ts",
    count: 1,
    why: "relay-authored TrustLevelChanged, filed under the task's own delegator",
  },
];

// ---------------------------------------------------------------------------

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "dist" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, acc);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) acc.push(full);
  }
  return acc;
}

const FILES = SCAN_ROOTS.flatMap((r) => tsFiles(resolve(ROOT, r)));
const SOURCES = new Map(FILES.map((f) => [relative(ROOT, f), readFileSync(f, "utf-8")]));
const lineOf = (src: string, index: number): number => src.slice(0, index).split("\n").length;

/**
 * The identity columns each table declares (the same column rule as the
 * table derivation), read from every CREATE TABLE in the scanned roots. The
 * upsert checks below need them: an upsert's owner scope names one.
 */
function deriveIdentityColumns(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const create = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(/gi;
  const column = new RegExp(IDENTITY_COLUMN.source, "gm");
  for (const src of SOURCES.values()) {
    for (const m of src.matchAll(create)) {
      let i = m.index + m[0].length;
      let depth = 1;
      while (depth > 0 && i < src.length) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
        i++;
      }
      const body = src.slice(m.index + m[0].length, i - 1);
      for (const c of body.matchAll(column)) {
        const set = out.get(m[1]!) ?? new Set<string>();
        set.add(c[1]!.toLowerCase());
        out.set(m[1]!, set);
      }
    }
  }
  return out;
}

const IDENTITY_COLUMNS = deriveIdentityColumns();

/** Derive the per-identity table set from every CREATE TABLE in the scanned roots. */
function deriveTables(): Set<string> {
  const out = new Set<string>(AUTHORITY_TABLES);
  for (const table of IDENTITY_COLUMNS.keys()) {
    if (!(table in NOT_PER_IDENTITY)) out.add(table);
  }
  return out;
}

const TABLES = deriveTables();

interface Found {
  file: string;
  line: number;
  verb: Verb;
  table: string;
}

// ── SQL reading ───────────────────────────────────────────────────────────
//
// A deliberately small reader, not a SQL parser: enough to find the targets
// of a SET list and the top-level conjuncts of a WHERE, in every spelling
// SQLite accepts for an identifier (`col`, "col", `col`, [col]) and for a
// SET target (a column, or a row-value `(a, b) = (…)`). Anything it cannot
// read in an owned statement is REFUSED (UNPARSED), never passed.

/** An identity column name, whatever table it is on. */
const IDENTITY_NAME =
  /^(motebit_id|\w+_motebit_id|agent_id|worker_id|submitted_by|submitter_id|delegator_id|filed_by|respondent|approver_id|owner_id|revoked_by)$/i;

/**
 * Blank out SQL comments and the insides of '…' string literals (same
 * length, so indexes still line up) — a keyword or `=` inside a literal is
 * never read as SQL.
 */
function maskSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/'(?:[^']|'')*'/g, (m) => "'" + " ".repeat(Math.max(0, m.length - 2)) + "'");
}

/** One identifier, unquoted and lowercased: `"motebit_id"`, `motebit_id`, [motebit_id] → motebit_id. */
function normIdent(raw: string): string {
  return raw
    .trim()
    .split(".")
    .map((part) => {
      const p = part.trim();
      const q = /^"(.*)"$|^`(.*)`$|^\[(.*)\]$/s.exec(p);
      return (q ? (q[1] ?? q[2] ?? q[3] ?? "") : p).trim().toLowerCase();
    })
    .join(".");
}

/** Is `text` one parenthesized group, `( … )`, the closer at the very end? */
function wrapped(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("(") || !t.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")") depth--;
    if (depth === 0 && i < t.length - 1) return false;
  }
  return true;
}

/**
 * Split `text` at every depth-0 match of `sep` (a sticky regex). A keyword
 * separator (one that starts with a letter) must not continue a word on its
 * left (`FOR` is not `OR`); punctuation separators split anywhere. Returns
 * the parts and the separators, in order.
 */
function splitTopLevel(text: string, sep: RegExp): { parts: string[]; seps: string[] } {
  const keyword = /^[A-Za-z(]/.test(sep.source);
  const parts: string[] = [];
  const seps: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && !(keyword && /\w/.test(text[i - 1] ?? " "))) {
      sep.lastIndex = i;
      const m = sep.exec(text);
      if (m !== null) {
        parts.push(text.slice(start, i));
        seps.push(m[0]);
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(text.slice(start));
  return { parts, seps };
}

/** The index of the first depth-0 `=` that is an assignment/equality (not `==`'s twin, `<=`, `>=`, `!=`). */
function topLevelEquals(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === "=") {
      const prev = text[i - 1] ?? "";
      if (prev === "<" || prev === ">" || prev === "!" || prev === "=") continue;
      return i;
    }
  }
  return -1;
}

/**
 * The columns one SET list assigns, in every spelling. `null` when an item
 * cannot be read (no depth-0 `=`); items holding a JS interpolation (`${…}`)
 * are counted as dynamic and skipped — the gate cannot see a SET assembled
 * at runtime, and says so in its aperture.
 */
let dynamicSetItems = 0;
function setTargets(setList: string): string[] | null {
  const cols: string[] = [];
  for (const item of splitTopLevel(setList, /,/y).parts) {
    if (item.trim() === "") continue;
    if (item.includes("${")) {
      dynamicSetItems++;
      continue;
    }
    const eq = topLevelEquals(item);
    if (eq < 0) return null;
    const lhs = item.slice(0, eq).trim();
    if (wrapped(lhs)) {
      for (const c of lhs.trim().slice(1, -1).split(",")) cols.push(normIdent(c));
    } else {
      cols.push(normIdent(lhs));
    }
  }
  return cols;
}

/** Does any assigned column name an identity (the global rule, or one of this table's identity columns)? */
function assignsIdentity(cols: readonly string[], table: string): string | null {
  const idCols = IDENTITY_COLUMNS.get(table) ?? new Set<string>();
  for (const c of cols) {
    const bare = c.split(".").pop()!;
    if (IDENTITY_NAME.test(bare) || idCols.has(bare)) return bare;
  }
  return null;
}

/**
 * The top-level conjuncts of a WHERE: `null` when a depth-0 `OR` appears at
 * any level of the conjunction (a disjunction weakens any owner conjunct it
 * sits beside), else every conjunct, parentheses unwrapped.
 */
function conjuncts(expr: string): string[] | null {
  let e = expr.trim();
  while (wrapped(e)) e = e.slice(1, -1).trim();
  const { parts, seps } = splitTopLevel(e, /(AND|OR)\b/iy);
  if (seps.some((s) => /^or$/i.test(s))) return null;
  if (parts.length === 1) return [e];
  const out: string[] = [];
  for (const p of parts) {
    const c = conjuncts(p);
    if (c === null) return null;
    out.push(...c);
  }
  return out;
}

/** Is `conjunct` exactly `<t>.<col> = excluded.<col>` (either side), for a name of the target table and one of its identity columns? */
function isOwnerConjunct(conjunct: string, names: readonly string[], idCols: Set<string>): boolean {
  const eq = topLevelEquals(conjunct);
  if (eq < 0) return false;
  let rhsStart = eq + 1;
  if (conjunct[rhsStart] === "=") rhsStart++; // `==`
  const a = normIdent(conjunct.slice(0, eq));
  const b = normIdent(conjunct.slice(rhsStart));
  for (const col of idCols) {
    for (const t of names) {
      const own = `${t}.${col}`;
      const ex = `excluded.${col}`;
      if ((a === own && b === ex) || (a === ex && b === own)) return true;
    }
  }
  return false;
}

/**
 * The SQL string literal a statement at `index` sits in, from `index` to the
 * literal's closing delimiter (the nearest backtick or double quote before
 * it). A statement split across a `+` concatenation is read to the first
 * closing delimiter only — an upsert whose DO UPDATE is cut off is then
 * reported UNPARSED below rather than passed.
 */
function literalFrom(src: string, index: number): string {
  const back = Math.max(src.lastIndexOf("`", index), src.lastIndexOf('"', index));
  const delim = back >= 0 ? src[back]! : "`";
  // The closing delimiter is the first UNESCAPED one: an escaped \` or \"
  // inside the literal (a quoted identifier) does not end it.
  let end = src.indexOf(delim, index);
  while (end > 0 && src[end - 1] === "\\") end = src.indexOf(delim, end + 1);
  return src.slice(index, end < 0 ? undefined : end).replace(/\\(["`])/g, "$1");
}

/** Cut `text` at the first depth-0 occurrence of one of `keywords`. */
function cutAt(text: string, keywords: RegExp): string {
  const { parts } = splitTopLevel(text, keywords);
  return parts[0]!;
}

/**
 * Upserts on a per-identity table whose conflict target is NOT an identity
 * column, and whose `DO UPDATE` is deliberately NOT scoped to the row's
 * owner — each with the reason. Every other such upsert must carry the
 * owner conjunct.
 */
const UNSCOPED_UPSERT_ALLOWED: ReadonlyArray<{ file: string; table: string; reason: string }> = [
  {
    file: P,
    table: "conversations",
    reason:
      "the surface's local store: one database per identity, written by that identity's own sync pull; the relay never calls it",
  },
];

let upsertClauses = 0;
let ownerScopedUpserts = 0;
let identityKeyedUpserts = 0;
let unscopedAllowedUpserts = 0;
const upsertsRead: Array<{ file: string; table: string }> = [];

/**
 * Check every `ON CONFLICT … DO UPDATE SET …` clause of one INSERT (the
 * upsert's update half is an UPDATE of the conflicting row):
 *   - its SET list may not assign an identity column, in any quoting or as a
 *     row-value target — the conflicting row may be another identity's;
 *   - when its conflict target does not include an identity column (the key
 *     is an id the request chooses), its WHERE must hold the owner conjunct
 *     `<t>.<id col> = excluded.<id col>` at the top level, ANDed, with no
 *     depth-0 OR anywhere in the conjunction.
 * A conflict target that includes an identity column needs no WHERE: the
 * conflicting row equals the inserted one on that column by definition.
 */
function checkUpsert(
  file: string,
  line: number,
  table: string,
  alias: string | null,
  raw: string,
): string[] {
  const out: string[] = [];
  const statement = maskSql(raw);
  const clauses = statement.split(/\bON\s+CONFLICT\b/i).slice(1);
  const idCols = IDENTITY_COLUMNS.get(table) ?? new Set<string>(["motebit_id"]);
  const names = alias !== null ? [table.toLowerCase(), alias.toLowerCase()] : [table.toLowerCase()];
  for (const clause of clauses) {
    if (!/\bDO\s+UPDATE\b/i.test(clause)) continue;
    upsertClauses++;
    const m = /^\s*\(([^)]*)\)\s*(?:WHERE\b[\s\S]*?)?\bDO\s+UPDATE\s+SET\b([\s\S]*)$/i.exec(clause);
    if (m === null) {
      out.push(
        `UNPARSED UPSERT: ${table} in ${file}:${line} has a DO UPDATE the gate cannot read (a conflict target without columns?) — spell it \`ON CONFLICT(<cols>) DO UPDATE SET …\` so its re-filing and owner scope can be checked`,
      );
      continue;
    }
    upsertsRead.push({ file, table });
    const conflictCols = m[1]!.split(",").map((c) => normIdent(c));
    const body = cutAt(m[2]!, /RETURNING\b/iy);
    const { parts, seps } = splitTopLevel(body, /WHERE\b/iy);
    const setList = parts[0]!;
    const where = seps.length > 0 ? parts.slice(1).join(" WHERE ") : null;
    const targets = setTargets(setList);
    if (targets === null) {
      out.push(
        `UNPARSED UPSERT: INSERT INTO ${table} … DO UPDATE SET in ${file}:${line} has a SET item with no \`=\` the gate can read — spell each item \`col = expr\` or \`(a, b) = (…)\``,
      );
      continue;
    }
    const refiled = assignsIdentity(targets, table);
    if (refiled !== null && !REFILE_ALLOWED.some((a) => a.file === file && a.table === table)) {
      out.push(
        `REFILE (upsert): INSERT INTO ${table} … DO UPDATE SET in ${file}:${line} assigns the identity column \`${refiled}\` — a conflict on an id another identity holds would re-file that identity's row under the inserter. Drop the assignment (in every spelling: quoted, bracketed, or inside a row-value \`(a, b) = (…)\`); scope the update to the owner (WHERE ${table}.<identity column> = excluded.<identity column>)`,
      );
    }
    if (conflictCols.some((c) => idCols.has(c.split(".").pop()!))) {
      identityKeyedUpserts++;
      continue;
    }
    if (UNSCOPED_UPSERT_ALLOWED.some((a) => a.file === file && a.table === table)) {
      unscopedAllowedUpserts++;
      continue;
    }
    const conj = where === null ? [] : conjuncts(where);
    if (conj === null) {
      out.push(
        `OWNER SCOPE WEAKENED: INSERT INTO ${table} … ON CONFLICT(${conflictCols.join(", ")}) DO UPDATE in ${file}:${line} has a depth-0 OR in its WHERE — \`<owner> OR <anything>\` updates another identity's row whenever <anything> holds. The WHERE must be a conjunction (AND only) that includes \`${table}.${[...idCols][0]} = excluded.${[...idCols][0]}\``,
      );
      continue;
    }
    if (!conj.some((c) => isOwnerConjunct(c, names, idCols))) {
      out.push(
        `OWNER SCOPE: INSERT INTO ${table} … ON CONFLICT(${conflictCols.join(", ")}) DO UPDATE in ${file}:${line} is keyed by an id the request chooses, and its WHERE has no top-level conjunct \`${table}.<identity column> = excluded.<identity column>\` — an identity naming another identity's id rewrites that row. Add \`WHERE ${table}.${[...idCols][0]} = excluded.${[...idCols][0]}\` (ANDed, never ORed) to the DO UPDATE, and refuse when no row changed`,
      );
      continue;
    }
    ownerScopedUpserts++;
  }
  return out;
}

/** A table name in any SQLite identifier spelling. */
const TABLE_TOKEN = String.raw`(?:"(\w+)"|\x60(\w+)\x60|\[(\w+)\]|(\w+))`;

function scanWrites(): { found: Found[]; refiles: string[] } {
  const pattern = new RegExp(
    String.raw`\b(INSERT\s+OR\s+REPLACE\s+INTO|REPLACE\s+INTO|INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+` +
      TABLE_TOKEN +
      String.raw`(?:\s+AS\s+(\w+))?`,
    "gi",
  );
  const found: Found[] = [];
  const refiles: string[] = [];
  for (const [file, src] of SOURCES) {
    for (const m of src.matchAll(pattern)) {
      const table = m[2] ?? m[3] ?? m[4] ?? m[5]!;
      if (!TABLES.has(table)) continue;
      const head = m[1]!.toUpperCase().replace(/\s+/g, " ");
      const verb: Verb =
        head.includes("REPLACE") && !head.startsWith("UPDATE")
          ? "REPLACE"
          : head.startsWith("INSERT")
            ? "INSERT"
            : head.startsWith("UPDATE")
              ? "UPDATE"
              : "DELETE";
      const line = lineOf(src, m.index);
      found.push({ file, line, verb, table });
      const statement = literalFrom(src, m.index);
      if (verb === "INSERT" || verb === "REPLACE") {
        refiles.push(...checkUpsert(file, line, table, m[6] ?? null, statement));
      }
      if (verb === "UPDATE") {
        const masked = maskSql(statement);
        const set = /\bSET\b([\s\S]*)$/i.exec(masked);
        if (set === null) continue;
        const setList = cutAt(set[1]!, /(WHERE|RETURNING|FROM)\b/iy);
        const targets = setTargets(setList);
        const refiled =
          targets === null ? "<unreadable SET item>" : assignsIdentity(targets, table);
        if (refiled !== null && !REFILE_ALLOWED.some((a) => a.file === file && a.table === table)) {
          refiles.push(
            `REFILE: UPDATE ${table} in ${file}:${line} assigns ${refiled === "<unreadable SET item>" ? "a SET item the gate cannot read" : `the identity column \`${refiled}\``} — a row is never re-filed under another identity; insert a new row under the bound owner instead (every spelling is read: quoted, bracketed, row-value)`,
          );
        }
      }
    }
  }
  return { found, refiles };
}

const { found, refiles } = scanWrites();
const key = (f: { file: string; verb: string; table: string }): string =>
  `${f.file}|${f.verb}|${f.table}`;

const actual = new Map<string, Found[]>();
for (const f of found) {
  const list = actual.get(key(f)) ?? [];
  list.push(f);
  actual.set(key(f), list);
}

const violations: string[] = [...refiles];

for (const t of MUST_COVER) {
  if (!TABLES.has(t)) {
    violations.push(
      `APERTURE LOST: ${t} is no longer derived as a per-identity table — the CREATE TABLE parse or IDENTITY_COLUMN no longer sees it`,
    );
  }
}
for (const u of MUST_READ_UPSERTS) {
  if (!upsertsRead.some((r) => r.file === u.file && r.table === u.table)) {
    violations.push(
      `APERTURE LOST: the owned upsert into ${u.table} in ${u.file} was not read by the upsert rule — the statement scan or the ON CONFLICT parse no longer sees it`,
    );
  }
}

for (const [k, sites] of actual) {
  const registered = WRITERS.find((w) => key(w) === k);
  if (registered === undefined) {
    const [file, verb, table] = k.split("|");
    violations.push(
      `UNREGISTERED: ${verb} ${table} in ${file} (line${sites.length > 1 ? "s" : ""} ${sites.map((s) => s.line).join(", ")}) — this door writes a row filed under an identity and names no principal`,
    );
    continue;
  }
  if (sites.length !== registered.count) {
    violations.push(
      `COUNT CHANGED: ${registered.verb} ${registered.table} in ${registered.file} — registered ${registered.count}, found ${sites.length} (lines ${sites.map((s) => s.line).join(", ")}). A new write here is a new door; it needs its own answer.`,
    );
  }
}
for (const w of WRITERS) {
  if (!actual.has(key(w))) {
    violations.push(
      `STALE ENTRY: ${w.verb} ${w.table} in ${w.file} is registered but no longer present — remove it so the registry keeps describing the code`,
    );
  }
}
const registeredSites = WRITERS.reduce((n, w) => n + w.count, 0);
if (violations.length === 0 && found.length !== registeredSites) {
  violations.push(
    `APERTURE MISMATCH: ${found.length} write site(s) found, ${registeredSites} registered — the per-door counts and the total disagree`,
  );
}

if (
  violations.length === 0 &&
  upsertClauses !== ownerScopedUpserts + identityKeyedUpserts + unscopedAllowedUpserts
) {
  violations.push(
    `APERTURE MISMATCH: ${upsertClauses} DO UPDATE clause(s) read, but ${ownerScopedUpserts} owner-scoped + ${identityKeyedUpserts} identity-keyed + ${unscopedAllowedUpserts} allowed-unscoped do not add up`,
  );
}

// ── binding mints (call sites outside identity-binding.ts) ────────────────
const MINT_NAMES = [
  "bindCaller",
  "bindBySignature",
  "bindSyncEntries",
  "bindSocketEntries",
  "bindCredentialSubject",
  "bindByDelegationRevocation",
] as const;
let mintSites = 0;
for (const [file, src] of SOURCES) {
  if (file === BINDING_FILE) continue;
  for (const name of MINT_NAMES) {
    const calls = [...src.matchAll(new RegExp(`\\b${name}\\(`, "g"))];
    if (calls.length === 0) continue;
    mintSites += calls.length;
    const reg = MINTS.find((m) => m.file === file && m.mint === name);
    if (reg === undefined) {
      violations.push(
        `UNREGISTERED MINT: ${name}( in ${file} (lines ${calls.map((c) => lineOf(src, c.index)).join(", ")}) — a new door that binds a principal to an identity; register it in MINTS with the door it serves`,
      );
    } else if (reg.count !== calls.length) {
      violations.push(
        `MINT COUNT CHANGED: ${name}( in ${file} — registered ${reg.count}, found ${calls.length}`,
      );
    }
  }
}
for (const m of MINTS) {
  const src = SOURCES.get(m.file) ?? "";
  if (!new RegExp(`\\b${m.mint}\\(`).test(src)) {
    violations.push(`STALE MINT: ${m.mint} in ${m.file} is registered but not called`);
  }
}
const registeredMints = MINTS.reduce((n, m) => n + m.count, 0);
if (mintSites !== registeredMints) {
  violations.push(
    `APERTURE MISMATCH: ${mintSites} binding mint call(s) found outside ${BINDING_FILE}, ${registeredMints} registered`,
  );
}

// ── the capability: BoundIdentity is a runtime object only one module mints ─
//
// A type brand cannot be made unforgeable in TypeScript (the #860 review:
// row casts, type predicates, `asserts` functions, overloads, JSON.parse,
// tuple casts — each compiles). So the guarantee is not in the type and not
// in this gate: `BoundIdentity` is a class with an ES private field whose
// constructor demands a module-private key, and `unwrapBound` performs the
// private-brand check (`#id in b`) and throws on anything else. The runtime
// tests (`identity-binding-forgery.test.ts`) prove each forgery throws at the
// real writer and writes nothing. What THIS gate checks is only structure,
// syntactically (no type checker):
//   K1 identity-binding.ts declares `class BoundIdentity` with a `#id`
//      private field, a constructor that names MINT_KEY, and `unwrapBound`;
//      MINT_KEY / mintBound / readBound are not exported, and no other
//      scanned file names them;
//   K2 inside identity-binding.ts, `mint(` is called only in the registered
//      producers, the registered number of times;
//   K3 every function with a parameter annotated `BoundIdentity` is a
//      registered writer, and every registered writer has one, with that
//      name, annotated exactly `BoundIdentity` imported from
//      ./identity-binding.js (not a local type of that name);
//   K4 inside each registered writer, the parameter is read ONLY as the sole
//      argument of `unwrapBound(…)`, at least once; it is never shadowed,
//      and the body never touches `arguments`.
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    SOURCES.get(file) ?? "",
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
}
function isExported(n: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}
const lineAt = (sf: ts.SourceFile, n: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

// K1
{
  const sf = parse(BINDING_FILE);
  let classOk = false;
  let unwrapOk = false;
  const visit = (n: ts.Node): void => {
    if (ts.isClassDeclaration(n) && n.name?.text === "BoundIdentity") {
      const hasPrivateId = n.members.some(
        (m) =>
          ts.isPropertyDeclaration(m) && ts.isPrivateIdentifier(m.name) && m.name.text === "#id",
      );
      const ctor = n.members.find(ts.isConstructorDeclaration);
      const ctorNamesKey =
        ctor !== undefined &&
        /\bMINT_KEY\b/.test(ctor.getText(sf)) &&
        /\bthrow\b/.test(ctor.getText(sf));
      const brandCheck = /#id\s+in\b/.test(n.getText(sf));
      classOk = hasPrivateId && ctorNamesKey && brandCheck && isExported(n);
    }
    if (ts.isFunctionDeclaration(n) && n.name?.text === "unwrapBound" && isExported(n)) {
      unwrapOk = /\breadBound\(/.test(n.body?.getText(sf) ?? "");
    }
    if (ts.isVariableStatement(n) && isExported(n)) {
      for (const d of n.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          (PRIVATE_MINT_NAMES as readonly string[]).includes(d.name.text)
        ) {
          violations.push(
            `PRIVATE MINT EXPORTED: ${BINDING_FILE}:${lineAt(sf, d)} exports \`${d.name.text}\` — the minting path must stay module-private, or any module can construct a BoundIdentity`,
          );
        }
      }
    }
    if (ts.isExportDeclaration(n)) {
      const names =
        n.exportClause === undefined
          ? ["*"]
          : ts.isNamedExports(n.exportClause)
            ? n.exportClause.elements.map((e) => (e.propertyName ?? e.name).text)
            : ["*"];
      for (const x of names) {
        if (x === "*" || (PRIVATE_MINT_NAMES as readonly string[]).includes(x)) {
          violations.push(
            `PRIVATE MINT EXPORTED: ${BINDING_FILE}:${lineAt(sf, n)} re-exports \`${x}\` — the minting path must stay module-private`,
          );
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!classOk) {
    violations.push(
      `CAPABILITY LOST: ${BINDING_FILE} no longer declares an exported \`class BoundIdentity\` with a \`#id\` private field, a constructor that checks MINT_KEY and throws, and a \`#id in\` private-brand check — the runtime guarantee the writers rely on is gone`,
    );
  }
  if (!unwrapOk) {
    violations.push(
      `CAPABILITY LOST: ${BINDING_FILE} no longer exports \`unwrapBound\` reading through the class's private-brand check (\`readBound\`)`,
    );
  }
  for (const [file, src] of SOURCES) {
    if (file === BINDING_FILE) continue;
    for (const name of PRIVATE_MINT_NAMES) {
      const hits = [...src.matchAll(new RegExp(`\\b${name}\\b`, "g"))];
      if (hits.length > 0) {
        violations.push(
          `PRIVATE MINT REFERENCED: ${file} (lines ${hits.map((h) => lineOf(src, h.index)).join(", ")}) names \`${name}\` — only ${BINDING_FILE} may touch the minting path`,
        );
      }
    }
  }
}

// K2
let producerMints = 0;
{
  const sf = parse(BINDING_FILE);
  const seen: Record<string, number> = {};
  const visit = (n: ts.Node, fn: string | null): void => {
    let here = fn;
    if (ts.isFunctionDeclaration(n) && n.name !== undefined) here = n.name.text;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "mint") {
      producerMints++;
      const owner = here ?? "<module>";
      seen[owner] = (seen[owner] ?? 0) + 1;
      if (!(owner in PRODUCER_MINTS)) {
        violations.push(
          `UNREGISTERED PRODUCER: ${BINDING_FILE}:${lineAt(sf, n)} mints a BoundIdentity in \`${owner}\` — a new way to obtain the capability; register it in PRODUCER_MINTS with what it compares`,
        );
      }
    }
    ts.forEachChild(n, (c) => visit(c, here));
  };
  visit(sf, null);
  // `mint` is the only path to the constructor: one `mintBound(` (inside
  // `mint`) and one `new BoundIdentity(` (inside the static block).
  const bsrc = SOURCES.get(BINDING_FILE) ?? "";
  for (const [re, what] of [
    [/\bmintBound\(/g, "mintBound("],
    [/\bnew\s+BoundIdentity\(/g, "new BoundIdentity("],
  ] as const) {
    const n = [...bsrc.matchAll(re)].length;
    if (n !== 1) {
      violations.push(
        `UNREGISTERED PRODUCER: ${BINDING_FILE} calls \`${what}\` ${n} time(s) — exactly one is the minting path (\`mint\` → \`mintBound\` → the constructor); any other is a mint outside the registered producers`,
      );
    }
  }
  for (const [fn, count] of Object.entries(PRODUCER_MINTS)) {
    if ((seen[fn] ?? 0) !== count) {
      violations.push(
        `PRODUCER COUNT CHANGED: \`${fn}\` in ${BINDING_FILE} mints ${seen[fn] ?? 0} time(s), registered ${count}`,
      );
    }
  }
}

// K3 + K4
let writersChecked = 0;
let unwrapReads = 0;
{
  const typedParams: Array<{ file: string; fn: string; param: string; line: number }> = [];
  const isBoundType = (t: ts.TypeNode | undefined): boolean =>
    t !== undefined && /\bBoundIdentity\b/.test(t.getText());
  for (const file of SOURCES.keys()) {
    if (!file.startsWith(R)) continue;
    const src = SOURCES.get(file)!;
    if (!/\bBoundIdentity\b/.test(src)) continue;
    const sf = parse(file);
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionLike(n)) {
        for (const p of n.parameters) {
          if (isBoundType(p.type)) {
            const named =
              (n as ts.FunctionDeclaration).name ??
              (ts.isVariableDeclaration(n.parent) ? n.parent.name : undefined);
            typedParams.push({
              file,
              fn: named !== undefined && ts.isIdentifier(named) ? named.text : "<anonymous>",
              param: ts.isIdentifier(p.name) ? p.name.text : "<pattern>",
              line: lineAt(sf, p),
            });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  for (const t of typedParams) {
    // `unwrapBound` itself is the reader every writer goes through.
    if (t.file === BINDING_FILE && t.fn === "unwrapBound") continue;
    if (!WRITER_HELPERS.some((w) => w.file === t.file && w.fn === t.fn && w.param === t.param)) {
      violations.push(
        `UNREGISTERED WRITER: ${t.file}:${t.line} — \`${t.fn}\` takes a BoundIdentity parameter \`${t.param}\` and is not registered in WRITER_HELPERS; register it, and read the parameter only through unwrapBound(${t.param})`,
      );
    }
  }

  for (const w of WRITER_HELPERS) {
    const sf = parse(w.file);
    const src = SOURCES.get(w.file) ?? "";
    let decl: ts.FunctionLikeDeclaration | undefined;
    const find = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === w.fn) decl = n;
      ts.forEachChild(n, find);
    };
    find(sf);
    const repair = `every registered writer takes its owner as \`${w.param}: BoundIdentity\` and reads it only as \`unwrapBound(${w.param})\``;
    if (decl === undefined || decl.body === undefined) {
      violations.push(
        `WRITER MISSING: \`${w.fn}\` is registered in ${w.file} but no function declaration of that name was found — ${repair}`,
      );
      continue;
    }
    const p = decl.parameters.find((q) => ts.isIdentifier(q.name) && q.name.text === w.param);
    if (
      p === undefined ||
      p.type === undefined ||
      !ts.isTypeReferenceNode(p.type) ||
      p.type.getText(sf) !== "BoundIdentity"
    ) {
      violations.push(
        `UNBOUND WRITER: \`${w.fn}\` in ${w.file}:${lineAt(sf, decl)} has no parameter \`${w.param}\` typed exactly \`BoundIdentity\` — ${repair}`,
      );
      continue;
    }
    // BoundIdentity must be the real one: imported from ./identity-binding.js
    // (or declared there), never a local type or value of that name.
    if (w.file !== BINDING_FILE) {
      const imported = new RegExp(
        String.raw`import\s*(?:type\s*)?\{[^}]*\bBoundIdentity\b[^}]*\}\s*from\s*["']\./identity-binding\.js["']`,
      ).test(src);
      const unwrapImported = new RegExp(
        String.raw`import\s*\{[^}]*\bunwrapBound\b[^}]*\}\s*from\s*["']\./identity-binding\.js["']`,
      ).test(src);
      const localDecl = new RegExp(
        String.raw`\b(?:type|interface|class|const|let|var|function|enum|namespace)\s+(?:BoundIdentity|unwrapBound)\b`,
      ).test(src.replace(/^import\b[^;]*;/gm, ""));
      if (!imported || !unwrapImported || localDecl) {
        violations.push(
          `UNBOUND WRITER: ${w.file} must import \`BoundIdentity\` and \`unwrapBound\` from ./identity-binding.js and declare neither itself — a local type or function of that name is not the capability`,
        );
        continue;
      }
    }
    writersChecked++;
    let reads = 0;
    const body = decl.body;
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === "arguments") {
        violations.push(
          `OWNER READ AROUND unwrapBound: \`${w.fn}\` in ${w.file}:${lineAt(sf, n)} reads \`arguments\` — the owner can be reached without unwrapBound`,
        );
      }
      if (ts.isIdentifier(n) && n.text === w.param) {
        const parent = n.parent;
        const isDeclName =
          (ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isBindingElement(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isClassDeclaration(parent)) &&
          (parent as ts.NamedDeclaration).name === n;
        const isPropName =
          (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
          (ts.isPropertyAssignment(parent) && parent.name === n);
        if (isDeclName) {
          violations.push(
            `OWNER SHADOWED: \`${w.fn}\` in ${w.file}:${lineAt(sf, n)} re-declares \`${w.param}\` — a shadowing name can carry any value past the unwrapBound rule`,
          );
        } else if (!isPropName) {
          const ok =
            ts.isCallExpression(parent) &&
            ts.isIdentifier(parent.expression) &&
            parent.expression.text === "unwrapBound" &&
            parent.arguments.length === 1 &&
            parent.arguments[0] === n;
          if (ok) reads++;
          else {
            violations.push(
              `OWNER READ AROUND unwrapBound: \`${w.fn}\` in ${w.file}:${lineAt(sf, n)} uses \`${w.param}\` as \`${parent.getText(sf).slice(0, 60)}\` — ${repair}; any other use (a comparison, a SQL bind, a property read, String(), a spread) takes the owner without the private-brand check`,
            );
          }
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(body);
    if (reads === 0) {
      violations.push(
        `OWNER UNREAD: \`${w.fn}\` in ${w.file} never calls unwrapBound(${w.param}) — a writer that ignores its bound owner writes under whatever identity its other arguments name; ${repair}`,
      );
    }
    unwrapReads += reads;
  }
  if (writersChecked !== WRITER_HELPERS.length && violations.length === 0) {
    violations.push(
      `APERTURE MISMATCH: ${writersChecked} writer(s) checked, ${WRITER_HELPERS.length} registered`,
    );
  }
}

// ── event-store appends ───────────────────────────────────────────────────
let appendSites = 0;
for (const [file, src] of SOURCES) {
  if (!file.startsWith(R)) continue;
  const calls = [...src.matchAll(/\.(append|appendWithClock)\(/g)];
  if (calls.length === 0) continue;
  appendSites += calls.length;
  const reg = EVENT_APPENDS.find((e) => e.file === file);
  if (reg === undefined || reg.count !== calls.length) {
    violations.push(
      `EVENT APPEND: ${calls.length} call(s) of .append( in ${file} (lines ${calls.map((c) => lineOf(src, c.index)).join(", ")}) — registered ${reg?.count ?? 0}. EventStore.append files an entry under the entry's OWN motebit_id; route a client-supplied entry through appendBoundEvent`,
    );
  }
}

if (violations.length > 0) {
  failWithRepair({
    invariant:
      "a door that writes a row filed under an identity, or that decides who an identity is, must name the principal that authorizes it — and a per-identity write helper reads its owner only from a BoundIdentity a binding minted",
    canonical:
      "scripts/check-identity-authority-writers.ts (WRITERS, MINTS, WRITER_HELPERS, PRODUCER_MINTS, EVENT_APPENDS) and services/relay/src/identity-binding.ts",
    sites: violations,
    fix: "Answer one question in writing, then add the entry: WHO may cause this write, and what IN THE REQUEST proves they are that? Route an owner-facing door through identity-binding.ts (`bindCaller` / `bindSyncEntries` / `bindSocketEntries` / `bindBySignature` / `bindCredentialSubject` / `bindByDelegationRevocation`) and write through a helper that takes `owner: BoundIdentity` and reads it only as `unwrapBound(owner)`. A signature proves authorship, not authority (#713). A path segment is chosen by the caller (#719). An identifier in a body is not a relationship to the object it names (#701, #846). If the honest answer is 'nothing in the request proves it', the door is the defect and the registry entry is not the fix.",
    doctrine:
      "services/relay/CLAUDE.md rule 6, rule 21 and rule 26; docs/doctrine/memory-never-confers-authority.md — only a named principal, proven by the request, may act on an identity's rows.",
  });
}

process.stdout.write(
  `✓ check-identity-authority-writers: ${found.length} write site(s) = the ${registeredSites} registered across ${WRITERS.length} door(s), each naming its principal; ` +
    `${mintSites} binding mint call(s) = the ${registeredMints} registered in ${MINTS.length} door(s); ` +
    `${producerMints} internal mint(s) in ${Object.keys(PRODUCER_MINTS).length} registered producer(s); ` +
    `${writersChecked}/${WRITER_HELPERS.length} registered writer(s) take \`owner: BoundIdentity\` and read it only through unwrapBound (${unwrapReads} read(s)); ` +
    `${appendSites} event-append call(s) in ${EVENT_APPENDS.length} registered file(s); ` +
    `${upsertClauses} DO UPDATE clause(s) read: none assigns an identity column in any spelling, ${ownerScopedUpserts} carry a top-level ANDed owner conjunct, ${identityKeyedUpserts} are keyed on an identity column, ${unscopedAllowedUpserts} unscoped by registered exception.\n` +
    `  Aperture: ${SOURCES.size} .ts file(s) scanned under ${SCAN_ROOTS.join(", ")} ` +
    `(excluding __tests__/dist) for INSERT / INSERT OR REPLACE / REPLACE / UPDATE [OR …] / DELETE against ` +
    `${TABLES.size} table(s) (any identifier quoting): ${AUTHORITY_TABLES.length} authority tables plus every CREATE TABLE with an identity column ` +
    `(${Object.keys(NOT_PER_IDENTITY).length} excluded with a reason). ` +
    `Not enforced here: that a forged BoundIdentity throws — that is the runtime capability, proven by identity-binding-forgery.test.ts. ` +
    `Blind to ${dynamicSetItems} SET item(s) assembled at runtime (\`\${…}\`), to a statement split by \`+\`, to a table name held in a variable, and to writes issued from any other package.\n`,
);
