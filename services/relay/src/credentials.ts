/**
 * Credential issuance, verification, presentation, and revocation endpoints.
 *
 * Extracted from index.ts — pure refactor, zero behavior changes.
 */

import { HTTPException } from "hono/http-exception";
import {
  hexPublicKeyToDidKey,
  publicKeyToDidKey,
  issueReputationCredential,
  verifyVerifiableCredential,
  createPresentation,
  canonicalJson,
} from "@motebit/encryption";
import type { VerifiableCredential } from "@motebit/encryption";
import { asMotebitId, AgentTrustLevel } from "@motebit/sdk";
import type { AgentTrustRecord } from "@motebit/sdk";
import { computeServiceReputation } from "@motebit/market";
import type { ReputationSample } from "@motebit/market";
import type { DatabaseDriver } from "@motebit/persistence";
import type { IdentityManager } from "@motebit/core-identity";
import type { Hono } from "hono";
import type { RelayIdentity } from "./federation.js";
import { insertRevocationEvent } from "./federation.js";
import {
  bindCredentialSubject,
  didKeyProvenFor,
  unwrapBound,
  type BoundIdentity,
} from "./identity-binding.js";
import type { AuthEvent } from "./auth-events.js";
import { createLogger } from "./logger.js";
import { holderKeyOf, servedIdentityKey } from "./identity-keys.js";

const logger = createLogger({ service: "credentials" });

export interface CredentialDeps {
  db: DatabaseDriver;
  app: Hono;
  relayIdentity: RelayIdentity;
  identityManager: IdentityManager;
  /** When true, relay issues reputation credentials on demand. Default: false (peer-issued). */
  issueCredentials?: boolean;
  /**
   * Durable auth-event record (auth-events.ts) for a submission whose
   * credential names another identity (relay rule 6, #850). Required: a
   * refusal stops being recorded the day a refactor drops an optional one.
   */
  recordAuthEvent: (event: AuthEvent) => void;
}

/** Returns the relay's persistent keypair for credential signing. */
export function getRelayKeypair(relayIdentity: RelayIdentity): {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
} {
  return {
    publicKey: relayIdentity.publicKey,
    privateKey: relayIdentity.privateKey,
  };
}

/**
 * File a submitted credential under its bound subject (#850). `owner` is the
 * identity `bindCredentialSubject` proved the credential is about; it is
 * read only through `unwrapBound`. Idempotent: `true` when the row is new or
 * is this exact credential under this owner already; `false` when the
 * `credential_id` is held by a different credential or another identity —
 * the caller refuses it rather than report a silent no-op as accepted.
 */
export function insertSubmittedCredential(
  db: DatabaseDriver,
  owner: BoundIdentity,
  row: { credentialId: string; issuerDid: string; credentialType: string; credentialJson: string },
): boolean {
  const subject = unwrapBound(owner);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO relay_credentials
       (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.credentialId,
      subject,
      row.issuerDid,
      row.credentialType,
      row.credentialJson,
      Date.now(),
    );
  if (result.changes > 0) return true;
  const held = db
    .prepare(
      "SELECT subject_motebit_id, credential_json FROM relay_credentials WHERE credential_id = ?",
    )
    .get(row.credentialId) as { subject_motebit_id: string; credential_json: string } | undefined;
  // The SAME credential re-submitted is idempotent even when its keys arrive
  // in another order (spec §7.1 step 6): compare the JCS canonical forms, not
  // the stored bytes.
  if (held === undefined || held.subject_motebit_id !== subject) return false;
  try {
    return (
      canonicalJson(JSON.parse(held.credential_json)) ===
      canonicalJson(JSON.parse(row.credentialJson))
    );
  } catch {
    return false;
  }
}

