/**
 * Delegation-revocation cache — the relay half of standing-delegation §5.
 *
 * A `DelegationRevocation` is a DELEGATOR-signed sovereign artifact (spec
 * `standing-delegation-v1.md` §5): the signed revocation is the canonical
 * source of truth, and this table is a CACHE, never the authority (§6 D2;
 * self-attesting-system doctrine). That is why this is a separate module from
 * `agent-revocation.ts` — that feed serves RELAY-signed operator assertions
 * (the de-list power, a different trust domain); mixing delegator-signed
 * artifacts into it would blur who is asserting what. Same pattern, sibling
 * trust root.
 *
 * Security is in the ARTIFACT, not the transport (the `POST /bond` class):
 * ingestion verifies the revocation's Ed25519 signature AND that the key it
 * verifies under is one this relay holds for the `delegator_id` it names
 * (`bindByDelegationRevocation`, identity-binding.ts — #850; the bond route's
 * "bonded key must be the key we know for this motebit_id" rule). A third
 * party "propagating" someone else's valid revocation is a feature —
 * revocation wants to travel — and still works: the delegator's key signed
 * it. Invalid signatures are rejected 422; a signature under a key the
 * named delegator does not hold is refused 403.
 *
 * Before #850 the signature was checked against the key EMBEDDED in the
 * revocation alone, and the acceptance fence matched on `grant_id` alone —
 * so anyone who knew a `grant_id` (a stranger with a fresh keypair, or any
 * registered identity signing under its own key) could make the relay refuse
 * that grant's tasks. The fence now honours only the task submitter's own
 * revocations (`isGrantRevokedBy`).
 *
 * Why this exists NOW (Inc 3a of the money-execution arc): before autonomous
 * money moves under a standing grant, the coordinator at the settlement
 * checkpoint must be able to LEARN revocations — this cache is what the
 * settlement-time re-verification (Inc 3b) reads, collapsing online revocation
 * latency to one settlement round-trip. Checkpoint doc:
 * `docs/proposals/standing-delegation-execution-checkpoint.md` (D4).
 *
 * Pruning: rows for grants past their propagation usefulness (revoked_at far
 * beyond the D1 90-day max grant lifetime) can be truncated under the same
 * revocation-horizon discipline as the agent feed — deferred until the table
 * has real volume; grants self-expire, so an unpruned cache is a size concern,
 * never a correctness one.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { DatabaseDriver } from "@motebit/persistence";
import { canonicalJson } from "@motebit/encryption";
import {
  bytesToHex,
  signRevocationInclusionReceipt,
  signRevocationSetAttestation,
  REVOCATION_SET_ATTESTATION_CHALLENGE_MAX_LENGTH,
  REVOCATION_SET_ATTESTATION_CHALLENGE_MIN_LENGTH,
  type DelegationRevocation,
} from "@motebit/crypto";
import type {
  DelegationRevocationInclusionReceipt,
  DelegationRevocationSetAttestation,
} from "@motebit/protocol";
import { DelegationRevocationSchema } from "@motebit/wire-schemas";
import type { RelayIdentity } from "./federation.js";
import { refuseInvalidIds } from "./id-bounds.js";
import { bindByDelegationRevocation, unwrapBound, type BoundIdentity } from "./identity-binding.js";
import type { AuthEvent } from "./auth-events.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "delegation-revocations" });

/**
 * One stored revocation with the receipt seq the relay assigned it
 * (standing-delegation §5.2/§5.3). `seq` IS the table's
 * `id INTEGER PRIMARY KEY AUTOINCREMENT` (migration v39): one counter for the
 * whole relay, assigned by SQLite in the statement that inserts the row,
 * never reused (AUTOINCREMENT, not rowid reuse) and never reassigned.
 */
export interface StoredDelegationRevocation {
  readonly seq: number;
  readonly received_at: number;
  readonly record: DelegationRevocation;
}

