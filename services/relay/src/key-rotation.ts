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
import {
  callerIsStillCurrent,
  provableIdentityKey,
  recordSuccession,
} from "./identity-key-authority.js";
import type { FirstPersonCaller } from "./identity-key-authority.js";
import type { AuthEvent } from "./auth-events.js";
import type { ConnectedDevice } from "./websocket.js";

const logger = createLogger({ service: "key-rotation" });

export interface KeyRotationDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  relayIdentity: RelayIdentity;
  /** Open sockets per identity — ended when its key rotates (identity-key-authority.ts rule 2). */
  connections?: Map<string, ConnectedDevice[]>;
  /** Durable auth-event record (auth-events.ts); optional for hand-built test deps. */
  recordAuthEvent?: (event: AuthEvent) => void;
}

/** Initialize approval tables and register all key-rotation/revocation/approval routes. */
export function registerKeyRotationRoutes(deps: KeyRotationDeps): void {
  const { app, moteDb, relayIdentity, connections, recordAuthEvent } = deps;

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
    // A succession is the identity's own act. A record is self-verifying
    // about its two keys and says nothing about WHICH identity it belongs
    // to (the signed payload carries no motebit_id), so without this any
    // authenticated caller could record one under any identity. The
    // operator's master token carries no caller identity and passes.
    const caller = c.get("callerMotebitId" as never) as string | undefined;
    const refuse = (status: 400 | 401 | 403 | 409, reason: string, message: string): never => {
      logger.warn("key_rotation.refused", { motebitId, caller: caller ?? null, reason });
      recordAuthEvent?.({
        kind: "agent_token_rejected",
        method: "POST",
        path: c.req.path,
        motebitId: caller ?? motebitId,
        reason: `identity_key_authority:${reason}`,
        correlationId: c.req.header("x-correlation-id") ?? null,
      });
      throw new HTTPException(status, { message });
    };
    if (caller != null && caller !== motebitId) {
      refuse(
        403,
        "SUCCESSION_UNDER_ANOTHER_IDENTITY",
        "a key succession may be presented only under the identity it rotates",
      );
    }
    const firstPerson: FirstPersonCaller | null =
      caller == null
        ? null
        : {
            deviceId: c.get("callerDeviceId" as never) as string | undefined,
            verifiedKey: c.get("callerVerifiedKey" as never) as string | undefined,
          };
    const body = await c.req.json<KeySuccessionRecord>();

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
        throw new HTTPException(400, { message: "Guardian recovery requires guardian_signature" });
      }
      // Look up the guardian public key from agent's identity
      const agentGuardian = moteDb.db
        .prepare("SELECT guardian_public_key FROM agent_registry WHERE motebit_id = ?")
        .get(motebitId) as { guardian_public_key: string | null } | undefined;
      const guardianPubKey = agentGuardian?.guardian_public_key;
      if (!guardianPubKey) {
        throw new HTTPException(400, {
          message: "Agent has no guardian registered — cannot use guardian recovery",
        });
      }
      const valid = await verifyKeySuccession(body, guardianPubKey);
      if (!valid) throw new HTTPException(400, { message: "Invalid guardian recovery signatures" });
    } else {
      // Normal rotation: need old_key_signature
      if (!body.old_key_signature) {
        throw new HTTPException(400, { message: "Normal rotation requires old_key_signature" });
      }
      const valid = await verifyKeySuccession(body);
      if (!valid) throw new HTTPException(400, { message: "Invalid key succession signatures" });
    }

    // The record must depart from the identity's key AS THIS RELAY CAN
    // PROVE IT — not from any key some device row happens to hold: a
    // device linked without key transfer holds one that is not the
    // identity's, and its succession is not the identity's history.
    if ((await provableIdentityKey(moteDb.db, motebitId, body.old_public_key)) == null) {
      refuse(
        400,
        "SUCCESSION_NOT_FROM_IDENTITY_KEY",
        "Succession old_public_key does not match stored public key: it is not this identity's key as far as this relay can prove",
      );
    }

    // Last await is behind us. From here to the commit is one tick: the
    // key this caller PROVED must still be a credential (a request can be
    // held open across someone else's rotation) …
    if (firstPerson != null && !callerIsStillCurrent(moteDb.db, motebitId, firstPerson)) {
      refuse(
        401,
        "CALLER_KEY_NOT_CURRENT",
        "the key this token was verified under is no longer a credential for this identity",
      );
    }
    // … and the record must still depart from the CURRENT key, re-checked
    // inside the transaction that writes it.
    const landed = recordSuccession(moteDb.db, connections, motebitId, body, () => {
      moteDb.db
        .prepare(`UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?`)
        .run(body.new_public_key, motebitId);
    });
    if (!landed) {
      refuse(
        409,
        "SUCCESSION_RACED",
        "Succession old_public_key does not match stored public key: another rotation landed first",
      );
    }

    return c.json({ ok: true, motebit_id: motebitId });
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
