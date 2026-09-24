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
import { applySuccession, departureFrom, keyOnFile, successionAtHead } from "./succession-apply.js";
import { readSuccessionChain } from "./identity-transparency.js";
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
    // Is this link the HEAD of the chain this relay already recorded? Then
    // this is a retry — a lost response, a timeout after commit — of a
    // record the relay already accepted once, and two rules below do not
    // apply to it: freshness (the relay judged this exact timestamp when it
    // first recorded the link; refusing the retry as "too old" tells a
    // client its rotation failed when it succeeded) and key-on-file (the key
    // it departs from has by definition moved on). Head, not "any earlier
    // row with these keys": a rotation back to a previously used key is a
    // NEW link and must append, or the served chain stops at a key the
    // registry has left. `applySuccession` is idempotent and scoped to the
    // retired key, so both doors and every retry converge on one state —
    // #710's "fully applied" precheck, which had to reproduce the law to
    // decide whether to run the law, is gone with the state it modelled.
    const held = successionAtHead(moteDb.db, motebitId, body);

    if (!held) {
      // Timestamp freshness: a NEW link must be recent — older than 15
      // minutes or in the future is refused. A held link already passed this
      // once.
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
    }

    // Precedence, most authoritative first. Comparison is EXACT: these
    // keys are covered by the signature, and a record stored in a spelling
    // that differs from the one signed breaks `verifySuccessionChain`'s
    // linkage on the public surfaces this rule exists to protect.
    if (!held) {
      // The ONE precedence rule, shared with the public succession route so
      // a client's read and this refusal can never disagree.
      const departure = departureFrom(moteDb.db, motebitId, body.old_public_key);
      if (!departure.admissible) {
        const messages = {
          not_from_current_key: "Succession old_public_key does not match stored public key",
          not_from_chain_head:
            "Succession old_public_key does not match the head of this identity's recorded chain",
          no_key_on_file:
            "Succession old_public_key is not a key this relay holds for this identity",
        } as const;
        throw refuse(
          400,
          departure.reason === "no_key_on_file" ? "no_key_on_file" : "not_from_current_key",
          messages[departure.reason],
        );
      }
    }

    const { applied } = applySuccession(moteDb.db, motebitId, body);

    if (applied) {
      // The old key ceased to be authoritative at the rotation moment, not
      // when this relay processed the request — anchor the memo at the
      // record's timestamp so a verifier's poison window matches the chain.
      // Same event the register door emits; a retry appended nothing and
      // emits nothing. Best-effort, as there.
      try {
        await insertRevocationEvent(moteDb.db, relayIdentity, "key_rotated", motebitId, {
          newPublicKey: body.new_public_key,
          revokedPublicKey: body.old_public_key,
          effectiveAt: body.timestamp,
        });
      } catch {
        /* best-effort */
      }
    }

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

    // ONE reader of the served chain, shared with the identity bundle
    // (`identity-transparency.ts`): it stamps the `suite` the verifier
    // demands fail-closed and omits a null `reason` — the signed payload has
    // no `reason` key when none was given, so serving `reason: null` changes
    // the canonical bytes and every signature fails. This route used to
    // build its own rows without either, so the chain the client design
    // READS to classify the relay was unverifiable as served.
    const chain = readSuccessionChain(moteDb.db, motebitId);

    // What the relay HOLDS and whether a rotation may depart from a given
    // key, answered by the same function /rotate-key enforces. A client
    // reads this before minting anything; re-deriving it from the chain
    // and registry alone cannot see device rows and inverts the precedence.
    const onFile = keyOnFile(moteDb.db, motebitId);
    const from = c.req.query("from");
    const departable =
      from != null && /^[0-9a-f]{64}$/i.test(from)
        ? departureFrom(moteDb.db, motebitId, from).admissible
        : null;

    const agent = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { public_key: string } | undefined;

    logger.info("agent.succession.query", { correlationId, motebitId, chainLength: chain.length });

    return c.json({
      motebit_id: motebitId,
      chain,
      current_public_key: agent?.public_key ?? null,
      held_public_key: onFile.held,
      ...(from != null ? { departable_from: from, departable } : {}),
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
    // Revocation also DELISTS (identity-key-state-v1 §10 Q1): a revoked
    // identity cannot act, so it must not be for hire; one statement, one
    // audit site. The row itself stays — the identity log keeps the
    // binding and its end for verifiers walking old receipt chains.
    // The SET clause is written out here, not imported: the writers gate
    // reads statement text, and an authority write hidden in a constant is
    // an authority write the gate cannot see.
    moteDb.db
      .prepare(
        "UPDATE agent_registry SET revoked = 1, delisted_at = COALESCE(delisted_at, ?), endpoint_url = '', capabilities = '[]' WHERE motebit_id = ?",
      )
      .run(Date.now(), motebitId);
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