/**
 * Record a revocation under the delegator it was bound to, and return whether
 * it is new (`recorded`) and the stored row (`stored`). Append-only,
 * idempotent on the signature (Ed25519 is deterministic: same body + same key
 * ⇒ same signature, so a re-submission is a no-op, not a duplicate row).
 * `record_json` stores the byte-identical canonical artifact
 * (`relay_receipts.receipt_json` discipline, CLAUDE.md rule 12) so consumers
 * re-verify exactly what the delegator signed.
 *
 * `owner` is the delegator `bindByDelegationRevocation` proved signed it —
 * the signature verified under a key the relay holds for that identity. A
 * revocation that does not name `owner` as its delegator is refused here
 * (throws, writes nothing), so the row and the binding agree.
 *
 * Atomicity (spec §5.2 relay atomicity MUST): the seq is the AUTOINCREMENT id
 * SQLite assigns inside the INSERT, and the insert and the read-back of the
 * stored row run in ONE transaction, so the seq a receipt names is the seq of
 * a committed row, and no reader on another connection sees a seq whose row
 * is not visible. An already-recorded revocation returns the ORIGINAL row
 * (its first seq and `received_at`), never a new one, so the inclusion
 * receipt for a repeat names the same seq.
 */
export function insertDelegationRevocation(
  db: DatabaseDriver,
  owner: BoundIdentity,
  revocation: DelegationRevocation,
  receivedAt: number = Date.now(),
): { recorded: boolean; stored: StoredDelegationRevocation } {
  if (revocation.delegator_id !== unwrapBound(owner)) {
    throw new TypeError(
      "insertDelegationRevocation: the revocation's delegator_id is not the bound delegator (#850)",
    );
  }
  return db.transaction(() => {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO relay_delegation_revocations
           (grant_id, delegator_id, delegator_public_key, revoked_at,
            suite, signature, record_json, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revocation.grant_id,
        revocation.delegator_id,
        revocation.delegator_public_key,
        revocation.revoked_at,
        revocation.suite,
        revocation.signature,
        canonicalJson(revocation),
        receivedAt,
      );
    const row = db
      .prepare(
        `SELECT id, received_at, record_json FROM relay_delegation_revocations
         WHERE signature = ?`,
      )
      .get(revocation.signature) as
      { id: number; received_at: number; record_json: string } | undefined;
    if (row === undefined) {
      // Unreachable: the INSERT either wrote the row or a row with this
      // signature already existed (the UNIQUE that made it a no-op).
      throw new Error("insertDelegationRevocation: stored row not found after insert");
    }
    return {
      recorded: result.changes > 0,
      stored: {
        seq: row.id,
        received_at: row.received_at,
        record: JSON.parse(row.record_json) as DelegationRevocation,
      },
    };
  });
}

/**
 * The revocation set the relay holds for one delegator, and the relay-wide
 * high-water seq, read as ONE snapshot (spec §5.2/§8.1 relay atomicity MUST).
 *
 * Both reads run inside one transaction. Under WAL the snapshot is fixed at
 * the first read, so a revocation another connection commits between the two
 * reads is visible to neither: `seqHighWater` is the highest seq of a
 * committed, visible row, and every row for this delegator at or below it is
 * in `entries`. Without the transaction the second read could see a row the
 * first missed, and the relay would sign "these are all I hold for this
 * delegator up to N" while omitting a record at seq ≤ N.
 *
 * `seqHighWater` is MAX(id) — the highest committed, visible seq — not the
 * AUTOINCREMENT counter (`sqlite_sequence`). The table is append-only (no
 * pruning is wired), so MAX(id) never decreases. Entries are strictly
 * ascending by seq.
 */
