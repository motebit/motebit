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
 *
 * None was a logic error inside a function. Each was a door cut beside the
 * doors that already had the rule, without the rule.
 *
 * What this gate asserts, in four parts:
 *
 *   1. SQL writers are a CLOSED set. Every INSERT, INSERT OR REPLACE /
 *      REPLACE, UPDATE and DELETE against a table that carries an identity is
 *      registered — file, verb, table, count — with the principal that may
 *      cause it. The table set is DERIVED, not listed: every `CREATE TABLE`
 *      in the scanned roots with a column naming an identity (`motebit_id`,
 *      `*_motebit_id`, `agent_id`, `worker_id`, `submitted_by`,
 *      `submitter_id`, `delegator_id`, `filed_by`, `respondent`,
 *      `approver_id`, `owner_id`, `revoked_by`) joins it, plus the authority
 *      tables below. A new per-identity table widens the gate by existing.
 *   2. No UPDATE re-files a row: a SET clause that assigns an identity column
 *      is refused outright (no registry entry can excuse it).
 *   3. Binding mints are a CLOSED set. `identity-binding.ts` is the only
 *      place a request's principal is compared to the identity it writes, and
 *      its result is the `BoundIdentity` type the per-identity write helpers
 *      (`upsertSync*`, `appendBoundEvent`, `setSubscriptionStatus`,
 *      `updateMigrationState`, `insertApproval`) require — a door that calls
 *      one without a binding does not compile. Every call of a mint
 *      (`bindCaller`, `bindBySignature`, `bindSyncEntries`,
 *      `bindSocketEntries`) is registered per file with its door, and each
 *      helper's signature is checked to still demand the brand.
 *   4. Event-store appends are a CLOSED set: `EventStore.append` takes the
 *      entry's own `motebit_id`, so the relay may call it only through
 *      `appendBoundEvent` or at a registered relay-authored site.
 *
 * That is deliberately not a proof that a site is correct — a gate cannot
 * read an authorization. It forces the question to be answered in writing at
 * the moment the door is cut, which is the step every one of these skipped.
 *
 * Scope, stated because a green gate's claim is only as wide as what it
 * scanned (`docs/doctrine/gate-repair-instructions.md`): it reads
 * `services/relay/src` and `packages/persistence/src`, skipping `__tests__`
 * and `dist`. It cannot see a statement assembled at runtime from a table
 * name held in a variable, or a write issued from another package.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    file: R + "p2p-verifier.ts",
    verb: "UPDATE",
    table: "agent_registry",
    count: 1,
    principal:
      LOOP +
      ": the p2p verifier loop narrows a delegator's `settlement_modes` after an onchain proof it READ failed verification",
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
      "the credential's subject or its issuer, resolved from the credential row itself, or the operator; never the identity named in the path (#719). KNOWN GAP (#846 v2 audit): the subject is the path id the credential was SUBMITTED under, and submit does not bind the credential's own subject",
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
    count: 1,
    principal:
      "the identity itself (or its guardian for a recovery) — the registry key moves only FROM the key the verified link retires, or into an empty master-token slot",
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
    count: 5,
    principal:
      "withdrawal lifecycle: the operator's admin complete/fail routes (master token) and the relay's rail loops (" +
      LOOP +
      ")",
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
    file: R + "batch-withdrawals.ts",
    verb: "UPDATE",
    table: "relay_pending_withdrawals",
    count: 3,
    principal: LOOP + ": the batch-withdrawal fire path",
  },
  {
    file: R + "batch-withdrawals.ts",
    verb: "INSERT",
    table: "relay_withdrawals",
    count: 1,
    principal: LOOP + ": the batch-withdrawal fire path",
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
    file: R + "tasks.ts",
    verb: "INSERT",
    table: "relay_allocations",
    count: 2,
    principal:
      "task submission — the budget is locked from `submittedBy = callerMotebitId` (dualAuth task:submit) or the operator's body value",
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
    table: "relay_settlements",
    count: 4,
    principal: "settlement of a verified receipt, or a verified P2P payment proof",
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
    count: 2,
    principal: LOOP + ": stale-allocation release and settlement retry",
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
    principal: LOOP + ": the p2p verifier's state transitions from an onchain READ",
  },
  {
    file: R + "p2p-verifier.ts",
    verb: "UPDATE",
    table: "agent_trust",
    count: 1,
    principal: LOOP + ": trust downgrade after a failed onchain verification",
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
    table: "relay_settlements",
    count: 1,
    principal: "a federation peer — a signed /federation/v1 result for a task this relay forwarded",
  },
  {
    file: R + "federation-callbacks.ts",
    verb: "INSERT",
    table: "relay_federation_settlements",
    count: 2,
    principal: "a federation peer — signed settlement forward for a task routed through this relay",
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
    count: 3,
    principal:
      "`updateMigrationState(db, owner: BoundIdentity, …)`, scoped WHERE motebit_id = owner: /migrate (signature), attestation, export, cancel, depart (each `bindCaller` — #846: any identity's token cancelled, exported or departed B)",
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
      "the identity itself — POST /bond: body motebit_id must equal the path, and `recordBondCommitment` verifies the bond's signature under the identity's registered key",
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
      "credentials/submit: the VC's signature verifies. KNOWN GAP (#846 v2 audit): filed under the PATH id, never compared to the credential's own subject — reported, not fixed here",
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
      "the revocation's signature. KNOWN GAP (#846 v2 audit): verified against the key EMBEDDED in the revocation, never the delegator's registered key — reported, not fixed here",
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
    count: 1,
    principal: "the same caller's completion, scoped by motebit_id",
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
    verb: "REPLACE",
    table: "relay_task_queue",
    count: 1,
    principal: "the durable mirror of an in-memory task entry the task routes already authorized",
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
      "the filer — a DisputeRequest signed by `filed_by`'s registered key. KNOWN GAP (#846 v2 audit): nothing checks `filed_by` is a party to the task (§4.4) — reported, not fixed here",
  },
  {
    file: R + "disputes.ts",
    verb: "UPDATE",
    table: "relay_allocations",
    count: 1,
    principal: "the same filing (flips the allocation to `disputed`) — same gap",
  },
  {
    file: R + "disputes.ts",
    verb: "UPDATE",
    table: "relay_disputes",
    count: 6,
    principal:
      "state transitions: the filing above; `/resolve` — the OPERATOR's act, master token only (#846 v2: it took any caller's verdict); appeal (a party's signature); lazy finalize (time-driven)",
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
      "a participant — its own row; a step another participant reported is refused 409, recorded (#846 v2: `INSERT OR REPLACE` let any participant re-file another's result)",
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
            " except the p2p verifier loop and tasks.ts's verified-receipt update"
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
      "the durable mirror re-writes `worker_id = task.motebit_id`, the task's own fixed target (the same value its INSERT wrote), never another identity",
  },
];

