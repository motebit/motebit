/**
 * Key Rotation, Revocation & Multi-Party Approval Quorum routes.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import type { KeySuccessionRecord } from "@motebit/encryption";
import {
  verifyKeySuccession,
  verify,
  canonicalJson,
  bytesToHex,
  hexToBytes,
} from "@motebit/encryption";
import { insertRevocationEvent } from "./federation.js";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";
import type { AuthEvent } from "./auth-events.js";

const logger = createLogger({ service: "key-rotation" });

export interface KeyRotationDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  relayIdentity: RelayIdentity;
  /**
   * Durable auth-event record (auth-events.ts). Required: this module has
   * one caller, and an optional recorder is a refusal that stops being
   * recorded the day a refactor drops the field, with nothing going red.
   */
  recordAuthEvent: (event: AuthEvent) => void;
}

/** Initialize approval tables and register all key-rotation/revocation/approval routes. */
export function registerKeyRotationRoutes(deps: KeyRotationDeps): void {
  const { app, moteDb, relayIdentity, recordAuthEvent } = deps;

  // --- Approval tables (idempotent) ---
  moteDb.db.exec(`
    CREATE TABLE IF NOT EXISTS relay_approval_votes (
      vote_id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      approver_id TEXT NOT NULL,
      approved INTEGER NOT NULL,
      signature TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_approval_votes_approval ON relay_approval_votes(approval_id);
  `);

  moteDb.db.exec(`
    CREATE TABLE IF NOT EXISTS relay_approval_metadata (
      approval_id TEXT PRIMARY KEY,
      motebit_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      quorum_required INTEGER NOT NULL DEFAULT 1,
      quorum_approvers TEXT NOT NULL DEFAULT '[]',
      quorum_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  try {
    moteDb.db.exec(
      "ALTER TABLE relay_approval_metadata ADD COLUMN quorum_hash TEXT NOT NULL DEFAULT ''",
    );
  } catch {
    /* column may already exist */
  }

  async function computeQuorumHash(required: number, approvers: string[]): Promise<string> {
    const normalized = [...approvers].sort();
    const canonical = canonicalJson({ quorum_required: required, quorum_approvers: normalized });
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return bytesToHex(new Uint8Array(buf));
  }

  // --- Key rotation ---
  /** @spec motebit/identity@1.0 */
  app.post("/api/v1/agents/:motebitId/rotate-key", async (c) => {
    const motebitId = c.req.param("motebitId");
    const caller = c.get("callerMotebitId" as never) as string | undefined;
    /**
     * Refuse, loudly and durably. An attempt to write another identity's
     * key history is exactly what the operator's auth-event record exists
     * to show (`services/relay/CLAUDE.md` rule 6).
     */
    const refuse = (status: 400 | 403, reason: string, message: string): HTTPException => {
      logger.warn("key_rotation.refused", { motebitId, caller: caller ?? null, reason });
      recordAuthEvent({
        kind: "agent_token_rejected",
        method: "POST",
        path: c.req.path,
        // The SUBJECT of a refusal is whoever presented it. The target
        // identity is already in `path`; writing it here would read as
        // "this identity's token was rejected" for an identity that
        // presented nothing (the operator's master token carries none).
        motebitId: caller,
        reason: `succession:${reason}`,
        correlationId: c.req.header("x-correlation-id") ?? null,
      });
      return new HTTPException(status, { message });
    };

    const body = await c.req.json<KeySuccessionRecord>();

    // An ORDINARY succession is the identity's own act. The signed payload
    // names two keys and no motebit_id, so the record cannot say whose
    // history it belongs to — this does. Strict inequality on a PRESENT
    // caller: the operator's master token carries no caller identity and
    // passes, as it does on this route today.
    //
    // A guardian RECOVERY is exempt, and has to be: it exists for an owner
    // who has LOST the key (`spec/identity-v1.md` §3.8.3), so it is by
    // design carried by someone else. What authorizes one is the
    // guardian's signature, checked below against the guardian key THIS
    // identity registered — and, since that lookup needs a registry row,
    // a recovery is anchored to a key on file by the same check as any
    // other record.
    if (body.recovery !== true && caller != null && caller !== motebitId) {
      throw refuse(
        403,
        "under_another_identity",
        "a key succession may be presented only under the identity it rotates",
      );
    }

    if (
      !body.old_public_key ||
      !body.new_public_key ||
      !body.timestamp ||
      !body.new_key_signature
    ) {
      throw new HTTPException(400, { message: "Missing required fields in key succession record" });
    }

    // Timestamp freshness: reject succession records older than 15 minutes or in the future
    const MAX_ROTATION_AGE_MS = 15 * 60 * 1000;
    const age = Date.now() - body.timestamp;
    if (age < -60_000) {
      // Allow 1 minute clock skew for future timestamps
      throw new HTTPException(400, { message: "Succession record timestamp is in the future" });
    }
    if (age > MAX_ROTATION_AGE_MS) {
      throw new HTTPException(400, {
        message: "Succession record timestamp is too old (>15 minutes)",
      });
    }

    if (body.recovery) {
      // Guardian recovery: need guardian_signature, not old_key_signature
      if (!body.guardian_signature) {
        throw refuse(
          400,
          "recovery_without_guardian_signature",
          "Guardian recovery requires guardian_signature",
        );
      }
      // Look up the guardian public key from agent's identity
      const agentGuardian = moteDb.db
        .prepare("SELECT guardian_public_key FROM agent_registry WHERE motebit_id = ?")
        .get(motebitId) as { guardian_public_key: string | null } | undefined;
      const guardianPubKey = agentGuardian?.guardian_public_key;
      if (!guardianPubKey) {
        throw refuse(
          400,
          "recovery_without_registered_guardian",
          "Agent has no guardian registered — cannot use guardian recovery",
        );
      }
      const valid = await verifyKeySuccession(body, guardianPubKey);
      if (!valid) {
        throw refuse(400, "recovery_signature_invalid", "Invalid guardian recovery signatures");
      }
    } else {
      // Normal rotation: need old_key_signature
      if (!body.old_key_signature) {
        throw refuse(
          400,
          "rotation_without_old_key_signature",
          "Normal rotation requires old_key_signature",
        );
      }
      const valid = await verifyKeySuccession(body);
      if (!valid) {
        throw refuse(400, "rotation_signature_invalid", "Invalid key succession signatures");
      }
    }

    if (body.new_public_key === body.old_public_key) {
      throw refuse(
        400,
        "goes_nowhere",
        "Succession new_public_key must differ from old_public_key",
      );
    }

    // The record must depart from a key this relay HOLDS for the identity.
    // This check used to be skipped whenever the stored key was absent or
    // the empty string — both routine states, not corner cases: the daemon
    // deregisters on every shutdown (dropping the registry row), and a
    // master-token registration with no key writes `''`. Skipping it let a
    // chain be planted from two keys nobody had ever seen, and let one
    // guardian's genuine record be replayed at a sibling identity.
    //
    // A device row's key counts, so an identity whose daemon has shut down
    // can still rotate. Refusing when the relay holds NO key at all is
    // fail-closed: there is nothing for the record to continue from.
    // Does the chain already hold this link? Two doors write it: this route,
    // and the succession path of `/agents/register`, which moves the registry
    // key and records the link while touching neither the device rows nor
    // the pairing payloads. So "already recorded" is NOT "already applied",
    // and it must not short-circuit — #710 tried a "fully applied" precheck
    // (registry moved AND no device row holds the old key) and it was
    // unreachable for the register door, because the key-on-file rule below
    // then refused the record as "not from the current key" (the registry
    // had moved). A held link answers a different question: it decides the
    // SHAPE of what follows, never whether anything follows. The signatures
    // were verified above, the link is this identity's own history already,
    // so the key-on-file rule has nothing left to protect here — what is left
    // is retiring every credential the link retires, and the writes in the
    // transaction below are idempotent and scoped to the retired key, so a
    // retry after a lost response and a link another door recorded both
    // converge on the same state. `applied` reports whether the CHAIN grew.
    const linkAlreadyHeld =
      moteDb.db
        .prepare(
          "SELECT 1 FROM relay_key_successions WHERE motebit_id = ? AND old_public_key = ? AND new_public_key = ? LIMIT 1",
        )
        .get(motebitId, body.old_public_key, body.new_public_key) != null;

    // Precedence, most authoritative first. Comparison is EXACT: these
    // keys are covered by the signature, and a record stored in a spelling
    // that differs from the one signed breaks `verifySuccessionChain`'s
    // linkage on the public surfaces this rule exists to protect.
    const storedAgent = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { public_key: string } | undefined;
    const registryKey =
      storedAgent?.public_key != null && storedAgent.public_key !== ""
        ? storedAgent.public_key
        : null;
    // The head of what this relay has already RECORDED. Without it an
    // identity whose registry row is gone could rotate exactly once: the
    // registry UPDATE below writes no rows, so the second rotation found
    // nothing on file and was refused — and rotating twice worked before
    // this rule existed. The chain is the record of the first rotation,
    // so it is what the second one continues from. It is reachable only
    // AFTER a rotation that already passed this check, so it cannot be
    // used to bootstrap a chain out of nothing.
    const chainHead = moteDb.db
      .prepare(
        "SELECT new_public_key FROM relay_key_successions WHERE motebit_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(motebitId) as { new_public_key: string } | undefined;
    if (linkAlreadyHeld) {
      // Nothing to protect: the link is already this identity's recorded
      // history, and the key it departs from has by definition moved on.
      // Skipping the rule here is what makes the register door's link
      // finishable and a lost-response retry answerable (#710 finding 4).
    } else if (registryKey != null) {
      if (registryKey !== body.old_public_key) {
        throw refuse(
          400,
          "not_from_current_key",
          "Succession old_public_key does not match stored public key",
        );
      }
    } else if (chainHead != null) {
      if (chainHead.new_public_key !== body.old_public_key) {
        throw refuse(
          400,
          "not_from_current_key",
          "Succession old_public_key does not match the head of this identity's recorded chain",
        );
      }
    } else {
      const heldByDevice = moteDb.db
        .prepare("SELECT 1 FROM devices WHERE motebit_id = ? AND public_key = ? LIMIT 1")
        .get(motebitId, body.old_public_key);
      if (heldByDevice == null) {
        throw refuse(
          400,
          "no_key_on_file",
          "Succession old_public_key is not a key this relay holds for this identity",
        );
      }
    }

    // Everything a recorded rotation changes, in ONE transaction. Written
    // as three statements, a crash between them left the registry saying
    // the new key while the device rows still verified tokens under the
    // old one — and from there the owner could not rotate again (the
    // record no longer departs from the stored key), could not
    // re-register (the row disagrees) and could not authenticate. There
    // was no way back without the operator.
    //
    // Devices are written FIRST for the same reason: if this ever stops
    // being one transaction, the half-applied state that remains is the
    // recoverable one.
    const applied = moteDb.db.transaction(() => {
      // The old key stops being a credential HERE. A device row's
      // `public_key` is what an owner token is verified against, and it is
      // resolved BEFORE the registry key, so a stale row shadows the
      // rotation entirely. Scoped to rows holding the key being retired: a
      // device linked without key transfer holds its own key, which this
      // rotation is not about (`docs/doctrine/security-boundaries.md` —
      // rotating an identity must not rotate independent device keypairs).
      // The attached hardware-attestation credential names the key it was
      // bound to (`sync-routes.ts` refuses a mismatch at attach time), so
      // carrying it across a rotation would publish a credential that
      // names a key the row no longer holds — and a peer checking the
      // binding this relay itself enforces would reject it. Dropped, so
      // the device re-attaches against the key it now holds.
      moteDb.db
        .prepare(
          "UPDATE devices SET public_key = ?, hardware_attestation_credential = NULL WHERE motebit_id = ? AND public_key = ?",
        )
        .run(body.new_public_key, motebitId, body.old_public_key);

      // A pairing session approved before this rotation carries the key
      // that was just retired, and pairing's key-transfer route takes no
      // bearer. Left alone, whoever holds that pairing id could write the
      // retired key back onto a device row and authenticate again — the
      // rotation undone by an unauthenticated route. Clearing the payload
      // is what makes that route refuse ("this session approved none");
      // `status` is left alone because clients switch on its values.
      // Scoped to approvals that carry the key being retired. Clearing
      // every session would also strand a pairing approved under a key
      // this rotation is not about, mid-transfer and with no signal.
      const stale = moteDb.db
        .prepare(
          "SELECT pairing_id, key_transfer_payload FROM pairing_sessions WHERE motebit_id = ? AND key_transfer_payload IS NOT NULL",
        )
        .all(motebitId) as Array<{ pairing_id: string; key_transfer_payload: string }>;
      for (const session of stale) {
        let carries = false;
        try {
          const kt = JSON.parse(session.key_transfer_payload) as Record<string, unknown>;
          carries = kt["identity_pubkey_check"] === body.old_public_key;
        } catch {
          // A payload this relay cannot read cannot be shown to be safe.
          carries = true;
        }
        if (carries) {
          moteDb.db
            .prepare("UPDATE pairing_sessions SET key_transfer_payload = NULL WHERE pairing_id = ?")
            .run(session.pairing_id);
        }
      }

      // The registry key moves only FROM the key this link retires, or into
      // an empty slot when this link is (or is about to be) the head of the
      // chain. Unscoped, a late retry of an OLD link would drag a registry
      // that had since moved on to a later key back to this one — and the
      // next rotation, departing from the real head, would be refused as
      // "not from the current key". An empty slot is the master-token
      // registration case (`''`), which the head of the chain is entitled
      // to fill and an older link is not.
      const willBeHead = !linkAlreadyHeld || chainHead?.new_public_key === body.new_public_key;
      moteDb.db
        .prepare(
          `UPDATE agent_registry SET public_key = ? WHERE motebit_id = ? AND (public_key = ? OR (COALESCE(public_key, '') = '' AND ? = 1))`,
        )
        .run(body.new_public_key, motebitId, body.old_public_key, willBeHead ? 1 : 0);

      // The chain grows only if it does not already hold this link. A lost
      // response and a retry must not append the same link twice: the chain
      // is served in timestamp order, and two identical links make a history
      // a verifier cannot walk. Everything above still ran, which is the
      // point — that is what "already recorded but not applied" needed.
      if (linkAlreadyHeld) return false;
      moteDb.db
        .prepare(
          `INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, reason, old_key_signature, new_key_signature, recovery, guardian_signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          motebitId,
          body.old_public_key,
          body.new_public_key,
          body.timestamp,
          body.reason ?? null,
          body.old_key_signature ?? null,
          body.new_key_signature,
          body.recovery ? 1 : 0,
          body.guardian_signature ?? null,
        );
      return true;
    });

    logger.info("key_rotation.recorded", {
      motebitId,
      recovery: body.recovery === true,
      applied,
    });
    return c.json({ ok: true, motebit_id: motebitId, applied });
  });

  // --- Key succession chain query ---
  /** @spec motebit/identity@1.0 */
  app.get("/api/v1/agents/:motebitId/succession", (c) => {
    const motebitId = c.req.param("motebitId");
    const correlationId = c.req.header("x-correlation-id") ?? crypto.randomUUID();

    const chain = moteDb.db
      .prepare(
        `SELECT old_public_key, new_public_key, timestamp, reason, old_key_signature, new_key_signature, recovery, guardian_signature FROM relay_key_successions WHERE motebit_id = ? ORDER BY timestamp ASC`,
      )
      .all(motebitId) as Array<{
      old_public_key: string;
      new_public_key: string;
      timestamp: number;
      reason: string | null;
      old_key_signature: string | null;
      new_key_signature: string;
      recovery: number;
      guardian_signature: string | null;
    }>;

    const agent = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { public_key: string } | undefined;

    logger.info("agent.succession.query", { correlationId, motebitId, chainLength: chain.length });

    return c.json({
      motebit_id: motebitId,
      chain: chain.map((r) => ({
        old_public_key: r.old_public_key,
        new_public_key: r.new_public_key,
        timestamp: r.timestamp,
        reason: r.reason,
        ...(r.old_key_signature ? { old_key_signature: r.old_key_signature } : {}),
        new_key_signature: r.new_key_signature,
        ...(r.recovery === 1 ? { recovery: true, guardian_signature: r.guardian_signature } : {}),
      })),
      current_public_key: agent?.public_key ?? null,
    });
  });

  // --- Token revocation ---
  /** @spec motebit/identity@1.0 */
  app.post("/api/v1/agents/:motebitId/revoke-tokens", async (c) => {
    const motebitId = c.req.param("motebitId");
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId && callerMotebitId !== motebitId)
      throw new HTTPException(403, { message: "Cannot revoke tokens for another agent" });
    const body = await c.req.json<{ jtis: string[] }>();
    if (!Array.isArray(body.jtis) || body.jtis.length === 0)
      throw new HTTPException(400, { message: "jtis must be a non-empty array" });
    const expiresAt = Date.now() + 6 * 60 * 1000;
    const stmt = moteDb.db.prepare(
      "INSERT OR IGNORE INTO relay_token_blacklist (jti, motebit_id, expires_at) VALUES (?, ?, ?)",
    );
    for (const jti of body.jtis) {
      stmt.run(jti, motebitId, expiresAt);
    }
    return c.json({ ok: true, revoked: body.jtis.length });
  });

  // --- Agent revocation ---
  /** @spec motebit/identity@1.0 */
  app.post("/api/v1/agents/:motebitId/revoke", async (c) => {
    const motebitId = c.req.param("motebitId");
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId && callerMotebitId !== motebitId)
      throw new HTTPException(403, { message: "Cannot revoke another agent" });

    // Optional `compromised_at` (epoch ms) backdates the on-chain revocation
    // memo to the true compromise moment, narrowing the verifier's poison
    // window. Body is optional — a bare revoke still works. Backdating only:
    // a future timestamp is rejected so a caller can never un-poison a live
    // attack window. See `credential-anchor-v1.md` §10.2.
    let compromisedAt: number | undefined;
    const raw = await c.req.text();
    if (raw.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new HTTPException(400, { message: "Invalid JSON body" });
      }
      const ca = (parsed as { compromised_at?: unknown }).compromised_at;
      if (ca !== undefined) {
        if (typeof ca !== "number" || !Number.isFinite(ca) || ca <= 0 || ca > Date.now())
          throw new HTTPException(400, {
            message: "compromised_at must be a positive past epoch-ms timestamp",
          });
        compromisedAt = ca;
      }
    }

    const agent = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { public_key: string } | undefined;
    moteDb.db.prepare("UPDATE agent_registry SET revoked = 1 WHERE motebit_id = ?").run(motebitId);
    try {
      await insertRevocationEvent(moteDb.db, relayIdentity, "agent_revoked", motebitId, {
        revokedPublicKey: agent?.public_key,
        effectiveAt: compromisedAt,
      });
    } catch {
      /* best-effort */
    }
    return c.json({ ok: true, motebit_id: motebitId, revoked: true });
  });

  // --- Create approval request ---
  /** @spec motebit/identity@1.0 */
  app.post("/api/v1/agents/:motebitId/approvals", async (c) => {
    const motebitId = c.req.param("motebitId");
    const body = await c.req.json<{
      approval_id: string;
      tool_name: string;
      args_hash: string;
      quorum_required: number;
      quorum_approvers: string[];
    }>();
    if (!body.approval_id || !body.tool_name || !body.args_hash)
      throw new HTTPException(400, {
        message: "approval_id, tool_name, and args_hash are required",
      });

    const quorumRequired = body.quorum_required ?? 1;
    const quorumApprovers = JSON.stringify(body.quorum_approvers ?? []);

    const existing = moteDb.db
      .prepare(
        "SELECT motebit_id, tool_name, args_hash, quorum_required, quorum_approvers, quorum_hash FROM relay_approval_metadata WHERE approval_id = ?",
      )
      .get(body.approval_id) as
      | {
          motebit_id: string;
          tool_name: string;
          args_hash: string;
          quorum_required: number;
          quorum_approvers: string;
          quorum_hash: string;
        }
      | undefined;

    if (existing != null) {
      if (
        existing.motebit_id === motebitId &&
        existing.tool_name === body.tool_name &&
        existing.args_hash === body.args_hash &&
        existing.quorum_required === quorumRequired &&
        existing.quorum_approvers === quorumApprovers
      ) {
        return c.json({
          ok: true,
          approval_id: body.approval_id,
          quorum_hash: existing.quorum_hash,
          idempotent: true,
        });
      }
      throw new HTTPException(409, {
        message:
          "Approval already exists with different configuration — approval metadata is immutable after creation",
      });
    }

    const qHash = await computeQuorumHash(quorumRequired, body.quorum_approvers ?? []);
    moteDb.db
      .prepare(
        "INSERT INTO relay_approval_metadata (approval_id, motebit_id, tool_name, args_hash, quorum_required, quorum_approvers, quorum_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        body.approval_id,
        motebitId,
        body.tool_name,
        body.args_hash,
        quorumRequired,
        quorumApprovers,
        qHash,
      );

    return c.json({ ok: true, approval_id: body.approval_id, quorum_hash: qHash });
  });

  // --- Submit vote ---
  /** @spec motebit/identity@1.0 */
  app.post("/api/v1/agents/:motebitId/approvals/:approvalId/vote", async (c) => {
    const motebitId = c.req.param("motebitId");
    const approvalId = c.req.param("approvalId");
    const body = await c.req.json<{ approver_id: string; approved: boolean; signature: string }>();

    if (!body.approver_id || body.approved == null || !body.signature)
      throw new HTTPException(400, {
        message: "approver_id, approved, and signature are required",
      });

    const approval = moteDb.db
      .prepare("SELECT * FROM relay_approval_metadata WHERE approval_id = ?")
      .get(approvalId) as
      | {
          approval_id: string;
          motebit_id: string;
          tool_name: string;
          args_hash: string;
          quorum_required: number;
          quorum_approvers: string;
          quorum_hash: string;
          status: string;
        }
      | undefined;
    if (!approval) throw new HTTPException(404, { message: "Approval not found" });
    if (!approval.quorum_hash)
      throw new HTTPException(500, {
        message: "Approval missing quorum_hash — created before migration. Re-register to fix.",
      });
    if (approval.status === "denied")
      throw new HTTPException(409, {
        message: "Approval already denied — no further votes accepted",
      });
    if (approval.status === "approved")
      throw new HTTPException(409, {
        message: "Approval already met quorum — no further votes needed",
      });
    if (approval.motebit_id !== motebitId)
      throw new HTTPException(403, { message: "Approval does not belong to this agent" });

    const authorizedApprovers = JSON.parse(approval.quorum_approvers) as string[];
    if (authorizedApprovers.length > 0 && !authorizedApprovers.includes(body.approver_id))
      throw new HTTPException(403, { message: "Approver is not authorized for this quorum" });

    const encoder = new TextEncoder();
    const votePayload = canonicalJson({
      type: "approval_vote",
      motebit_id: motebitId,
      approval_id: approvalId,
      args_hash: approval.args_hash,
      quorum_hash: approval.quorum_hash,
      approver_id: body.approver_id,
      decision: body.approved ? "approve" : "deny",
    });

    const approverAgent = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(body.approver_id) as { public_key: string } | undefined;
    if (!approverAgent) throw new HTTPException(404, { message: "Approver agent not found" });

    const sigValid = await verify(
      hexToBytes(body.signature),
      encoder.encode(votePayload),
      hexToBytes(approverAgent.public_key),
    );
    if (!sigValid) throw new HTTPException(403, { message: "Vote signature verification failed" });

    const existingVote = moteDb.db
      .prepare("SELECT 1 FROM relay_approval_votes WHERE approval_id = ? AND approver_id = ?")
      .get(approvalId, body.approver_id) as Record<string, unknown> | undefined;
    if (existingVote != null) return c.json({ ok: true, duplicate: true, approval_id: approvalId });

    const voteId = `vote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    moteDb.db
      .prepare(
        "INSERT INTO relay_approval_votes (vote_id, approval_id, approver_id, approved, signature) VALUES (?, ?, ?, ?, ?)",
      )
      .run(voteId, approvalId, body.approver_id, body.approved ? 1 : 0, body.signature);

    if (!body.approved) {
      moteDb.db
        .prepare("UPDATE relay_approval_metadata SET status = 'denied' WHERE approval_id = ?")
        .run(approvalId);
      return c.json({
        ok: true,
        approval_id: approvalId,
        vote_id: voteId,
        status: "denied",
        reason: "Deny vote received — approval terminated (fail-closed)",
      });
    }

    const approvedCount = (
      moteDb.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM relay_approval_votes WHERE approval_id = ? AND approved = 1",
        )
        .get(approvalId) as { cnt: number }
    ).cnt;
    const quorumMet = approvedCount >= approval.quorum_required;
    if (quorumMet)
      moteDb.db
        .prepare("UPDATE relay_approval_metadata SET status = 'approved' WHERE approval_id = ?")
        .run(approvalId);

    return c.json({
      ok: true,
      approval_id: approvalId,
      vote_id: voteId,
      approved_count: approvedCount,
      quorum_required: approval.quorum_required,
      quorum_met: quorumMet,
      status: quorumMet ? "approved" : "pending",
    });
  });

  // --- Approval quorum status ---
  /** @spec motebit/identity@1.0 */
  app.get("/api/v1/agents/:motebitId/approvals/:approvalId", (c) => {
    const motebitId = c.req.param("motebitId");
    const approvalId = c.req.param("approvalId");

    const approval = moteDb.db
      .prepare("SELECT * FROM relay_approval_metadata WHERE approval_id = ? AND motebit_id = ?")
      .get(approvalId, motebitId) as
      | { quorum_required: number; quorum_approvers: string; quorum_hash: string; status: string }
      | undefined;
    const votes = moteDb.db
      .prepare(
        "SELECT approver_id, approved, created_at FROM relay_approval_votes WHERE approval_id = ?",
      )
      .all(approvalId) as Array<{ approver_id: string; approved: number; created_at: number }>;

    const approvedVotes = votes.filter((v) => v.approved === 1).map((v) => v.approver_id);
    const deniedVotes = votes.filter((v) => v.approved === 0).map((v) => v.approver_id);

    return c.json({
      approval_id: approvalId,
      status: approval?.status ?? "unknown",
      quorum_required: approval?.quorum_required ?? 1,
      quorum_hash: approval?.quorum_hash,
      approved_by: approvedVotes,
      denied_by: deniedVotes,
      total_votes: votes.length,
      quorum_met: approval != null && approvedVotes.length >= approval.quorum_required,
    });
  });
}