export function readDelegationRevocationSet(
  db: DatabaseDriver,
  delegatorId: string,
): { seqHighWater: number; entries: StoredDelegationRevocation[] } {
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id, received_at, record_json FROM relay_delegation_revocations
         WHERE delegator_id = ?
         ORDER BY id ASC`,
      )
      .all(delegatorId) as Array<{ id: number; received_at: number; record_json: string }>;
    const hw = db
      .prepare("SELECT COALESCE(MAX(id), 0) AS hw FROM relay_delegation_revocations")
      .get() as { hw: number };
    return {
      seqHighWater: hw.hw,
      entries: rows.map((r) => ({
        seq: r.id,
        received_at: r.received_at,
        record: JSON.parse(r.record_json) as DelegationRevocation,
      })),
    };
  });
}

/**
 * Sign the §5.3 inclusion receipt for a stored row with the relay's identity
 * key. The receipt names the STORED record (its grant, delegator and
 * signature), its seq and its `received_at`, so a repeat submission gets the
 * same seq.
 */
export async function signStoredRevocationReceipt(
  relayIdentity: RelayIdentity,
  stored: StoredDelegationRevocation,
): Promise<DelegationRevocationInclusionReceipt> {
  return signRevocationInclusionReceipt(
    {
      relay_motebit_id: relayIdentity.relayMotebitId,
      relay_public_key: bytesToHex(relayIdentity.publicKey),
      revocation: stored.record,
      seq: stored.seq,
      received_at: stored.received_at,
    },
    relayIdentity.privateKey,
  );
}

/**
 * Assemble and sign the §5.2 set attestation for one delegator: every stored
 * revocation for it, strictly ascending by seq, under the relay-wide
 * high-water read in the same snapshot, echoing the consumer's challenge.
 */
export async function attestDelegationRevocationSet(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  delegatorId: string,
  challenge: string,
  now: number = Date.now(),
): Promise<DelegationRevocationSetAttestation> {
  const { seqHighWater, entries } = readDelegationRevocationSet(db, delegatorId);
  return signRevocationSetAttestation(
    {
      relay_motebit_id: relayIdentity.relayMotebitId,
      relay_public_key: bytesToHex(relayIdentity.publicKey),
      delegator_motebit_id: delegatorId,
      challenge,
      as_of: now,
      seq_high_water: seqHighWater,
      entries: entries.map((e) => ({ seq: e.seq, received_at: e.received_at, record: e.record })),
    },
    relayIdentity.privateKey,
  );
}

/**
 * List cached revocations, oldest-received first. `sinceReceivedAt` filters on
 * the relay's RECEIPT clock, not the signer-asserted `revoked_at` — a
 * backdated `revoked_at` cannot hide a record from an incremental poller.
 * Returns verbatim signed records (parsed from `record_json`), each
 * independently verifiable with no relay trust.
 */
export function listDelegationRevocations(
  db: DatabaseDriver,
  sinceReceivedAt = 0,
): { records: DelegationRevocation[]; nextSince: number } {
  const rows = db
    .prepare(
      `SELECT record_json, received_at FROM relay_delegation_revocations
       WHERE received_at > ?
       ORDER BY received_at ASC, id ASC`,
    )
    .all(sinceReceivedAt) as Array<{ record_json: string; received_at: number }>;
  const records = rows.map((r) => JSON.parse(r.record_json) as DelegationRevocation);
  const nextSince = rows.length > 0 ? rows[rows.length - 1]!.received_at : sinceReceivedAt;
  return { records, nextSince };
}

/**
 * The acceptance fence's question (tasks.ts, checkpoint D4): is `grantId`
 * revoked for this task? When the task has a submitter, a cached revocation
 * counts only when its `delegator_id` IS that submitter (#850).
 *
 * The relay holds no grants, so it cannot know a grant's delegator; `grant_id`
 * on the task wire is advisory, never authority. Matching on `grant_id` alone
 * let ANY registered identity sign `{grant_id: G, delegator_id: itself}` with
 * its own key — a valid, bound revocation — and fence another delegator's
 * grant G. Honouring only the submitter's own revocations is exact for the
 * shape minted today (self-delegation: delegator = delegate = submitter);
 * for a cross-party grant the relay fence stays silent and the runtime's
 * `verifyGrantForTurn` (`findGrantRevocation` over the full grant) remains the
 * authority — narrowing this fence can never grant anything.
 *
 * `delegatorId` null/empty — no submitter, which only the operator's master
 * token without a `submitted_by` produces — fails CLOSED: any cached
 * revocation of `grantId` fences the task (main's behaviour). Only the
 * operator holds the master token, so this case gives an attacker no leverage.
 */
export function isGrantRevokedBy(
  db: DatabaseDriver,
  grantId: string,
  delegatorId: string | null | undefined,
): boolean {
  if (typeof delegatorId !== "string" || delegatorId === "") {
    return (
      db
        .prepare("SELECT 1 FROM relay_delegation_revocations WHERE grant_id = ? LIMIT 1")
        .get(grantId) != null
    );
  }
  return (
    db
      .prepare(
        "SELECT 1 FROM relay_delegation_revocations WHERE grant_id = ? AND delegator_id = ? LIMIT 1",
      )
      .get(grantId, delegatorId) != null
  );
}

export function registerDelegationRevocationRoutes(deps: {
  app: Hono;
  db: DatabaseDriver;
  /**
   * Durable auth-event record (auth-events.ts) for refused revocations
   * (relay rule 6). Required: a refusal stops being recorded the day a
   * refactor drops an optional one.
   */
  recordAuthEvent: (event: AuthEvent) => void;
  /**
   * The relay's identity key: signs the §5.3 inclusion receipt on every POST
   * and the §5.2 set attestation on the head route.
   */
  relayIdentity: RelayIdentity;
}): void {
  const { app, db, recordAuthEvent, relayIdentity } = deps;

  // POST /api/v1/delegations/revocations — submit a signed DelegationRevocation.
  // Fully permissive by the bond-route reasoning (see module header): the
  // artifact is self-verifying and anyone MAY propagate a revocation.
  //
  // @1.3: the response carries the §5.3 `inclusion_receipt` for a new record
  // and for an already-recorded one alike (the original seq and received_at,
  // rebuilt from the stored row). A submitter counts a revocation as
  // propagated only with a receipt that verifies.
  /** @spec motebit/standing-delegation@1.0 */
  app.post("/api/v1/delegations/revocations", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
    const parsed = DelegationRevocationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: "Body is not a well-formed DelegationRevocation",
      });
    }
    const revocation = parsed.data;

    // The binder verifies the signature and that the key is one this relay
    // holds for the named delegator (never the embedded key alone, #850).
    const binding = await bindByDelegationRevocation(db, revocation);
    if ("refused" in binding) {
      // Rule 6: a refusal is logged as loudly as a recording.
      logger.warn("delegation.revocation.refused", {
        grant_id: revocation.grant_id,
        delegator_id: revocation.delegator_id,
        reason: binding.refused,
        correlationId: c.req.header("x-correlation-id") ?? null,
      });
      // Rule 6: recorded durably. No token is presented on this route; the
      // subject is the CLAIMED delegator (the artifact's `delegator_id`), the
      // way a token rejection records the claimed `mid`.
      recordAuthEvent({
        kind: "agent_token_rejected",
        method: c.req.method,
        path: c.req.path,
        motebitId: typeof revocation.delegator_id === "string" ? revocation.delegator_id : null,
        audience: null,
        reason: binding.refused,
        correlationId: c.req.header("x-correlation-id") ?? null,
      });
      if (binding.refused === "delegation_revocation:signature_invalid") {
        // Fail-closed: parsed shape but the Ed25519 signature does not verify
        // against its delegator_public_key — not a signed statement.
        throw new HTTPException(422, { message: "Revocation signature invalid" });
      }
      // A signed statement, but not by the delegator it names: the key is not
      // one this relay holds for `delegator_id` (a stranger's own keypair, a
      // rotated-out key, or a delegator this relay does not know).
      throw new HTTPException(403, {
        message:
          "Revocation is not signed by a key this relay holds for its delegator_id — only the grant's delegator may revoke it",
      });
    }

    const { recorded, stored } = insertDelegationRevocation(db, binding.bound, revocation);
    const inclusionReceipt = await signStoredRevocationReceipt(relayIdentity, stored);
    logger.info(
      recorded ? "delegation.revocation.recorded" : "delegation.revocation.already_recorded",
      {
        grant_id: revocation.grant_id,
        delegator_id: revocation.delegator_id,
        seq: stored.seq,
        correlationId: c.req.header("x-correlation-id") ?? null,
      },
    );
    return c.json({
      ok: true,
      grant_id: revocation.grant_id,
      status: recorded ? "recorded" : "already_recorded",
      inclusion_receipt: inclusionReceipt,
    });
  });

  // GET /api/v1/delegations/revocations?since=<received_at ms> — the cache
  // read. Public: revocations want maximum reach. Each record is
  // delegator-signed and offline-verifiable; the response body is a cache
  // projection, not a relay assertion (§6 D2), so no relay envelope signature.
  // Propagation-only (§5.1): it MUST NOT be money evidence; the signed set
  // attestation below is.
  /** @spec motebit/standing-delegation@1.0 */
  app.get("/api/v1/delegations/revocations", (c) => {
    const sinceRaw = c.req.query("since");
    const since = sinceRaw !== undefined ? Number(sinceRaw) : 0;
    if (!Number.isFinite(since) || since < 0) {
      throw new HTTPException(400, { message: "Invalid `since` — expected non-negative ms" });
    }
    const { records, nextSince } = listDelegationRevocations(db, since);
    return c.json({ generated_at: Date.now(), next_since: nextSince, records });
  });

  // GET /api/v1/delegations/revocations/head?delegator_motebit_id=&challenge=
  // — the §5.2 DelegationRevocationSetAttestation: the relay's signed
  // statement of every revocation it holds for one delegator up to
  // `seq_high_water`, answering the consumer's challenge. Public, for the
  // reason the cache read above is (§5.2): a consumer deciding whether a grant
  // may move money holds no relay token, the artifact verifies under the relay
  // key the consumer pins, and every entry is a delegator-signed record the
  // unsigned feed already serves to anyone. It never confers authority (an
  // AND-condition on top of a verified grant). A @1.3 addition; the spec's
  // identifier, which the annotation names, stays `@1.0`.
  /** @spec motebit/standing-delegation@1.0 */
  app.get("/api/v1/delegations/revocations/head", async (c) => {
    const delegatorId = c.req.query("delegator_motebit_id");
    const challenge = c.req.query("challenge");
    if (delegatorId === undefined || delegatorId === "") {
      throw new HTTPException(400, { message: "Missing `delegator_motebit_id`" });
    }
    const idRefusal = refuseInvalidIds({ motebitId: delegatorId });
    if (idRefusal !== null) {
      throw new HTTPException(400, {
        message: `Invalid \`delegator_motebit_id\`: ${idRefusal.error}`,
      });
    }
    // The verifier's bounds (spec §5.2 challenge MUST). An attestation echoing
    // a challenge outside them is one every verifier refuses, so refuse here.
    if (
      challenge === undefined ||
      challenge.length < REVOCATION_SET_ATTESTATION_CHALLENGE_MIN_LENGTH ||
      challenge.length > REVOCATION_SET_ATTESTATION_CHALLENGE_MAX_LENGTH
    ) {
      throw new HTTPException(400, {
        message: `Invalid \`challenge\` — expected a fresh value of ${REVOCATION_SET_ATTESTATION_CHALLENGE_MIN_LENGTH}–${REVOCATION_SET_ATTESTATION_CHALLENGE_MAX_LENGTH} characters with at least 128 bits of entropy`,
      });
    }
    const attestation = await attestDelegationRevocationSet(
      db,
      relayIdentity,
      delegatorId,
      challenge,
    );
    logger.info("delegation.revocation_set.attested", {
      delegator_id: delegatorId,
      seq_high_water: attestation.seq_high_water,
      count: attestation.count,
      correlationId: c.req.header("x-correlation-id") ?? null,
    });
    return c.json(attestation);
  });
}