/** Every call of a binding mint, per file. A new mint site is a new door. */
interface Mint {
  file: string;
  mint: "bindCaller" | "bindBySignature" | "bindSyncEntries" | "bindSocketEntries";
  count: number;
  door: string;
}
const MINTS: readonly Mint[] = [
  {
    file: R + "sync-routes.ts",
    mint: "bindSyncEntries",
    count: 1,
    door: "POST /sync/:id/push",
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
    door: "POST /migrate after verifyMigrationRequest under the identity's key",
  },
  {
    file: R + "key-rotation.ts",
    mint: "bindCaller",
    count: 1,
    door: "POST /api/v1/agents/:id/approvals",
  },
];

/** The helpers that write per-identity rows — each must still demand the brand. */
const BRANDED_HELPERS: ReadonlyArray<{ file: string; fn: string }> = [
  { file: R + "data-sync.ts", fn: "upsertSyncConversation" },
  { file: R + "data-sync.ts", fn: "upsertSyncMessage" },
  { file: R + "data-sync.ts", fn: "upsertSyncPlan" },
  { file: R + "data-sync.ts", fn: "upsertSyncPlanStep" },
  { file: R + "identity-binding.ts", fn: "appendBoundEvent" },
  { file: R + "subscriptions.ts", fn: "setSubscriptionStatus" },
  { file: R + "migration.ts", fn: "updateMigrationState" },
  { file: R + "key-rotation.ts", fn: "insertApproval" },
];

