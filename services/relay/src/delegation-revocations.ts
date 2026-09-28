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
 * revocation alone, and the acceptance fence (`listRevokedGrantIds`) matches
 * on `grant_id` alone — so a stranger with a fresh keypair who knew a
 * `grant_id` could make the relay refuse that grant's tasks.
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
import type { DelegationRevocation } from "@motebit/crypto";
import { DelegationRevocationSchema } from "@motebit/wire-schemas";
import { bindByDelegationRevocation, unwrapBound, type BoundIdentity } from "./identity-binding.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "delegation-revocations" });

/**
 * Record a revocation under the delegator it was bound to. Append-only,
 * idempotent on the signature (Ed25519 is deterministic: same body + same
 * key ⇒ same signature, so a re-submission is a no-op, not a duplicate row).
 * `record_json` stores the byte-identical canonical artifact
 * (`relay_receipts.receipt_json` discipline, CLAUDE.md rule 11) so consumers
 * re-verify exactly what the delegator signed. Returns `true` when newly
 * recorded, `false` when already present.
 *
 * `owner` is the delegator `bindByDelegationRevocation` proved signed it —
 * the signature verified under a key the relay holds for that identity. A
 * revocation that does not name `owner` as its delegator is refused here
 * (throws, writes nothing), so the row and the binding agree.
 */
export function insertDelegationRevocation(
  db: DatabaseDriver,
  owner: BoundIdentity,
  revocation: DelegationRevocation,
  receivedAt: number = Date.now(),
): boolean {
  if (revocation.delegator_id !== unwrapBound(owner)) {
    throw new TypeError(
      "insertDelegationRevocation: the revocation's delegator_id is not the bound delegator (#850)",
    );
  }
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
  return result.changes > 0;
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

/** The set of revoked grant_ids — the relay-side `isRevoked` seam input. */
export function listRevokedGrantIds(db: DatabaseDriver): Set<string> {
  const rows = db
    .prepare(`SELECT DISTINCT grant_id FROM relay_delegation_revocations`)
    .all() as Array<{ grant_id: string }>;
  return new Set(rows.map((r) => r.grant_id));
}

export function registerDelegationRevocationRoutes(deps: { app: Hono; db: DatabaseDriver }): void {
  const { app, db } = deps;

  // POST /api/v1/delegations/revocations — submit a signed DelegationRevocation.
  // Fully permissive by the bond-route reasoning (see module header): the
  // artifact is self-verifying and anyone MAY propagate a revocation.
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

    const recorded = insertDelegationRevocation(db, binding.bound, revocation);
    logger.info(
      recorded ? "delegation.revocation.recorded" : "delegation.revocation.already_recorded",
      {
        grant_id: revocation.grant_id,
        delegator_id: revocation.delegator_id,
      },
    );
    return c.json({
      ok: true,
      grant_id: revocation.grant_id,
      status: recorded ? "recorded" : "already_recorded",
    });
  });

  // GET /api/v1/delegations/revocations?since=<received_at ms> — the cache
  // read. Public: revocations want maximum reach. Each record is
  // delegator-signed and offline-verifiable; the response body is a cache
  // projection, not a relay assertion (§6 D2), so no relay envelope signature.
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
}