/** Register all credential endpoints on the Hono app. */
export function registerCredentialRoutes(deps: CredentialDeps): void {
  const { db, app, relayIdentity, issueCredentials = false, recordAuthEvent } = deps;

  // POST /api/v1/credentials/:motebitId/reputation — compute reputation, issue VC
  // Only available when relay credential issuance is enabled.
  /** @spec motebit/credential@1.0 */
  app.post("/api/v1/credentials/:motebitId/reputation", async (c) => {
    if (!issueCredentials) {
      return c.json(
        { error: "Relay credential issuance is disabled. Reputation credentials are peer-issued." },
        403,
      );
    }
    const motebitId = asMotebitId(c.req.param("motebitId"));

    // Build receipts from settlement records for computeServiceReputation
    const settlements = db
      .prepare(
        `SELECT task_id, motebit_id, status, settled_at FROM relay_settlements
         WHERE motebit_id = ?
         ORDER BY settled_at DESC LIMIT 1000`,
      )
      .all(motebitId) as Array<{
      task_id: string;
      motebit_id: string;
      status: string;
      settled_at: number;
    }>;

    if (settlements.length === 0) {
      return c.json({ error: "No task history for this agent" }, 404);
    }

    // Query latency stats for duration data
    const latencies = db
      .prepare(
        `SELECT latency_ms, recorded_at FROM relay_latency_stats
         WHERE remote_motebit_id = ?
         ORDER BY recorded_at DESC LIMIT 1000`,
      )
      .all(motebitId) as Array<{ latency_ms: number; recorded_at: number }>;

    // Project the minimal reputation-input shape directly from
    // settlements + latency. Pre-refactor, this site synthesized full
    // ExecutionReceipt objects with 10 fake/sentinel fields (including
    // `device_id: "" as unknown as DeviceId`) just to satisfy the old
    // wider parameter type — a category error the new `ReputationSample`
    // shape eliminates. Take what the algorithm consumes, nothing more.
    const samples: ReputationSample[] = settlements.map((s, i) => ({
      submitted_at: s.settled_at - (latencies[i]?.latency_ms ?? 5000),
      completed_at: s.settled_at,
      status: s.status as "completed" | "failed" | "denied",
    }));

    // Query trust record
    const trustRow = db
      .prepare(
        "SELECT * FROM agent_trust WHERE remote_motebit_id = ? ORDER BY last_seen_at DESC LIMIT 1",
      )
      .get(motebitId) as Record<string, unknown> | undefined;
    const trustRecord: AgentTrustRecord | null = trustRow
      ? {
          motebit_id: asMotebitId(trustRow.motebit_id as string),
          remote_motebit_id: asMotebitId(trustRow.remote_motebit_id as string),
          trust_level: trustRow.trust_level as AgentTrustLevel,
          first_seen_at: trustRow.first_seen_at as number,
          last_seen_at: trustRow.last_seen_at as number,
          interaction_count: trustRow.interaction_count as number,
          successful_tasks: (trustRow.successful_tasks as number | null) ?? 0,
          failed_tasks: (trustRow.failed_tasks as number | null) ?? 0,
        }
      : null;

    // Compute reputation using the market package's proper algorithm
    // (Beta-binomial prior, coefficient-of-variation consistency, exponential recency decay)
    const reputation = computeServiceReputation(motebitId, samples, trustRecord);

    // The subject is named by evidence only (#875 review): the identity's
    // served key (`servedIdentityKey` — holder, else a key the id commits to)
    // as `did:key`, else `did:motebit:<id>`. Never a device row —
    // `/pairing/claim` writes any key unsigned, and `devices[0]` let X make
    // the relay issue X's reputation about V's key.
    const servedKey = await servedIdentityKey(db, motebitId);
    const subjectDid =
      servedKey !== null ? hexPublicKeyToDidKey(servedKey) : `did:motebit:${motebitId}`;

    const relayKeys = getRelayKeypair(relayIdentity);
    const avgLatency =
      latencies.length > 0 ? latencies.reduce((a, b) => a + b.latency_ms, 0) / latencies.length : 0;
    const vc = await issueReputationCredential(
      {
        success_rate: reputation.sub_scores.reliability,
        avg_latency_ms: avgLatency,
        task_count: reputation.sample_size,
        trust_score: reputation.composite,
        availability: reputation.sub_scores.recency,
        measured_at: reputation.timestamp,
      },
      relayKeys.privateKey,
      relayKeys.publicKey,
      subjectDid,
    );

    return c.json({
      credential: vc,
      relay_did: publicKeyToDidKey(relayKeys.publicKey),
    });
  });

  // POST /api/v1/credentials/verify — verify a VerifiableCredential (public)
  /** @spec motebit/credential@1.0 */
  app.post("/api/v1/credentials/verify", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
    const vc = body as VerifiableCredential;
    if (
      vc == null ||
      !Array.isArray(vc["@context"]) ||
      !Array.isArray(vc.type) ||
      vc.issuer == null ||
      vc.credentialSubject == null ||
      vc.proof == null
    ) {
      throw new HTTPException(400, {
        message:
          "Invalid credential: missing required fields (@context, type, issuer, credentialSubject, proof)",
      });
    }

    const valid = await verifyVerifiableCredential(vc);
    return c.json({
      valid,
      issuer: vc.issuer,
      subject: vc.credentialSubject.id,
    });
  });

  // POST /api/v1/agents/:motebitId/revoke-credential — revoke a verifiable credential
  // Allowed when caller is the subject OR the issuer of the credential.
  /** @spec motebit/credential@1.0 */
  app.post("/api/v1/agents/:motebitId/revoke-credential", async (c) => {
    const motebitId = c.req.param("motebitId");
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;

    const body = await c.req.json<{ credential_id: string; reason?: string }>();
    if (!body.credential_id) {
      throw new HTTPException(400, { message: "credential_id is required" });
    }

    // The credential decides who may revoke it, so it is resolved BEFORE any
    // authorization question is asked. The previous shape asked whether the
    // caller matched `:motebitId` — a value the CALLER supplies — and never
    // compared the named credential to it, so naming yourself in the path
    // authorized you over anyone's credential. Authority has to bind to the
    // object being acted on, not to a parameter of the request.
    const credRow = db
      .prepare(
        "SELECT subject_motebit_id, issuer_did FROM relay_credentials WHERE credential_id = ?",
      )
      .get(body.credential_id) as { subject_motebit_id: string; issuer_did: string } | undefined;

    // A master-token caller is the operator (no `callerMotebitId` is set by
    // the device-auth middleware). The operator may still name a credential
    // this relay does not hold — that is a blocklist, it predates this change
    // and is exercised (`revocation.test.ts`), and it is bounded by holding
    // the operator token. An AGENT may not: with no row there is no subject
    // and no issuer, so there is nobody the caller could be, and permitting
    // it is what let an identifier be denied before it was ever issued.
    const isOperator = callerMotebitId === undefined;
    if (credRow === undefined && !isOperator) {
      throw new HTTPException(404, { message: "Credential not found" });
    }

    // The path segment names the credential's holder. Keeping it consistent
    // with the credential keeps the route's own meaning honest; it is not
    // what authorizes, and it is checked after existence so a mismatch and a
    // miss are the same answer.
    if (credRow !== undefined && credRow.subject_motebit_id !== motebitId) {
      throw new HTTPException(404, { message: "Credential not found for this agent" });
    }

    let isSubject = isOperator;
    let isIssuer = false;
    if (!isOperator && credRow !== undefined) {
      isSubject = callerMotebitId === credRow.subject_motebit_id;
      if (!isSubject) {
        // The caller is the issuer when the issuer's `did:key` is a key THIS
        // request proves the caller holds: the key its bearer verified under
        // (`callerVerifiedKey`, set by the agent-route middleware), or the
        // caller's proven holder key. Never "any device row of the caller"
        // (#875 review): `/pairing/claim` writes any key unsigned, so X could
        // pair itself claiming V's key and then revoke every credential V
        // issued, relay-wide.
        const verifiedKey = c.get("callerVerifiedKey" as never) as string | undefined;
        const callerHolder = holderKeyOf(db, callerMotebitId);
        isIssuer = [verifiedKey, callerHolder].some(
          (k) => k != null && k !== "" && hexPublicKeyToDidKey(k) === credRow.issuer_did,
        );
      }
    }

    if (!isSubject && !isIssuer) {
      throw new HTTPException(403, { message: "Only the credential subject or issuer can revoke" });
    }

    // Attribute the row to the credential's actual holder. It used to record
    // the path segment, so a revocation written by someone else was filed
    // under whatever identity the request named.
    const subjectId = credRow?.subject_motebit_id ?? motebitId;
    const revokedBy = callerMotebitId ?? subjectId;
    db.prepare(
      "INSERT OR REPLACE INTO relay_revoked_credentials (credential_id, motebit_id, reason, revoked_by) VALUES (?, ?, ?, ?)",
    ).run(body.credential_id, subjectId, body.reason ?? null, revokedBy);

    // Emit revocation event for federation propagation
    try {
      await insertRevocationEvent(db, relayIdentity, "credential_revoked", subjectId, {
        credentialId: body.credential_id,
      });
    } catch {
      /* best-effort — revocation still succeeded locally */
    }

    return c.json({ ok: true, credential_id: body.credential_id });
  });

  // POST /api/v1/credentials/batch-status — batch credential revocation status check
  /** @spec motebit/credential@1.0 */
  app.post("/api/v1/credentials/batch-status", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
    const { credential_ids } = body as { credential_ids?: string[] };
    if (!Array.isArray(credential_ids) || credential_ids.length === 0) {
      throw new HTTPException(400, { message: "credential_ids array is required" });
    }
    if (credential_ids.length > 100) {
      throw new HTTPException(400, { message: "Maximum 100 credential_ids per request" });
    }

    const placeholders = credential_ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT credential_id, revoked_at, reason FROM relay_revoked_credentials WHERE credential_id IN (${placeholders})`,
      )
      .all(...credential_ids) as Array<{
      credential_id: string;
      revoked_at: string;
      reason: string | null;
    }>;

    const revokedMap = new Map(rows.map((r) => [r.credential_id, r]));
    const results = credential_ids.map((id) => {
      const row = revokedMap.get(id);
      return row
        ? { credential_id: id, revoked: true, revoked_at: row.revoked_at, reason: row.reason ?? "" }
        : { credential_id: id, revoked: false };
    });

    return c.json({ results });
  });

  // GET /api/v1/credentials/:credentialId/status — public credential revocation status
  /** @spec motebit/credential@1.0 */
  app.get("/api/v1/credentials/:credentialId/status", (c) => {
    const credentialId = c.req.param("credentialId");
    const row = db
      .prepare("SELECT revoked_at, reason FROM relay_revoked_credentials WHERE credential_id = ?")
      .get(credentialId) as { revoked_at: string; reason: string | null } | undefined;
    if (!row) {
      return c.json({ revoked: false });
    }
    return c.json({ revoked: true, revoked_at: row.revoked_at, reason: row.reason ?? "" });
  });

  // GET /api/v1/agents/:motebitId/credentials — list credentials issued to/by agent
  /** @spec motebit/credential@1.0 */
  app.get("/api/v1/agents/:motebitId/credentials", (c) => {
    const mid = asMotebitId(c.req.param("motebitId"));
    // Owner-private (2026-07-07): an agent's credentials are its own. The
    // `/api/v1/agents/*` middleware verified a `credentials`-audience device
    // token and set callerMotebitId; enforce caller===:motebitId here (the
    // operator master token leaves callerMotebitId undefined = allowed).
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId !== undefined && callerMotebitId !== mid) {
      throw new HTTPException(403, { message: "Cannot read another agent's credentials" });
    }
    const typeFilter = c.req.query("type");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);

    let rows: Array<{
      credential_id: string;
      credential_type: string;
      credential_json: string;
      issued_at: number;
    }>;
    if (typeFilter) {
      rows = db
        .prepare(
          "SELECT credential_id, credential_type, credential_json, issued_at FROM relay_credentials WHERE subject_motebit_id = ? AND credential_type = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(mid, typeFilter, limit) as typeof rows;
    } else {
      rows = db
        .prepare(
          "SELECT credential_id, credential_type, credential_json, issued_at FROM relay_credentials WHERE subject_motebit_id = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(mid, limit) as typeof rows;
    }

    const credentials = rows.map((r) => ({
      credential_id: r.credential_id,
      credential_type: r.credential_type,
      credential: JSON.parse(r.credential_json) as VerifiableCredential,
      issued_at: r.issued_at,
    }));

    return c.json({ motebit_id: mid, credentials });
  });

  // POST /api/v1/agents/:motebitId/presentation — bundle credentials into a signed VP
  /** @spec motebit/credential@1.0 */
  app.post("/api/v1/agents/:motebitId/presentation", async (c) => {
    const mid = asMotebitId(c.req.param("motebitId"));
    // Owner-private (2026-07-07): a Verifiable Presentation exposes the
    // agent's own credentials — leaving it public would defeat the
    // credentials-GET privacy above. `credentials:present`-audience device
    // token; caller===:motebitId (master token = operator-allowed).
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId !== undefined && callerMotebitId !== mid) {
      throw new HTTPException(403, { message: "Cannot present another agent's credentials" });
    }
    const typeFilter = c.req.query("type");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);

    let rows: Array<{
      credential_json: string;
    }>;
    if (typeFilter) {
      rows = db
        .prepare(
          "SELECT credential_json FROM relay_credentials WHERE subject_motebit_id = ? AND credential_type = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(mid, typeFilter, limit) as typeof rows;
    } else {
      rows = db
        .prepare(
          "SELECT credential_json FROM relay_credentials WHERE subject_motebit_id = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(mid, limit) as typeof rows;
    }

    if (rows.length === 0) {
      throw new HTTPException(404, { message: "No credentials found for this agent" });
    }

    const credentials = rows.map((r) => JSON.parse(r.credential_json) as VerifiableCredential);

    const relayKeys = getRelayKeypair(relayIdentity);
    const vp = await createPresentation(credentials, relayKeys.privateKey, relayKeys.publicKey);

    return c.json({
      presentation: vp,
      credential_count: credentials.length,
      relay_did: publicKeyToDidKey(relayKeys.publicKey),
    });
  });

  // POST /api/v1/agents/:motebitId/credentials/submit — peer submits collected credentials for relay indexing.
  // This is the pipe between peer-issued credentials and relay routing. Peers earn credentials
  // from other peers via direct interaction; they submit them here so the relay can factor them
  // into routing decisions via aggregateCredentialReputation(). The relay does NOT issue these —
  // it indexes what peers produce.
  //
  // Each credential is verified (Ed25519 signature check) before storage. Self-issued credentials
  // (issued by a key the subject identity itself holds) are rejected — they carry no trust signal.
  //
  // The row is filed under the path identity, and `revoke-credential` reads that row's subject as
  // the identity allowed to revoke it (spec/credential-v1.md §6.2). So the path identity must be
  // the one the credential's OWN `credentialSubject.id` names (`bindCredentialSubject`, #850) —
  // before, X filed V's credential under X and then revoked it, relay-wide, as its "subject".
  /** @spec motebit/credential@1.0 */
  app.post("/api/v1/agents/:motebitId/credentials/submit", async (c) => {
    const motebitId = c.req.param("motebitId");

    // Any party may SUBMIT (the route is public — the issuer's signature is the auth; the
    // issuing agent submits credentials about agents it delegated to). What is bound is the
    // TARGET: each credential is filed only under the identity its own subject names.

    const body = await c.req.json<{ credentials: VerifiableCredential[] }>();
    if (!Array.isArray(body.credentials) || body.credentials.length === 0) {
      throw new HTTPException(400, {
        message: "credentials array is required and must be non-empty",
      });
    }
    if (body.credentials.length > 50) {
      throw new HTTPException(400, { message: "Maximum 50 credentials per submission" });
    }

    let accepted = 0;
    let rejected = 0;
    const errors: string[] = [];
    const refuse = (error: string, reason: string, credentialId?: string): void => {
      rejected++;
      errors.push(error);
      // Rule 6: a refusal is logged as loudly as an acceptance.
      logger.warn("credential.submit.refused", {
        motebitId,
        reason,
        credentialId: credentialId ?? null,
        correlationId: c.req.header("x-correlation-id") ?? null,
      });
    };

    for (const vc of body.credentials) {
      // Basic shape check
      if (
        vc == null ||
        !Array.isArray(vc["@context"]) ||
        !Array.isArray(vc.type) ||
        vc.issuer == null ||
        vc.credentialSubject == null ||
        vc.proof == null
      ) {
        refuse("invalid credential shape", "invalid_shape");
        continue;
      }

      const subjectId =
        typeof vc.credentialSubject === "object" && "id" in vc.credentialSubject
          ? (vc.credentialSubject as { id: unknown }).id
          : undefined;
      const issuerDid = typeof vc.issuer === "string" ? vc.issuer : "";

      // Self-attestation rejection: issuer === subject carries no trust signal. Compared by
      // IDENTITY as well as by DID string: the `did:key` of V's own key issuing about
      // `did:motebit:V` is the same party under two spellings.
      if (
        (typeof subjectId === "string" && issuerDid === subjectId) ||
        (issuerDid.startsWith("did:key:") && (await didKeyProvenFor(db, issuerDid, motebitId)))
      ) {
        refuse("self-issued credential rejected", "self_issued");
        continue;
      }

      // Verify Ed25519 signature — don't index unverified credentials
      const valid = await verifyVerifiableCredential(vc);
      if (!valid) {
        refuse("signature verification failed", "signature_invalid");
        continue;
      }

      // The target: the path identity must be the identity this credential is ABOUT.
      const binding = await bindCredentialSubject(db, subjectId, motebitId);
      if ("refused" in binding) {
        // The reason code rides in the body so a best-effort submitter (the
        // runtime logs `errors`) can see WHY, not just that it was refused.
        refuse(`credential subject is not this identity (${binding.refused})`, binding.refused);
        // Rule 6: recorded durably. The route takes no token, so there is no
        // presenter (null); the target is in `path`.
        recordAuthEvent({
          kind: "agent_token_rejected",
          method: c.req.method,
          path: c.req.path,
          motebitId: null,
          audience: null,
          reason: binding.refused,
          correlationId: c.req.header("x-correlation-id") ?? null,
        });
        continue;
      }

      // Check for revocation
      const vcAny = vc as unknown as Record<string, unknown>;
      const credId = typeof vcAny.id === "string" ? vcAny.id : `submitted-${crypto.randomUUID()}`;
      const revokedRow = db
        .prepare("SELECT 1 FROM relay_revoked_credentials WHERE credential_id = ?")
        .get(credId);
      if (revokedRow != null) {
        refuse("credential is revoked", "revoked", credId);
        continue;
      }

      // Determine credential type
      const credType = vc.type.find((t: string) => t !== "VerifiableCredential") ?? "Unknown";

      try {
        const stored = insertSubmittedCredential(db, binding.bound, {
          credentialId: credId,
          issuerDid,
          credentialType: credType,
          credentialJson: JSON.stringify(vc),
        });
        if (!stored) {
          refuse("credential_id is already held by a different credential", "id_conflict", credId);
          continue;
        }
        accepted++;
        logger.info("credential.submit.recorded", { motebitId, credentialId: credId });
      } catch {
        refuse("storage error", "storage_error", credId);
      }
    }

    return c.json({ accepted, rejected, errors: errors.length > 0 ? errors : undefined });
  });
}