/** Every call of `.append(` / `.appendWithClock(` in the relay. */
const EVENT_APPENDS: ReadonlyArray<{ file: string; count: number; why: string }> = [
  {
    file: R + "identity-binding.ts",
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

/** Derive the per-identity table set from every CREATE TABLE in the scanned roots. */
function deriveTables(): Set<string> {
  const out = new Set<string>(AUTHORITY_TABLES);
  const create = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(/gi;
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
      if (IDENTITY_COLUMN.test(body) && !(m[1]! in NOT_PER_IDENTITY)) out.add(m[1]!);
    }
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

function scanWrites(): { found: Found[]; refiles: string[] } {
  const pattern =
    /\b(INSERT\s+OR\s+REPLACE\s+INTO|REPLACE\s+INTO|INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(\w+)\b(?=([\s\S]{0,300}))/gi;
  const found: Found[] = [];
  const refiles: string[] = [];
  for (const [file, src] of SOURCES) {
    for (const m of src.matchAll(pattern)) {
      const table = m[2]!;
      if (!TABLES.has(table)) continue;
      const head = m[1]!.toUpperCase().replace(/\s+/g, " ");
      const verb: Verb = head.includes("REPLACE")
        ? "REPLACE"
        : head.startsWith("INSERT")
          ? "INSERT"
          : head.startsWith("UPDATE")
            ? "UPDATE"
            : "DELETE";
      const line = lineOf(src, m.index);
      found.push({ file, line, verb, table });
      if (verb === "UPDATE") {
        const setClause = (m[3] ?? "").split(/\bWHERE\b/i)[0]!;
        const assigns =
          /\bSET\b[\s\S]*?\b(motebit_id|\w+_motebit_id|agent_id|worker_id|submitted_by|submitter_id|delegator_id|filed_by|respondent|approver_id|owner_id)\s*=/i.test(
            setClause,
          );
        if (assigns && !REFILE_ALLOWED.some((a) => a.file === file && a.table === table)) {
          refiles.push(
            `REFILE: UPDATE ${table} in ${file}:${line} assigns an identity column — a row is never re-filed under another identity; insert a new row under the bound owner instead`,
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

// ── binding mints ─────────────────────────────────────────────────────────
const MINT_NAMES = [
  "bindCaller",
  "bindBySignature",
  "bindSyncEntries",
  "bindSocketEntries",
] as const;
let mintSites = 0;
for (const [file, src] of SOURCES) {
  if (file === R + "identity-binding.ts") continue;
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

// ── branded helpers ───────────────────────────────────────────────────────
for (const h of BRANDED_HELPERS) {
  const src = SOURCES.get(h.file) ?? "";
  const sig = new RegExp(`function ${h.fn}\\(([^)]*)\\)`).exec(src);
  if (sig === null || !/:\s*BoundIdentity\b/.test(sig[1]!)) {
    violations.push(
      `UNBRANDED HELPER: ${h.fn} in ${h.file} no longer takes a \`BoundIdentity\` owner — a door could call it without a binding`,
    );
  }
}

// ── brand casts: only identity-binding.ts mints a BoundIdentity ─────────
for (const [file, src] of SOURCES) {
  if (file === R + "identity-binding.ts") continue;
  const casts = [...src.matchAll(/\bas\s+BoundIdentity\b|<BoundIdentity>/g)];
  if (casts.length > 0) {
    violations.push(
      `BRAND CAST: ${file} (lines ${casts.map((c) => lineOf(src, c.index)).join(", ")}) casts to BoundIdentity — only identity-binding.ts mints one, after the comparison`,
    );
  }
}

// ── event-store appends ───────────────────────────────────────────────────
for (const [file, src] of SOURCES) {
  if (!file.startsWith(R)) continue;
  const calls = [...src.matchAll(/\.(append|appendWithClock)\(/g)];
  if (calls.length === 0) continue;
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
      "a door that writes a row filed under an identity, or that decides who an identity is, must name the principal that authorizes it — and a per-identity write helper is reachable only through a binding",
    canonical:
      "scripts/check-identity-authority-writers.ts (WRITERS, MINTS, BRANDED_HELPERS, EVENT_APPENDS) and services/relay/src/identity-binding.ts",
    sites: violations,
    fix: "Answer one question in writing, then add the entry: WHO may cause this write, and what IN THE REQUEST proves they are that? Route an owner-facing door through identity-binding.ts (`bindCaller` / `bindSyncEntries` / `bindSocketEntries` / `bindBySignature`) and write through a helper that takes a `BoundIdentity`. A signature proves authorship, not authority (#713). A path segment is chosen by the caller (#719). An identifier in a body is not a relationship to the object it names (#701, #846). If the honest answer is 'nothing in the request proves it', the door is the defect and the registry entry is not the fix.",
    doctrine:
      "services/relay/CLAUDE.md rule 6 and rule 21; docs/doctrine/memory-never-confers-authority.md — only a named principal, proven by the request, may act on an identity's rows.",
  });
}

process.stdout.write(
  `✓ check-identity-authority-writers: ${found.length} write site(s) across ${WRITERS.length} registered door(s), each naming its principal; ` +
    `${mintSites} binding mint call(s) in ${MINTS.length} registered door(s); ${BRANDED_HELPERS.length} branded helper(s); ` +
    `${EVENT_APPENDS.length} event-append site(s).\n` +
    `  Aperture: ${SOURCES.size} .ts file(s) scanned under ${SCAN_ROOTS.join(", ")} ` +
    `(excluding __tests__/dist) for INSERT / INSERT OR REPLACE / REPLACE / UPDATE / DELETE against ` +
    `${TABLES.size} table(s): ${AUTHORITY_TABLES.length} authority tables plus every CREATE TABLE with an identity column ` +
    `(${Object.keys(NOT_PER_IDENTITY).length} excluded with a reason). An UPDATE assigning an identity column is refused outright. ` +
    `Blind to a statement assembled at runtime from a table name in a variable, and to writes issued from any other package.\n`,
);
