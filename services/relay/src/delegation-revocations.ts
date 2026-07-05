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
 * ingestion verifies the revocation's own Ed25519 signature
 * (`verifyDelegationRevocation`), and a stored revocation only ever has
 * authority over grants whose `delegator_public_key` matches it
 * (`findGrantRevocation` at the consumer). A third party "propagating" someone
 * else's valid revocation is a feature — revocation wants to travel; the worst
 * a hostile submitter can do is store self-signed revocations of grant_ids
 * nobody issued, which revoke nothing. Invalid signatures are rejected 422.
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
import { verifyDelegationRevocation, type DelegationRevocation } from "@motebit/crypto";
import { DelegationRevocationSchema } from "@motebit/wire-schemas";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "delegation-revocations" });

/**
 * Record a verified revocation. Append-only, idempotent on the signature
 * (Ed25519 is deterministic: same body + same key ⇒ same signature, so a
 * re-submission is a no-op, not a duplicate row). `record_json` stores the
 * byte-identical canonical artifact (`relay_receipts.receipt_json`
 * discipline, CLAUDE.md rule 11) so consumers re-verify exactly what the
 * delegator signed. Returns `true` when newly recorded, `false` when already
 * present. The CALLER must have verified the signature first.
 */
export function insertDelegationRevocation(
  db: DatabaseDriver,
  revocation: DelegationRevocation,
  receivedAt: number = Date.now(),
): boolean {
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
    const revocation = parsed.data as DelegationRevocation;

    if (!(await verifyDelegationRevocation(revocation))) {
      // Fail-closed: parsed shape but the Ed25519 signature does not verify
      // against its own delegator_public_key — not a signed statement.
      throw new HTTPException(422, { message: "Revocation signature invalid" });
    }

    const recorded = insertDelegationRevocation(db, revocation);
    if (recorded) {
      logger.info("delegation.revocation.recorded", {
        grant_id: revocation.grant_id,
        delegator_id: revocation.delegator_id,
      });
    }
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
